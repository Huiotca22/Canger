'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const USER_AGENT = 'fps-launcher-backend/0.1';

const ALLOWED_HOSTS = Object.freeze([
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'launchermeta.mojang.com',
  'client-resources.mojang.com',
  'api.mojang.com',
  'api.modrinth.com',
  'cdn.modrinth.com',
  'meta.fabricmc.net',
  'maven.fabricmc.net',
  'maven.minecraftforge.net',
  'files.minecraftforge.net',
  'maven.neoforged.net',
  'api.adoptium.net',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const ALLOWED_HOST_SET = new Set(ALLOWED_HOSTS);

function assertAllowedUrl(url) {
  if (typeof url !== 'string' || /[\u0000-\u0020\\]/.test(url)) {
    throw new Error('Only an HTTPS URL is allowed');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error('Invalid download URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== '443')
  ) {
    throw new Error('Only an HTTPS URL without credentials or custom port is allowed');
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOST_SET.has(host)) {
    throw new Error(`Download host is not allowed: ${host || '<empty>'}`);
  }
  return parsed;
}

function isAllowedUrl(url) {
  try {
    assertAllowedUrl(url);
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeNonNegativeInteger(value, fallback, name, { allowZero = true } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return value;
}

function normalizeTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 24 * 60 * 60 * 1000) {
    throw new TypeError('timeout must be a positive safe integer');
  }
  return value;
}

function normalizeMaxRedirects(value) {
  if (value === undefined || value === null) return 5;
  if (!Number.isSafeInteger(value) || value < 0 || value > 20) {
    throw new TypeError('maxRedirects must be an integer between 0 and 20');
  }
  return value;
}

function normalizeHash(value, algorithm, field) {
  if (value === undefined || value === null || value === '') return null;
  const length = algorithm === 'sha1' ? 40 : 64;
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value)) {
    throw new Error(`${field} must be a strict ${algorithm.toUpperCase()} hex digest`);
  }
  return value.toLowerCase();
}

function normalizeExpectedSize(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('size must be a non-negative safe integer');
  }
  return value;
}

function hashFile(file, algorithm) {
  if (!['sha1', 'sha256'].includes(algorithm)) throw new TypeError('unsupported hash algorithm');
  if (typeof file !== 'string' || file.includes('\0')) return Promise.reject(new TypeError('invalid hash file'));
  return new Promise((resolve, reject) => {
    let st;
    try {
      st = fs.lstatSync(file);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('not a regular file');
    } catch (error) {
      reject(error);
      return;
    }
    const h = crypto.createHash(algorithm);
    const s = fs.createReadStream(file);
    let settled = false;
    let ended = false;
    const cleanup = () => {
      s.removeListener('data', onData);
      s.removeListener('end', onEnd);
      s.removeListener('error', onError);
      s.removeListener('close', onClose);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      try { h.update(chunk); } catch (error) { finish(error); }
    };
    const onEnd = () => {
      ended = true;
      if (s.closed === true) finish(null, h.digest('hex'));
    };
    const onError = error => finish(error || new Error('hash read error'));
    const onClose = () => {
      if (!ended) finish(new Error('hash stream closed before completion'));
      else finish(null, h.digest('hex'));
    };
    s.on('data', onData);
    s.once('end', onEnd);
    s.once('error', onError);
    s.once('close', onClose);
  });
}

function sha1File(file) {
  return hashFile(file, 'sha1');
}

function sha256File(file) {
  return hashFile(file, 'sha256');
}

function parseContentLength(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value) || typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('invalid Content-Length');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid Content-Length');
  return length;
}

function isWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative)
  );
}

