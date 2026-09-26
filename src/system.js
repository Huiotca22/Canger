'use strict';

const os = require('os');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const UNSAFE_PATH_RE = /[\u0000\r\n"`]/;
const WINDOWS_SHELL_RE = /[;&|<>]/;

function pathIsSafe(value) {
  return typeof value === 'string' && value.length > 0 && !UNSAFE_PATH_RE.test(value);
}

function isWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative)
  );
}

function validateExecutable(candidate, { names = null, allowSymlink = false } = {}) {
  if (!pathIsSafe(candidate) || !path.isAbsolute(candidate)) return null;
  if (candidate.split(/[\\/]+/).some(part => part === '..')) return null;
  const resolved = path.resolve(candidate);
  if (UNSAFE_PATH_RE.test(resolved)) return null;

  let st;
  try {
    st = fs.lstatSync(resolved);
    if (st.isSymbolicLink() && !allowSymlink) return null;
    if (!st.isFile()) return null;
    if (names && names.length) {
      const base = path.basename(resolved).toLowerCase();
      if (!names.some(name => base === String(name).toLowerCase())) return null;
    }
    if (process.platform !== 'win32') fs.accessSync(resolved, fs.constants.X_OK);
  } catch (_) {
    return null;
  }
  if (!allowSymlink) {
    const root = path.parse(resolved).root;
    let current = root;
    const relative = path.relative(root, resolved);
    for (const part of relative ? relative.split(path.sep) : []) {
      current = path.join(current, part);
      try {
        const component = fs.lstatSync(current);
        if (component.isSymbolicLink()) return null;
      } catch (_) {
        return null;
      }
    }
  }
  return resolved;
}

function getWindowsSystemRoot() {
  if (process.platform !== 'win32') return null;
  const raw = process.env.SystemRoot || 'C:\\Windows';
  if (!pathIsSafe(raw) || WINDOWS_SHELL_RE.test(raw)) return null;
  if (!/^[A-Za-z]:[\\/]/.test(raw)) return null;
  const rawParts = raw.slice(3).split(/[\\/]+/);
  if (rawParts.some(part => part === '..' || part === '.')) return null;
  const normalized = path.win32.normalize(raw);
  if (!/^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith('\\\\')) return null;
  const parts = normalized.slice(3).split(/[\\/]+/);
  if (normalized.slice(2).includes(':') || parts.some(part => part === '..' || part === '.' || /[. ]$/.test(part))) return null;
  const resolved = path.resolve(normalized);
  try {
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch (_) {
    return null;
  }
  return resolved;
}

function findSystemExecutable(candidates, options = {}) {
  if (!Array.isArray(candidates)) return null;
  const root = getWindowsSystemRoot();
  if (process.platform === 'win32' && !root) return null;
  for (const candidate of candidates) {
    if (!pathIsSafe(candidate) || candidate.split(/[\\/]+/).some(part => part === '..')) continue;
    const full = process.platform === 'win32' && !path.isAbsolute(candidate) && root
      ? path.join(root, candidate)
      : candidate;
    const validated = validateExecutable(full, options);
    if (!validated) continue;
    if (process.platform === 'win32' && root && !isWithin(root, validated)) continue;
    return validated;
  }
  return null;
}

function runSystemExecutable(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    timeout: options.timeout || 3000,
    maxBuffer: options.maxBuffer || 1024 * 1024,
  });
}

function totalRamMb() {
  return Math.floor(os.totalmem() / 1024 / 1024);
}

function freeRamMb() {
  return Math.floor(os.freemem() / 1024 / 1024);
}

function cpuInfo() {
  const cpus = os.cpus() || [];
  return {
    model: cpus[0] ? cpus[0].model.trim() : 'Unknown CPU',
    cores: cpus.length || 2,
    physicalCores: physicalCoreCount(),
    arch: os.arch(),
    speedMhz: cpus[0] ? cpus[0].speed : 0,
  };
}

function physicalCoreCount() {
  try {
    if (process.platform === 'win32') {
      const wmicPath = findSystemExecutable(['System32/wmic.exe'], { names: ['wmic.exe'] });
      if (!wmicPath) return os.cpus().length || 2;
      const out = runSystemExecutable(wmicPath, ['cpu', 'get', 'NumberOfCores', '/value']);
      const m = out.match(/NumberOfCores\s*=\s*(\d+)/i);
      if (m) {
        const count = parseInt(m[1], 10);
        if (Number.isInteger(count) && count > 0) return count;
      }
    } else if (process.platform === 'darwin') {
      const sysctl = findSystemExecutable(['/usr/sbin/sysctl', '/bin/sysctl'], { names: ['sysctl'] });
      if (!sysctl) return os.cpus().length || 2;
      const out = runSystemExecutable(sysctl, ['-n', 'hw.physicalcpu']);
      const count = parseInt(out.trim(), 10);
      if (Number.isInteger(count) && count > 0) return count;
    } else {
      try {
        const txt = fs.readFileSync('/proc/cpuinfo', 'utf8');
        const ids = new Set();
        for (const line of txt.split('\n')) {
          const m = line.match(/^core id\s*:\s*(\d+)/);
          if (m) ids.add(m[1]);
        }
        if (ids.size > 0) return ids.size;
      } catch (_) { }
    }
  } catch (_) { }
  return os.cpus().length || 2;
}

