'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const zlib = require('zlib');
const { validateExecutable } = require('./system');

const JAVA_TIMEOUT_MS = 5000;
const ADOPTIUM_MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const TAR_BLOCK_SIZE = 512;
const DEFAULT_TAR_LIMITS = Object.freeze({
  maxEntries: 20000,
  maxEntrySize: 512 * 1024 * 1024,
  maxTotalSize: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxArchiveBytes: 512 * 1024 * 1024,
});

function requiredJavaMajor(mcVersion) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(mcVersion || '');
  if (!m) return 17;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (major > 1) return 21;
  if (minor >= 20) {
    const patch = parseInt(m[3] || '0', 10);
    const parts = (mcVersion || '').split('.').map(Number);
    if (parts[1] === 20 && parts[2] >= 5) return 21;
    if (parts[1] > 20) return 21;
    return 17;
  }
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

function normalizeRequired(mcVersion) {
  const r = requiredJavaMajor(mcVersion);
  if (r === 16) return 17;
  return r;
}

function validateJavaExecutable(candidate) {
  const names = process.platform === 'win32' ? ['java.exe'] : ['java'];
  return validateExecutable(candidate, { names });
}

function parseJavaVersion(text) {
  const match = String(text || '').match(/(?:^|\s)version\s+"([^"]+)"/i);
  if (!match) return null;
  const version = match[1];
  const pieces = version.split(/[._+-]/).map(Number);
  if (!pieces.length || !Number.isFinite(pieces[0])) return null;
  if (pieces[0] === 1) {
    return Number.isSafeInteger(pieces[1]) && pieces[1] > 0 ? 8 : null;
  }
  return Number.isSafeInteger(pieces[0]) && pieces[0] > 0 ? pieces[0] : null;
}