function assertNoSymlinkComponents(root, target, { includeTarget = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  let current = resolvedRoot;
  try {
    const rootStat = fs.lstatSync(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('destination root is not a directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const relative = path.relative(resolvedRoot, includeTarget ? resolvedTarget : path.dirname(resolvedTarget));
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('destination escapes its root');
  }
  const parts = relative ? relative.split(path.sep) : [];
  if (!includeTarget) parts.pop();
  for (const part of parts) {
    if (!part || part === '.') continue;
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) throw new Error('symlink in destination path is not allowed');
      if (!st.isDirectory() && current !== resolvedTarget) throw new Error('destination parent is not a directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (includeTarget) {
    try {
      const st = fs.lstatSync(resolvedTarget);
      if (st.isSymbolicLink()) throw new Error('symlink destination is not allowed');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function unlinkAsync(file) {
  return new Promise((resolve, reject) => {
    fs.unlink(file, error => error ? reject(error) : resolve());
  });
}

async function cleanupFile(file) {
  if (!file) return true;
  const retryDelays = [10, 25, 50, 100, 200, 400, 800, 1000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      await unlinkAsync(file);
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return true;
      const retryable = error && ['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN'].includes(error.code);
      if (!retryable || attempt === retryDelays.length) return false;
      await waitMs(retryDelays[attempt]);
    }
  }
  return false;
}

function openHttpsResponse(parsed, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('request timeout'));
  return new Promise((resolve, reject) => {
    let request = null;
    let response = null;
    let settled = false;
    let timer = null;

    const finishWithError = error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (response) {
        try { response.destroy(); } catch (_) {}
      }
      if (request) {
        try { request.destroy(); } catch (_) {}
      }
      reject(error);
    };

    const options = {
      protocol: 'https:',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      rejectUnauthorized: true,
      servername: parsed.hostname,
    };

    try {
      timer = setTimeout(() => finishWithError(new Error('request timeout')), remaining);
      request = https.get(parsed.toString(), options, res => {
        if (settled) {
          try { res.resume(); } catch (_) {}
          return;
        }
        response = res;
        if (typeof res.pause === 'function') res.pause();
        if (typeof res.setTimeout === 'function') {
          res.setTimeout(remaining, () => finishWithError(new Error('response timeout')));
        }
        resolve({ request, response: res, timer: () => { if (timer) clearTimeout(timer); timer = null; } });
      });
      request.once('error', finishWithError);
      if (typeof request.setTimeout === 'function') request.setTimeout(remaining, () => finishWithError(new Error('request timeout')));
    } catch (error) {
      finishWithError(error);
    }
  });
}

function drainResponse(response, release, deadline) {
  if (!response) return Promise.resolve();
  return new Promise(resolve => {
    if (response.destroyed && response.readableEnded !== true) {
      release();
      resolve();
      return;
    }
    let done = false;
    let ended = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      release();
      resolve();
    };
    const onEnd = () => { ended = true; finish(); };
    response.once('end', onEnd);
    response.once('aborted', finish);
    response.once('error', finish);
    response.once('close', () => { if (!ended) finish(); });
    if (response.readableEnded === true || response.complete === true) {
      ended = true;
      finish();
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      try { response.destroy(new Error('redirect response timeout')); } catch (_) {}
      finish();
    } else {
      timer = setTimeout(() => {
        try { response.destroy(new Error('redirect response timeout')); } catch (_) {}
        finish();
      }, remaining);
    }
    try { response.resume(); } catch (_) { finish(); }
  });
}

function readResponseBuffer(response, maxBytes, release) {
  return new Promise((resolve, reject) => {
    if (response.destroyed && response.readableEnded !== true) {
      release();
      reject(new Error('response closed before completion'));
      return;
    }
    const chunks = [];
    let received = 0;
    let settled = false;
    let ended = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      release();
      response.removeListener('data', onData);
      response.removeListener('end', onEnd);
      response.removeListener('aborted', onError);
      response.removeListener('error', onError);
      response.removeListener('close', onClose);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > maxBytes) {
        const error = new Error('response exceeds maximum size');
        try { response.destroy(); } catch (_) {}
        finish(error);
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => { ended = true; finish(null, Buffer.concat(chunks, received)); };
    const onError = error => finish(error || new Error('response error'));
    const onClose = () => { if (!ended) finish(new Error('response closed before completion')); };

    response.on('data', onData);
    response.once('end', onEnd);
    response.once('aborted', onError);
    response.once('error', onError);
    response.once('close', onClose);
    try { response.resume(); } catch (error) { onError(error); }
  });
}

function normalizeDownloadIntegrity(options) {
  return {
    sha1: normalizeHash(options.sha1, 'sha1', 'sha1'),
    sha256: normalizeHash(options.sha256, 'sha256', 'sha256'),
    size: normalizeExpectedSize(options.size),
  };
}

async function verifyFile(file, integrity = {}) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('not a regular file');
  const expectedSize = integrity.size === undefined ? null : integrity.size;
  if (expectedSize !== null && st.size !== expectedSize) {
    throw new Error(`size mismatch: expected ${expectedSize}, got ${st.size}`);
  }
  if (integrity.sha1) {
    const actual = await sha1File(file);
    if (actual !== integrity.sha1) throw new Error('SHA-1 mismatch');
  }
  if (integrity.sha256) {
    const actual = await sha256File(file);
    if (actual !== integrity.sha256) throw new Error('SHA-256 mismatch');
  }
  return st.size;
}

function resolveRedirect(location, current) {
  if (Array.isArray(location) || typeof location !== 'string' || !location) {
    throw new Error('redirect without a valid Location header');
  }
  const next = new URL(location, current);
  assertAllowedUrl(next.toString());
  return next.toString();
}

async function requestBufferWithRedirects(url, options) {
  const maxBytes = normalizeNonNegativeInteger(options.maxBytes, DEFAULT_RESPONSE_MAX_BYTES, 'maxBytes');
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? options.timeout, DEFAULT_TIMEOUT_MS);
  const maxRedirects = normalizeMaxRedirects(options.maxRedirects);
  const deadline = Date.now() + timeoutMs;
  let current = assertAllowedUrl(url).toString();
  let redirects = 0;

  for (;;) {
    const parsed = assertAllowedUrl(current);
    const opened = await openHttpsResponse(parsed, deadline);
    const { response } = opened;
    const responseHeaders = response.headers || {};
    const status = response.statusCode;
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (redirects >= maxRedirects) {
        response.resume();
        await drainResponse(response, opened.timer, deadline);
        throw new Error('Too many redirects');
      }
      let next;
      try {
        next = resolveRedirect(responseHeaders.location, parsed);
      } catch (error) {
        await drainResponse(response, opened.timer, deadline);
        throw error;
      }
      await drainResponse(response, opened.timer, deadline);
      current = next;
      redirects++;
      continue;
    }
    if (status !== 200) {
      await drainResponse(response, opened.timer, deadline);
      throw new Error(`HTTP ${status}`);
    }
    let declared;
    try {
      declared = parseContentLength(responseHeaders['content-length']);
    } catch (error) {
      await drainResponse(response, opened.timer, deadline);
      throw error;
    }
    if (declared !== null && declared > maxBytes) {
      await drainResponse(response, opened.timer, deadline);
      throw new Error('response exceeds maximum size');
    }
    const buffer = await readResponseBuffer(response, maxBytes, opened.timer);
    return { buffer, finalUrl: parsed.toString(), headers: responseHeaders };
  }
}

