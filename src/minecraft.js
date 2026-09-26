'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fetchJson } = require('./downloader');
const { baseDir } = require('./java');

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

function safeSegment(value, label = 'segment') {
  if (
    typeof value !== 'string'
    || !value
    || value.length > 128
    || /[\u0000-\u001f\u007f\\/:*?"<>|]/.test(value)
    || value === '.'
    || value === '..'
    || value.includes('..')
  ) {
    throw new Error(`Unsafe ${label}`);
  }
  return value;
}

function isWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function safeArtifactPath(base, value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(value)) {
    throw new Error('Unsafe artifact path');
  }
  const parts = value.split('/');
  if (
    !parts.length
    || parts.some(part => (
      !part
      || part.length > 255
      || part === '.'
      || part === '..'
      || /[:*?"<>|]/.test(part)
      || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    ))
  ) {
    throw new Error('Unsafe artifact path');
  }
  const destination = path.resolve(base, ...parts);
  if (!isWithin(base, destination)) throw new Error('Artifact path escapes destination');
  return destination;
}

function mcDir(customDir) {
  return customDir || path.join(baseDir(), 'minecraft');
}
function versionsDir(mc) { return path.join(mcDir(mc), 'versions'); }
function librariesDir(mc) { return path.join(mcDir(mc), 'libraries'); }
function assetsDir(mc) { return path.join(mcDir(mc), 'assets'); }
function nativesDir(mc, versionId) { return path.join(mcDir(mc), 'versions', safeSegment(versionId, 'version id'), 'natives'); }

function manifestCachePath(mc) {
  return path.join(mcDir(mc), 'version_manifest_v2.json');
}

async function getVersionManifest(mc, { force = false } = {}) {
  const cache = manifestCachePath(mc);
  if (!force && fs.existsSync(cache)) {
    try {
      const st = fs.statSync(cache);
      if (Date.now() - st.mtimeMs < 3600 * 1000) {
        return JSON.parse(fs.readFileSync(cache, 'utf8'));
      }
    } catch (_) { }
  }
  const data = await fetchJson(VERSION_MANIFEST_URL);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(data), 'utf8');
  return data;
}

async function resolveVersionMeta(mc, versionId, { force = false } = {}) {
  safeSegment(versionId, 'version id');
  const manifest = await getVersionManifest(mc, { force });
  const entry = (manifest.versions || []).find(v => v.id === versionId);
  if (!entry) throw new Error(`Version not found: ${versionId}. Use listVersions() to see available.`);
  const versionFile = path.join(versionsDir(mc), safeSegment(versionId, 'version id'), `${versionId}.json`);
  if (!force && fs.existsSync(versionFile)) {
    try { return JSON.parse(fs.readFileSync(versionFile, 'utf8')); } catch (_) { }
  }
  const meta = await fetchJson(entry.url);
  fs.mkdirSync(path.dirname(versionFile), { recursive: true });
  fs.writeFileSync(versionFile, JSON.stringify(meta), 'utf8');
  return meta;
}

async function listVersions(mc) {
  const manifest = await getVersionManifest(mc);
  return {
    latest: manifest.latest,
    versions: (manifest.versions || []).map(v => ({ id: v.id, type: v.type, url: v.url, time: v.releaseTime })),
  };
}


function ruleApplies(rule) {
  if (rule.features) return false;
  if (!rule.os) return true;
  const osName = rule.os.name;
  const cur = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  let match = true;
  if (osName && osName !== cur) match = false;
  if (rule.os.arch) {
    const curArch = os.arch() === 'ia32' ? 'x86' : os.arch();
    const wantArch = rule.os.arch === 'ia32' ? 'x86' : rule.os.arch;
    if (wantArch !== curArch) match = false;
  }
  if (rule.os.version && process.platform === 'win32') {
    try {
      const rel = os.release();
      const re = new RegExp(rule.os.version);
      if (!re.test(rel)) match = false;
    } catch (_) { }
  }
  return match;
}

const ruleAllows = ruleApplies;