function javaMajorOf(javaExe) {
  const executable = validateJavaExecutable(javaExe);
  if (!executable) return null;
  try {
    const result = spawnSync(executable, ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      timeout: JAVA_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    if (result.error) return null;
    return parseJavaVersion(`${result.stdout || ''}\n${result.stderr || ''}`);
  } catch (_) {
    return null;
  }
}

function safeDirectory(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /[\r\n"`]/.test(value) || value.startsWith('\\\\') || value.startsWith('//') || value.split(/[\\/]+/).some(part => part === '..')) return null;
  if (!path.isAbsolute(value)) return null;
  return path.resolve(value);
}

function addCandidateDirectory(list, seen, value) {
  const directory = safeDirectory(value);
  if (!directory) return;
  const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(directory);
}

function pathDirectories() {
  const result = [];
  const raw = process.env.PATH || '';
  for (const rawEntry of raw.split(path.delimiter)) {
    const entry = rawEntry.trim();
    if (!entry || /[\r\n"`]/.test(entry) || entry.startsWith('\\\\') || entry.startsWith('//') || entry.split(/[\\/]+/).some(part => part === '..')) continue;
    if (!path.isAbsolute(entry)) continue;
    result.push(path.resolve(entry));
  }
  return result;
}

function candidatePaths() {
  const list = [];
  const seen = new Set();
  const home = safeDirectory(os.homedir()) || os.homedir();

  addCandidateDirectory(list, seen, path.join(baseDir(), 'runtimes'));
  if (process.env.JAVA_HOME) {
    addCandidateDirectory(list, seen, process.env.JAVA_HOME);
    addCandidateDirectory(list, seen, path.join(process.env.JAVA_HOME, 'bin'));
  }
  for (const directory of pathDirectories()) addCandidateDirectory(list, seen, directory);

  if (process.platform === 'win32') {
    const roots = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Java'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Eclipse Adoptium'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Zulu'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Java'),
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Microsoft',
    ];
    for (const base of roots) {
      const directory = safeDirectory(base);
      if (!directory) continue;
      try {
        if (!fs.statSync(directory).isDirectory()) continue;
        for (const name of fs.readdirSync(directory)) {
          const child = path.join(directory, name);
          addCandidateDirectory(list, seen, child);
          addCandidateDirectory(list, seen, path.join(child, 'bin'));
        }
      } catch (_) { }
    }
    const appData = safeDirectory(process.env.APPDATA) || safeDirectory(path.join(home, 'AppData', 'Roaming'));
    if (appData) addCandidateDirectory(list, seen, path.join(appData, '.minecraft', 'runtime'));
  }
  return list;
}

function baseDir() {
  const configured = safeDirectory(process.env.FPS_LAUNCHER_DIR);
  return configured || path.resolve(path.join(os.homedir(), '.fps-launcher'));
}

function findJavaExecutables() {
  const found = [];
  const seen = new Set();
  const pushExe = candidate => {
    const executable = validateJavaExecutable(candidate);
    if (!executable) return;
    const key = process.platform === 'win32' ? executable.toLowerCase() : executable;
    if (seen.has(key)) return;
    seen.add(key);
    const major = javaMajorOf(executable);
    if (major) found.push({ path: executable, major });
  };

  const name = process.platform === 'win32' ? 'java.exe' : 'java';
  const visitedDirectories = new Set();
  let scannedDirectories = 0;
  const scan = (directory, depth) => {
    if (depth > 3 || scannedDirectories >= 512) return;
    const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
    if (visitedDirectories.has(key)) return;
    visitedDirectories.add(key);
    scannedDirectories++;
    pushExe(path.join(directory, name));
    pushExe(path.join(directory, 'bin', name));
    if (depth === 3 || path.basename(directory).toLowerCase() === 'bin') return;
    let entries;
    try { entries = fs.readdirSync(directory); } catch (_) { return; }
    for (const sub of entries) {
      const subPath = path.join(directory, sub);
      let st;
      try { st = fs.lstatSync(subPath); } catch (_) { continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) scan(subPath, depth + 1);
    }
  };
  for (const candidate of candidatePaths()) {
    try {
      const st = fs.lstatSync(candidate);
      if (st.isFile()) {
        if (process.platform === 'win32' ? /java\.exe$/i.test(candidate) : /(^|[/\\])java$/.test(candidate)) pushExe(candidate);
      } else if (st.isDirectory() && !st.isSymbolicLink()) {
        scan(candidate, 0);
      }
    } catch (_) { }
  }
  return found;
}

function selectJava(mcVersion, found) {
  found = found || findJavaExecutables();
  if (found.length === 0) return null;
  const need = normalizeRequired(mcVersion);
  const score = j => {
    let s = 0;
    if (j.major === need) s += 100;
    else if (j.major > need && (need === 8 || j.major === 17 || j.major === 21)) s += 60;
    else if (j.major > need) s += 40;
    s += Math.min(20, j.major);
    const p = j.path.toLowerCase();
    if (/temurin|adoptium/.test(p)) s += 5;
    if (/graalvm/.test(p)) s += 6;
    if (/zulu/.test(p)) s += 4;
    if (/microsoft/.test(p)) s += 3;
    return s;
  };
  return found.slice().sort((a, b) => score(b) - score(a))[0];
}

function normalizeJavaMajor(javaMajor) {
  if (!Number.isSafeInteger(javaMajor) || javaMajor < 8 || javaMajor > 99) throw new TypeError('invalid Java major');
  return javaMajor;
}

function adoptiumTarget(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const platformFromTarget = source.os === 'windows' ? 'win32' : source.os === 'mac' ? 'darwin' : source.os === 'linux' ? 'linux' : null;
  const platform = source.platform || platformFromTarget || process.platform;
  const architecture = source.architecture || source.arch || os.arch();
  let osName;
  if (platform === 'win32') osName = 'windows';
  else if (platform === 'darwin') osName = 'mac';
  else if (platform === 'linux') osName = 'linux';
  else throw new Error('unsupported Adoptium platform');

  const architectureMap = {
    x64: 'x64',
    x86: 'x86',
    arm64: 'aarch64',
    aarch64: 'aarch64',
    ia32: 'x86',
    arm: 'arm',
    ppc64: 'ppc64',
    s390x: 's390x',
    riscv64: 'riscv64',
  };
  const apiArchitecture = architectureMap[architecture];
  if (!apiArchitecture) throw new Error('unsupported Adoptium architecture');
  return {
    os: osName,
    architecture: apiArchitecture,
    heapSize: 'normal',
    imageType: 'jre',
    jvmImpl: 'hotspot',
    vendor: 'eclipse',
    releaseType: source.releaseType || 'ga',
  };
}

function adoptiumUrl(javaMajor, target = adoptiumTarget()) {
  normalizeJavaMajor(javaMajor);
  const t = adoptiumTarget(target);
  return `https://api.adoptium.net/v3/binary/latest/${javaMajor}/ga/${t.os}/${t.architecture}/${t.imageType}/${t.jvmImpl}/${t.heapSize}/${t.vendor}`;
}

function adoptiumMetadataUrl(javaMajor, target = adoptiumTarget()) {
  normalizeJavaMajor(javaMajor);
  const t = adoptiumTarget(target);
  const query = new URLSearchParams({
    architecture: t.architecture,
    heap_size: t.heapSize,
    image_type: t.imageType,
    jvm_impl: t.jvmImpl,
    os: t.os,
    page_size: '1',
    vendor: t.vendor,
  });
  return `https://api.adoptium.net/v3/assets/feature_releases/${javaMajor}/${t.releaseType}?${query}`;
}

function addAdoptiumBinary(result, binary, release, legacy = false) {
  if (binary && typeof binary === 'object' && !Array.isArray(binary)) {
    result.push({ binary, release: release || null, legacy: legacy === true });
  }
}

function collectAdoptiumBinaries(metadata) {
  const result = [];
  const addRelease = release => {
    if (!release || typeof release !== 'object' || Array.isArray(release)) return;
    if (Array.isArray(release.binaries)) {
      for (const binary of release.binaries) addAdoptiumBinary(result, binary, release);
    }
    if (Array.isArray(release.assets)) {
      for (const asset of release.assets) {
        if (asset && typeof asset === 'object') addAdoptiumBinary(result, asset.binary, release, true);
      }
    }
    addAdoptiumBinary(result, release.binary, release, true);
  };
  if (Array.isArray(metadata)) for (const release of metadata) addRelease(release);
  else addRelease(metadata);
  return result;
}

function adoptiumBinaryMatches({ binary, release, legacy }, target) {
  const fields = [
    ['architecture', target.architecture],
    ['os', target.os],
    ['heap_size', target.heapSize],
    ['image_type', target.imageType],
    ['jvm_impl', target.jvmImpl],
  ];
  for (const [key, expected] of fields) {
    if (legacy) {
      if (binary[key] !== undefined && binary[key] !== null && binary[key] !== expected) return false;
    } else if (binary[key] !== expected) {
      return false;
    }
  }
  const vendor = binary.vendor || (release && release.vendor);
  if (vendor !== undefined && vendor !== null && vendor !== target.vendor) return false;
  const releaseType = release && release.release_type;
  if (releaseType !== undefined && releaseType !== null && releaseType !== target.releaseType) return false;
  return true;
}

function parseAdoptiumPackage(metadata, options = {}) {
  const hasTarget = options && typeof options === 'object' && Object.keys(options).length > 0;
  const target = hasTarget ? adoptiumTarget(options) : null;
  const allCandidates = collectAdoptiumBinaries(metadata);
  const candidates = target ? allCandidates.filter(item => adoptiumBinaryMatches(item, target)) : allCandidates;
  if (candidates.length === 0) throw new Error('Adoptium metadata has no matching binary package');
  const packageInfo = candidates[0].binary.package;
  if (!packageInfo || typeof packageInfo !== 'object' || Array.isArray(packageInfo)) {
    throw new Error('Adoptium asset metadata is missing the binary package');
  }
  const url = packageInfo.link;
  const sha256 = packageInfo.checksum;
  const size = packageInfo.size;
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new Error('Adoptium package URL is invalid');
  const { assertAllowedUrl } = require('./downloader');
  assertAllowedUrl(url);
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) throw new Error('Adoptium package SHA-256 is invalid');
  if (!Number.isSafeInteger(size) || size <= 0 || size > ADOPTIUM_MAX_PACKAGE_BYTES) {
    throw new Error('Adoptium package size is invalid');
  }
  const result = { url, sha256: sha256.toLowerCase(), size };
  if (typeof packageInfo.name === 'string') {
    Object.defineProperty(result, 'name', { value: packageInfo.name, enumerable: false });
  }
  return result;
}

function adoptiumArchiveType(packageInfo) {
  const url = packageInfo && typeof packageInfo === 'object'
    ? (packageInfo.url || packageInfo.link)
    : packageInfo;
  if (typeof url !== 'string') throw new Error('Adoptium package URL is invalid');
  const parsed = new URL(url);
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch (_) { throw new Error('Adoptium package URL is invalid'); }
  const urlName = path.posix.basename(pathname).toLowerCase();
  const declaredName = packageInfo && typeof packageInfo.name === 'string' ? packageInfo.name : null;
  if (declaredName && (declaredName !== path.posix.basename(declaredName) || /[\u0000\r\n\\/]/.test(declaredName))) {
    throw new Error('Adoptium package name is unsafe');
  }
  const declaredLower = declaredName ? declaredName.toLowerCase() : null;
  const urlType = urlName.endsWith('.tar.gz') ? 'tar.gz' : urlName.endsWith('.zip') ? 'zip' : null;
  const declaredType = declaredLower && declaredLower.endsWith('.tar.gz') ? 'tar.gz'
    : declaredLower && declaredLower.endsWith('.zip') ? 'zip' : null;
  if (declaredName && !declaredType) throw new Error('Adoptium package archive type is unsupported');
  if (!urlType && !declaredType) throw new Error('Adoptium package archive type is unsupported');
  if (urlType && declaredType && urlType !== declaredType) {
    throw new Error('Adoptium package archive type is inconsistent');
  }
  return urlType || declaredType;
}

function normalizeTarLimits(options = {}) {
  const source = { ...DEFAULT_TAR_LIMITS, ...(options.limits || {}) };
  for (const key of Object.keys(DEFAULT_TAR_LIMITS)) {
    if (!Number.isSafeInteger(source[key]) || source[key] <= 0) {
      throw new TypeError(`${key} must be a positive safe integer`);
    }
  }
  return source;
}

function tarFieldString(field, label) {
  if (!Buffer.isBuffer(field)) throw new Error(`TAR: invalid ${label}`);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function tarFieldNumber(field, label) {
  if (!Buffer.isBuffer(field) || field.length === 0) throw new Error(`TAR: invalid ${label}`);
  if (field[0] & 0x80) {
    let value = BigInt(field[0] & 0x7f);
    for (let i = 1; i < field.length; i++) value = (value << 8n) | BigInt(field[i]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`TAR: ${label} is too large`);
    return Number(value);
  }
  const text = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`TAR: invalid ${label}`);
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`TAR: ${label} is too large`);
  return value;
}