function fetchUrl(url, options = {}) {
  return requestBufferWithRedirects(url, {
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs ?? options.timeout,
    maxRedirects: options.maxRedirects,
  });
}

function fetchJson(url, options = {}) {
  return fetchUrl(url, {
    ...options,
    maxBytes: options.maxBytes === undefined ? DEFAULT_RESPONSE_MAX_BYTES : options.maxBytes,
    timeoutMs: options.timeoutMs ?? options.timeout ?? DEFAULT_TIMEOUT_MS,
  }).then(({ buffer }) => JSON.parse(buffer.toString('utf8')));
}

function makePartPath(dest) {
  return `${dest}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.part`;
}

function writeResponseToPart(response, partPath, {
  maxBytes,
  expectedSize,
  declaredSize,
  onProgress,
  displayDest,
  release,
}) {
  return new Promise((resolve, reject) => {
    const streamLimit = expectedSize === null ? maxBytes : Math.min(maxBytes, expectedSize);
    if (response.destroyed && response.readableEnded !== true) {
      release();
      reject(new Error('download response closed before completion'));
      return;
    }

    let output = null;
    let done = 0;
    let state = 'open';
    let responseEnded = false;
    let failure = null;
    let closeWait = null;
    let releaseCalled = false;

    const releaseOnce = () => {
      if (releaseCalled) return;
      releaseCalled = true;
      try { release(); } catch (_) {}
    };
    const removeResponseListeners = () => {
      response.removeListener('data', onData);
      response.removeListener('end', onEnd);
      response.removeListener('aborted', onError);
      response.removeListener('error', onError);
      response.removeListener('close', onResponseClose);
    };
    const waitForOutputClose = () => {
      if (closeWait) return closeWait;
      if (!output || output.closed === true) return Promise.resolve();
      closeWait = new Promise(resolveClose => {
        const onCloseWait = () => {
          output.removeListener('close', onCloseWait);
          resolveClose();
        };
        output.once('close', onCloseWait);
        if (output.closed === true) onCloseWait();
      });
      return closeWait;
    };
    const fail = error => {
      if (state !== 'open') return;
      state = 'failing';
      failure = error instanceof Error ? error : new Error(String(error || 'download failed'));
      removeResponseListeners();
      releaseOnce();
      const closed = waitForOutputClose();
      try { response.destroy(); } catch (_) {}
      if (output) {
        try { output.destroy(); } catch (_) {}
      }
      closed.then(() => reject(failure));
    };
    const succeed = () => {
      if (state !== 'open') return;
      if (!responseEnded) {
        fail(new Error('download write stream closed before response completion'));
        return;
      }
      state = 'success';
      removeResponseListeners();
      releaseOnce();
      resolve(done);
    };
    const onData = chunk => {
      if (state !== 'open') return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      done += buf.length;
      if (done > streamLimit) {
        fail(new Error(expectedSize !== null
          ? `download size mismatch: expected ${expectedSize}, got more than ${expectedSize}`
          : 'download exceeds maximum size'));
        return;
      }
      if (onProgress) {
        try {
          onProgress({ dest: displayDest || partPath, done, total: expectedSize ?? declaredSize ?? 0 });
        } catch (error) {
          fail(error);
        }
      }
    };
    const onEnd = () => {
      if (state !== 'open') return;
      responseEnded = true;
      if (expectedSize !== null && done !== expectedSize) {
        fail(new Error(`download size mismatch: expected ${expectedSize}, got ${done}`));
        return;
      }
      if (declaredSize !== null && done !== declaredSize) {
        fail(new Error(`Content-Length mismatch: expected ${declaredSize}, got ${done}`));
      }
    };
    const onError = error => fail(error || new Error('download response error'));
    const onResponseClose = () => {
      if (state === 'open' && !responseEnded) fail(new Error('download closed before completion'));
    };
    const onOutputError = error => fail(error || new Error('download write error'));
    const onOutputClose = () => {
      if (state === 'failing') {
        reject(failure || new Error('download failed'));
        return;
      }
      succeed();
    };

    try {
      output = fs.createWriteStream(partPath, { flags: 'wx' });
    } catch (error) {
      fail(error);
      return;
    }
    output.once('error', onOutputError);
    output.once('close', onOutputClose);
    response.on('data', onData);
    response.once('end', onEnd);
    response.once('aborted', onError);
    response.once('error', onError);
    response.once('close', onResponseClose);
    try {
      response.pipe(output);
    } catch (error) {
      fail(error);
    }
  });
}