function libApplies(lib) {
  if (!lib.rules || lib.rules.length === 0) return true;
  let allowed = lib.rules.some(r => r.action === 'allow') ? false : true;
  for (const r of lib.rules) {
    if (ruleApplies(r)) {
      allowed = r.action === 'allow';
    }
  }
  return allowed;
}

function nativesClassifier(lib) {
  if (!lib.natives) return null;
  const cur = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  let key = lib.natives[cur];
  if (!key) return null;
  key = key.replace('${arch}', os.arch() === 'x64' ? '64' : '32');
  return key;
}

function isNativeForCurrent(classifier) {
  if (!classifier || !classifier.startsWith('natives-')) return false;
  const curOS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const rest = classifier.slice('natives-'.length).toLowerCase();
  const osOk = rest === curOS || rest.startsWith(curOS + '-') || rest.startsWith(curOS + '_')
    || (curOS === 'macos' && (rest === 'osx' || rest.startsWith('osx-')));
  if (!osOk) return false;
  const arch = os.arch();
  if (rest.includes('arm64') || rest.includes('aarch64')) return arch === 'arm64';
  if (rest.includes('x86') || rest.includes('386') || /(^|-)32($|-)/.test(rest)) return arch === 'ia32' || arch === 'x86';
  if (/(^|-)64($|-)/.test(rest)) return arch === 'x64';
  return true;
}

function artifactPath(base, artifact) {
  return safeArtifactPath(base, artifact && artifact.path);
}

function buildLibrariesQueue(mc, versionMeta) {
  const versionId = versionMeta && versionMeta.id !== undefined
    ? safeSegment(versionMeta.id, 'version id')
    : null;
  const libsBase = librariesDir(mc);
  const queue = [];
  const classpath = [];

  for (const lib of versionMeta.libraries || []) {
    if (!libApplies(lib)) continue;
    const nameParts = (lib.name || '').split(':');
    if (nameParts.length >= 4 && isNativeForCurrent(nameParts[3]) && lib.downloads && lib.downloads.artifact) {
      const n = lib.downloads.artifact;
      const dest = artifactPath(libsBase, n);
      queue.push({ url: n.url, path: dest, sha1: n.sha1, size: n.size, kind: 'native', libName: lib.name });
      continue;
    }
    if (lib.downloads && lib.downloads.artifact) {
      const a = lib.downloads.artifact;
      const dest = artifactPath(libsBase, a);
      queue.push({ url: a.url, path: dest, sha1: a.sha1, size: a.size, kind: 'library' });
      classpath.push(dest);
    }
    const classifier = nativesClassifier(lib);
    if (classifier && lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[classifier]) {
      const n = lib.downloads.classifiers[classifier];
      const dest = artifactPath(libsBase, n);
      queue.push({ url: n.url, path: dest, sha1: n.sha1, size: n.size, kind: 'native', libName: lib.name });
    }
  }

  if (versionMeta.downloads && versionMeta.downloads.client) {
    const c = versionMeta.downloads.client;
    const dest = path.join(versionsDir(mc), versionId, `${versionId}.jar`);
    queue.push({ url: c.url, path: dest, sha1: c.sha1, size: c.size, kind: 'client' });
    classpath.push(dest);
  }

  if (versionMeta.logging && versionMeta.logging.client && versionMeta.logging.client.file) {
    const l = versionMeta.logging.client.file;
    const dest = path.join(assetsDir(mc), 'log_configs', safeSegment(l.id, 'logging id'));
    queue.push({ url: l.url, path: dest, sha1: l.sha1, size: l.size, kind: 'logconfig' });
  }

  if (versionMeta.assetIndex) {
    const ai = versionMeta.assetIndex;
    const assetIndexId = safeSegment(ai.id, 'asset index id');
    const dest = path.join(assetsDir(mc), 'indexes', `${assetIndexId}.json`);
    queue.push({ url: ai.url, path: dest, sha1: ai.sha1, size: ai.size, kind: 'assetIndex', assetIndexId });
  }

  return { queue, classpath };
}