function tarPathParts(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || /[\r\n\\]/.test(name)) {
    throw new Error(`TAR: unsafe entry path: ${name}`);
  }
  if (name.startsWith('/') || name.startsWith('//') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`TAR: unsafe entry path: ${name}`);
  }
  const withoutDotSlash = name.replace(/^(?:\.\/)+/, '');
  if (withoutDotSlash !== name) name = withoutDotSlash;
  const normalized = name.replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === './') return null;
  if (normalized.includes('://') || normalized.includes('//')) throw new Error(`TAR: unsafe entry path: ${name}`);
  const parts = normalized.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes(':') || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(`TAR: unsafe entry path: ${name}`);
    }
  }
  return parts;
}

function tarLinkParts(entryParts, linkname, hardlink = false) {
  if (typeof linkname !== 'string' || !linkname || linkname.includes('\0') || /[\r\n\\]/.test(linkname)
    || linkname.startsWith('/') || /^[A-Za-z]:/.test(linkname)) {
    throw new Error(`TAR: unsafe link target: ${linkname}`);
  }
  const entryName = entryParts.join('/');
  const base = hardlink ? '' : path.posix.dirname(entryName);
  const normalized = path.posix.normalize(path.posix.join(base, linkname));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`TAR: unsafe link target: ${linkname}`);
  }
  return tarPathParts(normalized);
}