async function downloadToPart(url, partPath, options) {
  const { maxBytes, expectedSize, onProgress, displayDest, timeoutMs, maxRedirects } = options;
  const deadline = Date.now() + timeoutMs;
  let current = assertAllowedUrl(url).toString();
  let redirects = 0;

  for (;;) {
    const parsed = assertAllowedUrl(current);
    const opened = await openHttpsResponse(parsed, deadline);
    const { response } = opened;
    const responseHeaders = response.headers || {};
    const status = response.statusCode;
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (redirects >= maxRedirects) {
        await drainResponse(response, opened.timer, deadline);
        throw new Error('Too many redirects');
      }
      let next;
      try {
        next = resolveRedirect(responseHeaders.location, parsed);
      } catch (error) {
        await drainResponse(response, opened.timer, deadline);
        throw error;
      }
      await drainResponse(response, opened.timer, deadline);
      current = next;
      redirects++;
      continue;
    }
    if (status !== 200) {
      await drainResponse(response, opened.timer, deadline);
      throw new Error(`HTTP ${status}`);
    }

    let declaredSize;
    try {
      declaredSize = parseContentLength(responseHeaders['content-length']);
    } catch (error) {
      await drainResponse(response, opened.timer, deadline);
      throw error;
    }
    if (declaredSize !== null && declaredSize > maxBytes) {
      await drainResponse(response, opened.timer, deadline);
      throw new Error('download exceeds maximum size');
    }
    if (expectedSize !== null && declaredSize !== null && declaredSize !== expectedSize) {
      await drainResponse(response, opened.timer, deadline);
      throw new Error(`Content-Length does not match expected size ${expectedSize}`);
    }
    return writeResponseToPart(response, partPath, {
      maxBytes,
      expectedSize,
      declaredSize,
      onProgress,
      displayDest,
      release: opened.timer,
    });
  }
}