function buildAssetsQueue(mc, assetIndexJson) {
  const queue = [];
  const objects = assetIndexJson.objects || {};
  for (const [name, obj] of Object.entries(objects)) {
    const hash = obj && obj.hash;
    if (typeof hash !== 'string' || !/^[0-9a-f]{40}$/i.test(hash)) {
      throw new Error(`Unsafe asset hash for ${name}`);
    }
    const normalizedHash = hash.toLowerCase();
    const sub = normalizedHash.slice(0, 2);
    const dest = path.join(assetsDir(mc), 'objects', sub, normalizedHash);
    const url = `https://resources.download.minecraft.net/${sub}/${normalizedHash}`;
    queue.push({ url, path: dest, sha1: normalizedHash, size: obj.size, kind: 'asset', name });
  }
  return queue;
}

function interpolateArg(arg, vars) {
  return String(arg).replace(/\$\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : '${' + k + '}'));
}

function isJavaClassName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.split('.').every(segment => (
      segment.length > 0
      && !/^\d/.test(segment)
      && /^[A-Za-z0-9_$]+$/.test(segment)
    ));
}

function isSafeMetadataJvmArg(argument) {
  if (typeof argument !== 'string' || argument.includes('\0')) return false;
  const lower = argument.toLowerCase();
  return !(
    lower.startsWith('-xmx')
    || lower.startsWith('-xms')
    || lower.startsWith('-xbootclasspath')
    || lower.startsWith('-javaagent')
    || lower.startsWith('-agentlib')
    || lower.startsWith('-agentpath')
    || lower.startsWith('-xx:onoutofmemoryerror')
    || lower.startsWith('-xx:onerror')
    || lower.includes('onerror=')
  );
}

function buildGameArgs(versionMeta, vars) {
  const out = [];
  if (versionMeta.arguments && versionMeta.arguments.game) {
    for (const a of versionMeta.arguments.game) {
      if (typeof a === 'string') {
        out.push(interpolateArg(a, vars));
      } else if (a && typeof a === 'object') {
        let ok = true;
        if (a.rules) {
          ok = false;
          for (const r of a.rules) {
            if (r.features) continue;
            if (!r.os) { if (r.action === 'allow') { ok = true; break; } continue; }
            const cur = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
            if (r.os.name && r.os.name !== cur) continue;
            if (r.action === 'allow') { ok = true; break; }
          }
        }
        if (!ok) continue;
        const v = Array.isArray(a.value) ? a.value : [a.value];
        for (const s of v) out.push(interpolateArg(s, vars));
      }
    }
  } else if (versionMeta.minecraftArguments) {
    for (const part of versionMeta.minecraftArguments.split(' ')) {
      out.push(interpolateArg(part, vars));
    }
  }
  return out;
}

function buildJvmArgsFromMeta(versionMeta, vars) {
  const out = [];
  const append = raw => {
    if (typeof raw !== 'string' || raw.includes('\0')) return;
    if (raw === '-cp' || raw === '-classpath') return;
    if (raw === '${classpath}') {
      out.push('__CLASSPATH__');
      return;
    }
    const value = interpolateArg(raw, vars);
    if (isSafeMetadataJvmArg(value)) out.push(value);
  };

  if (versionMeta.arguments && Array.isArray(versionMeta.arguments.jvm)) {
    for (const argument of versionMeta.arguments.jvm) {
      if (typeof argument === 'string') {
        append(argument);
      } else if (argument && typeof argument === 'object') {
        if (Object.prototype.hasOwnProperty.call(argument, 'rules')) {
          if (!Array.isArray(argument.rules) || !libApplies({ rules: argument.rules })) continue;
        }
        const values = Array.isArray(argument.value) ? argument.value : [argument.value];
        for (const value of values) append(value);
      }
    }
  }
  return out;
}

module.exports = {
  VERSION_MANIFEST_URL,
  mcDir, versionsDir, librariesDir, assetsDir, nativesDir,
  getVersionManifest, resolveVersionMeta, listVersions,
  buildLibrariesQueue, buildAssetsQueue,
  buildGameArgs, buildJvmArgsFromMeta, interpolateArg,
  isJavaClassName, isSafeMetadataJvmArg,
  ruleAllows, ruleApplies, libApplies,
  safeSegment, safeArtifactPath, artifactPath,
};