function tarChecksum(header) {
  const expected = tarFieldNumber(header.subarray(148, 156), 'header checksum');
  let actual = 0;
  for (let i = 0; i < header.length; i++) actual += i >= 148 && i < 156 ? 0x20 : header[i];
  if (actual !== expected) throw new Error('TAR: header checksum mismatch');
}

function isZeroTarBlock(block) {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function tarPaxRecords(data) {
  const records = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('TAR: malformed PAX record');
    const lengthText = data.subarray(offset, space).toString('ascii');
    if (!/^\d+$/.test(lengthText)) throw new Error('TAR: malformed PAX length');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > data.length) {
      throw new Error('TAR: malformed PAX length');
    }
    const end = offset + length;
    if (data[end - 1] !== 0x0a) throw new Error('TAR: malformed PAX record');
    const record = data.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('TAR: malformed PAX record');
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return records;
}

function tarPathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertTarOutputPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`TAR: destination escapes extraction root: ${target}`);
  }
  let current = resolvedRoot;
  const parts = relative ? relative.split(path.sep) : [];
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) throw new Error('TAR: symlink output path is not allowed');
      if (current !== resolvedTarget && !st.isDirectory()) throw new Error('TAR: output parent is not a directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function parseTarEntries(buffer, limits) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('TAR: empty archive');
  const entries = [];
  let offset = 0;
  let count = 0;
  let totalSize = 0;
  let globalPax = {};
  let pendingPax = null;
  let pendingLongName = null;
  let pendingLinkName = null;

  while (offset < buffer.length) {
    if (buffer.length - offset < TAR_BLOCK_SIZE) throw new Error('TAR: truncated header');
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isZeroTarBlock(header)) {
      if (offset + TAR_BLOCK_SIZE * 2 > buffer.length
        || !isZeroTarBlock(buffer.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE * 2))) {
        throw new Error('TAR: missing end-of-archive marker');
      }
      for (let i = offset + TAR_BLOCK_SIZE * 2; i < buffer.length; i++) {
        if (buffer[i] !== 0) throw new Error('TAR: data after end-of-archive marker');
      }
      return entries;
    }

    count++;
    if (count > limits.maxEntries) throw new Error('TAR: entry count limit exceeded');
    tarChecksum(header);
    const headerSize = tarFieldNumber(header.subarray(124, 136), 'entry size');
    if (headerSize > limits.maxEntrySize) throw new Error('TAR: entry is too large');
    const dataStart = offset + TAR_BLOCK_SIZE;
    const headerDataEnd = dataStart + headerSize;
    const headerPadding = (TAR_BLOCK_SIZE - (headerSize % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    const headerNextOffset = headerDataEnd + headerPadding;
    if (headerDataEnd < dataStart || headerNextOffset < headerDataEnd || headerNextOffset > buffer.length) {
      throw new Error('TAR: truncated entry data');
    }
    const data = buffer.subarray(dataStart, headerDataEnd);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);

    if (type === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
      offset = headerNextOffset;
      continue;
    }
    if (type === 'K') {
      pendingLinkName = data.toString('utf8').replace(/\0.*$/, '');
      offset = headerNextOffset;
      continue;
    }
    if (type === 'x') {
      pendingPax = tarPaxRecords(data);
      offset = headerNextOffset;
      continue;
    }
    if (type === 'g') {
      globalPax = { ...globalPax, ...tarPaxRecords(data) };
      offset = headerNextOffset;
      continue;
    }
    if (type !== '0' && type !== '5' && type !== '1' && type !== '2') {
      throw new Error(`TAR: unsupported entry type ${type}`);
    }

    const pax = { ...globalPax, ...(pendingPax || {}) };
    const prefix = tarFieldString(header.subarray(345, 500), 'prefix');
    const headerName = tarFieldString(header.subarray(0, 100), 'name');
    const name = pax.path !== undefined ? pax.path
      : (pendingLongName !== null ? pendingLongName : (prefix ? `${prefix}/${headerName}` : headerName));
    const parts = tarPathParts(name);
    let size = headerSize;
    if (pax.size !== undefined) {
      if (!/^\d+$/.test(pax.size)) throw new Error('TAR: invalid PAX size');
      size = Number(pax.size);
      if (!Number.isSafeInteger(size)) throw new Error('TAR: invalid PAX size');
    }
    if (size > limits.maxEntrySize) throw new Error('TAR: entry is too large');
    const dataEnd = dataStart + size;
    const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    const nextOffset = dataEnd + padding;
    if (dataEnd < dataStart || nextOffset < dataEnd || nextOffset > buffer.length) {
      throw new Error('TAR: truncated entry data');
    }
    if (type === '5') {
      if (size !== 0) throw new Error('TAR: directory entry has data');
      if (parts) entries.push({ type: 'dir', parts, mode: tarFieldNumber(header.subarray(100, 108), 'mode') });
    } else if (type === '1' || type === '2') {
      if (!parts) throw new Error('TAR: link entry has an empty path');
      if (size !== 0) throw new Error('TAR: link entry has data');
      const linkname = pax.linkpath !== undefined ? pax.linkpath
        : (pendingLinkName !== null ? pendingLinkName : tarFieldString(header.subarray(157, 257), 'link name'));
      entries.push({
        type: 'link',
        parts,
        linkParts: tarLinkParts(parts, linkname, type === '1'),
        mode: tarFieldNumber(header.subarray(100, 108), 'mode'),
      });
    } else {
      if (!parts) throw new Error('TAR: file entry has an empty path');
      if (size > limits.maxTotalSize - totalSize) throw new Error('TAR: total uncompressed size limit exceeded');
      totalSize += size;
      entries.push({
        type: 'file',
        parts,
        data: buffer.subarray(dataStart, dataEnd),
        mode: tarFieldNumber(header.subarray(100, 108), 'mode'),
      });
    }
    pendingPax = null;
    pendingLongName = null;
    pendingLinkName = null;
    offset = nextOffset;
  }
  throw new Error('TAR: end-of-archive marker not found');
}