async function replacePart(partPath, dest, integrity) {
  let existing = null;
  try { existing = fs.lstatSync(dest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && existing.isSymbolicLink()) throw new Error('refusing to replace symlink destination');
  try {
    fs.renameSync(partPath, dest);
    return;
  } catch (error) {
    if (!existing || existing.isDirectory()) throw error;
    let keepExisting = false;
    if (integrity.size !== null || integrity.sha1 || integrity.sha256) {
      try {
        await verifyFile(dest, integrity);
        keepExisting = true;
      } catch (_) { }
    }
    if (keepExisting) {
      await cleanupFile(partPath);
      return;
    }
    if (!await cleanupFile(dest)) {
      throw new Error('could not replace locked download destination');
    }
    fs.renameSync(partPath, dest);
  }
}

async function downloadFile(url, dest, options = {}) {
  if (
    typeof dest !== 'string'
    || !dest
    || dest.includes('\0')
    || dest.split(/[\\/]+/).some(part => part === '..')
  ) {
    throw new TypeError('invalid download destination');
  }
  const destination = path.resolve(dest);
  const integrity = normalizeDownloadIntegrity(options);
  const requestedMax = options.maxBytes ?? options.maxSize;
  const maxBytes = normalizeNonNegativeInteger(requestedMax, DEFAULT_DOWNLOAD_MAX_BYTES, 'maxBytes');
  if (integrity.size !== null && maxBytes < integrity.size) {
    throw new Error('maxBytes is smaller than the expected file size');
  }
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? options.overallTimeoutMs ?? options.timeout, DEFAULT_DOWNLOAD_TIMEOUT_MS);
  const maxRedirects = normalizeMaxRedirects(options.maxRedirects);
  assertAllowedUrl(url);

  try {
    const st = fs.lstatSync(destination);
    if (st.isSymbolicLink()) throw new Error('refusing to use symlink destination');
    if (!st.isFile()) throw new Error('download destination is not a regular file');
    if (st.size > maxBytes) throw new Error('existing destination exceeds maximum size');
    if (integrity.size !== null || integrity.sha1 || integrity.sha256) {
      const verifiedSize = await verifyFile(destination, integrity);
      if (options.onProgress) options.onProgress({ dest, done: verifiedSize, total: verifiedSize, skipped: true });
      return { path: dest, skipped: true };
    }
  } catch (error) {
    if (error && (error.code === 'ELOOP' || /symlink|not a regular file|not a directory/.test(error.message))) throw error;
  }

  assertNoSymlinkComponents(path.parse(destination).root, destination, { includeTarget: false });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  assertNoSymlinkComponents(path.parse(destination).root, destination, { includeTarget: true });
  assertNoSymlinkComponents(path.dirname(destination), destination, { includeTarget: true });

  const partPath = makePartPath(destination);
  try {
    await downloadToPart(url, partPath, {
      maxBytes,
      expectedSize: integrity.size,
      timeoutMs,
      maxRedirects,
      onProgress: options.onProgress,
      displayDest: dest,
    });
    await verifyFile(partPath, integrity);
    await replacePart(partPath, destination, integrity);
    return { path: dest, skipped: false };
  } catch (error) {
    await cleanupFile(partPath);
    throw error;
  }
}

async function downloadMany(queue, options = {}) {
  if (!Array.isArray(queue)) throw new TypeError('queue must be an array');
  const requestedConcurrency = options.concurrency === undefined ? 8 : options.concurrency;
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency <= 0) {
    throw new TypeError('concurrency must be a positive integer');
  }
  const workers = Math.min(requestedConcurrency, queue.length);
  let nextIndex = 0;
  let done = 0;
  let bytes = 0;
  const errors = [];

  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= queue.length) return;
      const item = queue[index];
      try {
        const result = await downloadFile(item.url, item.path, {
          sha1: item.sha1,
          sha256: item.sha256,
          size: item.size,
          maxBytes: item.maxBytes ?? options.maxBytes,
          timeoutMs: item.timeoutMs ?? options.timeoutMs ?? options.timeout,
          maxRedirects: item.maxRedirects ?? options.maxRedirects,
          onProgress: progress => {
            if (options.onProgress) options.onProgress({ ...progress, file: index + 1, filesTotal: queue.length });
          },
        });
        done++;
        if (!result.skipped) {
          try { bytes += fs.statSync(item.path).size; } catch (_) {}
        }
        if (options.onProgress) options.onProgress({ filesDone: done, filesTotal: queue.length, bytes });
      } catch (error) {
        errors.push({ item, error: String(error && error.message || error) });
      }
    }
  };

  if (workers > 0) await Promise.all(Array.from({ length: workers }, () => worker()));
  return { done, total: queue.length, bytes, errors };
}

module.exports = {
  ALLOWED_HOSTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_RESPONSE_MAX_BYTES,
  DEFAULT_DOWNLOAD_MAX_BYTES,
  assertAllowedUrl,
  isAllowedUrl,
  fetchUrl,
  fetchJson,
  downloadFile,
  downloadMany,
  sha1File,
  sha256File,
  hashFile,
  verifyFile,
  cleanupFile,
};