function gpuInfo() {
  try {
    if (process.platform === 'win32') {
      const wmicPath = findSystemExecutable(['System32/wmic.exe'], { names: ['wmic.exe'] });
      if (!wmicPath) return { name: 'Unknown GPU', discrete: false };
      const out = runSystemExecutable(wmicPath, ['path', 'win32_VideoController', 'get', 'name,AdapterRAM', '/value']);
      const names = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^Name\s*=\s*(.+)\s*$/i);
        if (m && m[1].trim()) names.push(m[1].trim());
      }
      return { name: names.join(' + ') || 'Unknown GPU', discrete: looksDiscrete(names.join(' ')), weak: looksWeakDiscrete(names.join(' ')) };
    }
    if (process.platform === 'linux') {
      const lspci = findSystemExecutable(['/usr/bin/lspci', '/bin/lspci'], { names: ['lspci'] });
      if (!lspci) return { name: 'Unknown GPU', discrete: false };
      const out = runSystemExecutable(lspci, ['-mm']);
      const matches = out.split('\n').filter(line => /\b(vga compatible controller|3d controller|display controller)\b/i.test(line));
      const name = (matches[0] || '').replace(/^.*:\s*/, '').trim();
      return { name: name || 'Unknown GPU', discrete: looksDiscrete(name), weak: looksWeakDiscrete(name) };
    }
  } catch (_) { }
  return { name: 'Unknown GPU', discrete: false };
}

function looksDiscrete(s) {
  s = (s || '').toLowerCase();
  if (!s) return false;
  if (/intel.*(hd|uhd|iris)/.test(s) && !/arc/.test(s)) return false;
  if (/vega\s*[37]/.test(s) || /radeon.*vega/.test(s)) return false;
  if (/nvidia|geforce|radeon rx|arc a/.test(s)) return true;
  return false;
}

function looksWeakDiscrete(s) {
  s = (s || '').toLowerCase();
  if (!s) return false;
  if (/\bgt\s?\d{3}\b/.test(s)) return true;
  if (/radeon\s*hd\s?\d{4}/.test(s)) return true;
  if (/geforce\s*(210|310|405|610|620|630|640|720|730)/.test(s)) return true;
  if (/hd graphics|uhd graphics/.test(s)) return true;
  return false;
}

function isWeakCpu(model, logical) {
  const m = (model || '').toLowerCase();
  if (logical <= 4) {
    if (/i3-3|i3-4|pentium|celeron|atom|a4|a6|e2/.test(m)) return true;
  }
  return logical <= 2;
}

function scoreSystem(info) {
  info = info || getSystemInfo();
  let score = 0;
  score += Math.min(36, info.cpu.cores * 4 + (info.cpu.speedMhz > 3000 ? 8 : info.cpu.speedMhz > 2000 ? 4 : 0));
  if (info.ramTotalMb >= 16000) score += 16;
  else if (info.ramTotalMb >= 8000) score += 13;
  else if (info.ramTotalMb >= 4000) score += 8;
  else score += 3;
  if (info.gpu.discrete && !info.gpu.weak) score += 22;
  else if (info.gpu.discrete && info.gpu.weak) score += 8;
  else score += 6;
  if (isWeakCpu(info.cpu.model, info.cpu.cores)) score -= 25;
  return Math.max(0, Math.min(100, score));
}

function recommendProfile(info) {
  const score = scoreSystem(info);
  if (score < 35) return 'potato';
  if (score < 60) return 'balanced';
  if (score < 80) return 'performance';
  return 'maxfps';
}

function getSystemInfo() {
  const cpu = cpuInfo();
  const gpu = gpuInfo();
  const ramTotalMb = totalRamMb();
  const info = {
    platform: process.platform,
    cpu,
    gpu,
    ramTotalMb,
    ramFreeMb: freeRamMb(),
    weakCpu: isWeakCpu(cpu.model, cpu.cores),
  };
  info.score = scoreSystem(info);
  info.recommendedProfile = recommendProfile(info);
  return info;
}

function recommendRam({ totalMb, modded = false, profile } = {}) {
  totalMb = totalMb || totalRamMb();
  let want;
  if (profile === 'potato') want = modded ? 3072 : 2048;
  else if (profile === 'balanced') want = modded ? 4096 : 3072;
  else if (profile === 'performance') want = modded ? 5120 : 4096;
  else want = modded ? 6144 : 4096;

  const maxSafe = totalMb - 2048;
  const maxHalf = Math.floor(totalMb * 0.6);
  want = Math.min(want, maxSafe, maxHalf);
  want = Math.max(1024, Math.floor(want / 256) * 256);
  return want;
}

module.exports = {
  getSystemInfo,
  scoreSystem,
  recommendProfile,
  recommendRam,
  totalRamMb,
  getWindowsSystemRoot,
  findSystemExecutable,
  validateExecutable,
};