function extractTarGz(archivePath, destination, options = {}) {
  if (typeof archivePath !== 'string' || !archivePath || archivePath.includes('\0')) {
    throw new TypeError('invalid TAR archive path');
  }
  if (typeof destination !== 'string' || !destination || destination.includes('\0')) {
    throw new TypeError('invalid TAR extraction directory');
  }
  const limits = normalizeTarLimits(options);
  let archiveStat;
  try {
    archiveStat = fs.lstatSync(archivePath);
    if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) throw new Error('TAR: archive is not a regular file');
  } catch (error) {
    throw error;
  }
  if (archiveStat.size <= 0 || archiveStat.size > limits.maxArchiveBytes) throw new Error('TAR: archive size limit exceeded');
  const compressed = fs.readFileSync(archivePath);
  if (compressed.length > limits.maxArchiveBytes) throw new Error('TAR: archive size limit exceeded');
  let expanded;
  try {
    expanded = zlib.gunzipSync(compressed, { maxOutputLength: limits.maxTotalSize + limits.maxEntries * TAR_BLOCK_SIZE });
  } catch (error) {
    throw new Error(`TAR: gzip extraction failed: ${error.message}`);
  }
  if (expanded.length > limits.maxTotalSize + limits.maxEntries * TAR_BLOCK_SIZE) {
    throw new Error('TAR: total uncompressed size limit exceeded');
  }
  if (compressed.length > 0 && expanded.length / compressed.length > limits.maxCompressionRatio) {
    throw new Error('TAR: compression ratio limit exceeded');
  }
  const entries = parseTarEntries(expanded, limits);
  const root = path.resolve(destination);
  if (root === path.parse(root).root) throw new Error('TAR: refusing to extract into a filesystem root');
  assertTarOutputPath(path.parse(root).root, root);
  try {
    const existing = fs.lstatSync(root);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('TAR: extraction root is not a directory');
    if (fs.readdirSync(root).length > 0) throw new Error('TAR: extraction root is not empty');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const kinds = new Map();
  const byKey = new Map();
  const planned = [];
  for (const entry of entries) {
    const target = path.resolve(root, ...entry.parts);
    assertTarOutputPath(root, target);
    const key = tarPathKey(target);
    if (entry.type === 'dir') {
      if (kinds.get(key) === 'file') {
        throw new Error(`TAR: file/directory collision: ${entry.parts.join('/')}`);
      }
      kinds.set(key, 'dir');
    } else {
      if (kinds.has(key)) throw new Error(`TAR: duplicate destination: ${entry.parts.join('/')}`);
      kinds.set(key, 'file');
    }
    const item = { ...entry, target, key };
    planned.push(item);
    byKey.set(key, item);
  }

  for (const item of planned) {
    if (item.type !== 'link') continue;
    const seen = new Set([item.key]);
    let targetItem = item;
    while (targetItem.type === 'link') {
      const targetKey = tarPathKey(path.resolve(root, ...targetItem.linkParts));
      if (seen.has(targetKey)) throw new Error(`TAR: link cycle at ${item.parts.join('/')}`);
      seen.add(targetKey);
      targetItem = byKey.get(targetKey);
      if (!targetItem) throw new Error(`TAR: link target is missing: ${item.parts.join('/')}`);
    }
    if (targetItem.type !== 'file') throw new Error(`TAR: link target is not a regular file: ${item.parts.join('/')}`);
    item.resolved = targetItem;
  }

  for (const item of planned) {
    let parent = path.dirname(item.target);
    while (parent !== root && path.relative(root, parent) !== '..' && !path.isAbsolute(path.relative(root, parent))) {
      if (kinds.get(tarPathKey(parent)) === 'file') throw new Error(`TAR: file/directory collision: ${item.parts.join('/')}`);
      parent = path.dirname(parent);
    }
  }
  let outputSize = 0;
  for (const item of planned) {
    if (item.type === 'dir') continue;
    const size = item.type === 'link' ? item.resolved.data.length : item.data.length;
    if (size > limits.maxEntrySize || size > limits.maxTotalSize - outputSize) {
      throw new Error('TAR: extracted output size limit exceeded');
    }
    outputSize += size;
  }

  const createdFiles = [];
  const createdDirs = [];
  try {
    fs.mkdirSync(root, { recursive: true });
    assertTarOutputPath(path.parse(root).root, root);
    const directories = planned.filter(item => item.type === 'dir').sort((a, b) => a.parts.length - b.parts.length);
    for (const item of directories) {
      assertTarOutputPath(root, item.target);
      fs.mkdirSync(item.target, { recursive: true });
      try { fs.chmodSync(item.target, (item.mode & 0o777) || 0o755); } catch (_) {}
      createdDirs.push(item.target);
    }
    for (const item of planned.filter(entry => entry.type === 'file')) {
      assertTarOutputPath(root, item.target);
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      assertTarOutputPath(root, item.target);
      const mode = (item.mode & 0o777) || 0o644;
      fs.writeFileSync(item.target, item.data, { flag: 'wx', mode });
      try { fs.chmodSync(item.target, mode); } catch (_) {}
      createdFiles.push(item.target);
    }
    for (const item of planned.filter(entry => entry.type === 'link')) {
      assertTarOutputPath(root, item.target);
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      assertTarOutputPath(root, item.target);
      const mode = (item.resolved.mode & 0o777) || 0o644;
      fs.writeFileSync(item.target, item.resolved.data, { flag: 'wx', mode });
      try { fs.chmodSync(item.target, mode); } catch (_) {}
      createdFiles.push(item.target);
    }
  } catch (error) {
    for (const file of createdFiles.reverse()) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
    for (const dir of createdDirs.reverse()) {
      try { fs.rmdirSync(dir); } catch (_) {}
    }
    throw error;
  }
  return planned.filter(item => item.type !== 'dir').length;
}

function runtimeDir(javaMajor) {
  if (!Number.isSafeInteger(javaMajor) || javaMajor < 8 || javaMajor > 99) throw new TypeError('invalid Java major');
  return path.join(baseDir(), 'runtimes', `temurin-${javaMajor}-jre`);
}

function runtimeJavaExeIn(javaMajor, dir) {
  const candidates = [];
  const name = process.platform === 'win32' ? 'java.exe' : 'java';
  candidates.push(path.join(dir, 'bin', name));
  const visited = new Set();
  const visit = (current, depth) => {
    if (depth > 3 || visited.has(current)) return;
    visited.add(current);
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (!entry || entry.isSymbolicLink()) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        candidates.push(path.join(child, 'bin', name));
        visit(child, depth + 1);
      }
    }
  };
  visit(dir, 0);
  for (const candidate of candidates) {
    const validated = validateJavaExecutable(candidate);
    if (validated) return validated;
  }
  return candidates[0];
}

function runtimeJavaExe(javaMajor) {
  return runtimeJavaExeIn(javaMajor, runtimeDir(javaMajor));
}

function assertRuntimeDestination(dir) {
  try {
    const existing = fs.lstatSync(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('Java runtime destination is not a directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function removeRuntimeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { }
}

async function ensureJava(mcVersion, options = {}) {
  const {
    onLog,
    findJava: findJavaOverride,
    fetchJson: fetchJsonOverride,
    downloadFile: downloadFileOverride,
    validateJava: validateJavaOverride,
    probeJava: probeJavaOverride,
  } = options && typeof options === 'object' ? options : {};
  const need = normalizeRequired(mcVersion);
  const found = typeof findJavaOverride === 'function' ? findJavaOverride() : findJavaExecutables();
  const picked = selectJava(mcVersion, found);
  const ok = picked && (need === 8 ? picked.major === 8 : picked.major >= need);
  if (ok) return { path: picked.path, major: picked.major, downloaded: false };

  const log = typeof onLog === 'function' ? onLog : () => {};
  log(`[java] need ${need}, have ${picked ? picked.major : 'none'} — downloading Temurin ${need} JRE...`);
  const downloader = require('./downloader');
  const fetchJson = fetchJsonOverride || downloader.fetchJson;
  const downloadFile = downloadFileOverride || downloader.downloadFile;
  if (typeof fetchJson !== 'function' || typeof downloadFile !== 'function') {
    throw new Error('Java downloader dependencies are unavailable');
  }
  const target = adoptiumTarget();
  const metadata = await fetchJson(adoptiumMetadataUrl(need, target), {
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 30 * 1000,
  });
  const adoptiumPackage = parseAdoptiumPackage(metadata, target);
  const archiveType = adoptiumArchiveType(adoptiumPackage);
  const dir = runtimeDir(need);
  const archivePath = `${dir}.${archiveType}`;
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  assertRuntimeDestination(dir);
  let archiveCleanupAllowed = false;
  try {
    const existingArchive = fs.lstatSync(archivePath);
    if (existingArchive.isSymbolicLink() || !existingArchive.isFile()) throw new Error('Java archive destination is unsafe');
    archiveCleanupAllowed = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    archiveCleanupAllowed = true;
  }
  const staging = fs.mkdtempSync(path.join(parent, '.temurin-unpack-'));
  const validateJava = validateJavaOverride || validateJavaExecutable;
  const probeJava = probeJavaOverride || javaMajorOf;
  let installed = false;
  try {
    await downloadFile(adoptiumPackage.url, archivePath, {
      maxBytes: ADOPTIUM_MAX_PACKAGE_BYTES,
      sha256: adoptiumPackage.sha256,
      size: adoptiumPackage.size,
      timeoutMs: 10 * 60 * 1000,
      onProgress: p => {
        if (p.total && p.done && (p.done % (20 * 1024 * 1024)) < 65536) {
          log(`[java] ${(p.done / 1024 / 1024).toFixed(0)}/${(p.total / 1024 / 1024).toFixed(0)} MB`);
        }
      },
    });

    let count;
    if (archiveType === 'zip') {
      const { extractZip } = require('./unzip');
      count = extractZip(archivePath, staging);
    } else {
      count = extractTarGz(archivePath, staging);
    }
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('archive is empty');

    const stagedExe = runtimeJavaExeIn(need, staging);
    if (!validateJava(stagedExe)) throw new Error('archive does not contain a usable java executable');
    const stagedMajor = probeJava(stagedExe);
    if (stagedMajor !== need) throw new Error(`downloaded Java major mismatch: expected ${need}, got ${stagedMajor || 'unknown'}`);

    assertRuntimeDestination(dir);
    removeRuntimeTree(dir);
    fs.renameSync(staging, dir);
    installed = true;

    const exe = runtimeJavaExeIn(need, dir);
    if (!validateJava(exe)) throw new Error('installed Java executable disappeared');
    const major = probeJava(exe);
    if (major !== need) throw new Error(`installed Java major mismatch: expected ${need}, got ${major || 'unknown'}`);
    log(`[java] ready: ${exe} (major ${major})`);
    return { path: exe, major, downloaded: true };
  } catch (error) {
    removeRuntimeTree(staging);
    if (installed) removeRuntimeTree(dir);
    throw new Error(`Java runtime unpack failed: ${error.message}`);
  } finally {
    if (archiveCleanupAllowed) {
      const cleanup = typeof downloader.cleanupFile === 'function'
        ? downloader.cleanupFile
        : async file => { try { await fs.promises.unlink(file); } catch (_) {} };
      try { await cleanup(archivePath); } catch (_) { }
    }
  }
}

module.exports = {
  baseDir,
  requiredJavaMajor: normalizeRequired,
  findJavaExecutables,
  selectJava,
  javaMajorOf,
  validateJavaExecutable,
  adoptiumUrl,
  adoptiumMetadataUrl,
  parseAdoptiumPackage,
  adoptiumArchiveType,
  adoptiumTarget,
  extractTarGz,
  runtimeDir,
  runtimeJavaExe,
  ensureJava,
};
