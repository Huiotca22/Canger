'use strict';

const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { getSystemInfo } = require('./system');
const { listProfiles, PROFILES } = require('./profiles');
const { findJavaExecutables, selectJava } = require('./java');
const { listVersions } = require('./minecraft');

const HOST = '127.0.0.1';
const DEFAULT_VERSION = '1.20.1';
const MAX_BODY_BYTES = 64 * 1024;
const LAUNCH_RATE_LIMIT = 5;
const LAUNCH_RATE_WINDOW_MS = 60 * 1000;
const PROFILE_IDS = new Set(Object.keys(PROFILES));
const ALLOWED_LAUNCH_FIELDS = new Set([
  'version', 'profile', 'nickname', 'modded',
  'username', 'fabric', 'mods',
]);
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-original-host',
  'x-real-ip',
];

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

const logClients = new Set();
function broadcastLog(line) {
  for (const res of logClients) {
    try { res.write(`data: ${JSON.stringify(String(line).slice(0, 500))}\n\n`); } catch (_) {}
  }
}

function privateLogRoots() {
  const roots = [];
  const configured = process.env.FPS_LAUNCHER_DIR;
  const fallback = path.join(os.homedir(), '.fps-launcher');
  if (configured) {
    roots.push(configured);
    roots.push(path.resolve(configured));
  }
  roots.push(fallback);
  return [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length);
}

const PRIVATE_LOG_ROOTS = privateLogRoots();
function broadcastLaunchLog(line) {
  let safe = String(line);
  for (const root of PRIVATE_LOG_ROOTS) safe = safe.split(root).join('<redacted-path>');
  broadcastLog(safe);
}

function json(res, code, obj) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const limit = Number(maxBytes);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      reject(new HttpError(500, 'Invalid body limit'));
      return;
    }

    const declaredLength = req.headers['content-length'];
    if (declaredLength !== undefined) {
      if (typeof declaredLength !== 'string' || !/^\d+$/.test(declaredLength)) {
        req.resume();
        reject(new HttpError(400, 'Invalid Content-Length'));
        return;
      }
      if (BigInt(declaredLength) > BigInt(limit)) {
        req.resume();
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
    }

    let chunks = [];
    let received = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    };
    const fail = (statusCode, message) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HttpError(statusCode, message));
    };
    const onData = chunk => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > limit) {
        chunks = [];
        fail(413, 'Request body too large');
        req.resume();
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      if (settled) return;
      let parsed;
      try {
        const raw = Buffer.concat(chunks, received).toString('utf8');
        if (!raw.trim()) throw new Error('empty body');
        parsed = JSON.parse(raw);
      } catch (_) {
        fail(400, 'Malformed JSON body');
        return;
      }
      settled = true;
      cleanup();
      resolve(parsed);
    };
    const onAborted = () => fail(400, 'Request body aborted');
    const onError = () => fail(400, 'Request body error');
    const onClose = () => {
      if (!settled) fail(400, 'Request body closed before completion');
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    req.once('close', onClose);
  });
}

function hasRepeatedHeader(req, name) {
  const distinct = req.headersDistinct && req.headersDistinct[name];
  if (Array.isArray(distinct) && distinct.length > 1) return true;
  if (!Array.isArray(req.rawHeaders)) return false;
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (String(req.rawHeaders[i]).toLowerCase() === name) count++;
  }
  return count > 1;
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  let value = address.toLowerCase();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (net.isIP(value) === 4) return value.split('.')[0] === '127';
  return value === '::1';
}

function exactOriginForHost(origin, host) {
  if (typeof origin !== 'string' || typeof host !== 'string' || !origin || !host) return null;
  if (origin.includes(',') || host.includes(',')) return null;
  let parsed;
  try { parsed = new URL(origin); } catch (_) { return null; }
  if (
    parsed.protocol !== 'http:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) return null;
  const canonical = `${parsed.protocol}//${parsed.host}`;
  if (origin.toLowerCase() !== canonical.toLowerCase()) return null;
  if (parsed.host.toLowerCase() !== host.toLowerCase()) return null;
  return canonical;
}

function isLocalRequest(req, expectedPort) {
  if (!req || !req.socket || !req.headers) return false;
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;

  for (const name of FORWARDING_HEADERS) {
    if (Object.prototype.hasOwnProperty.call(req.headers, name)) return false;
  }
  for (const name of ['host', 'origin']) {
    if (hasRepeatedHeader(req, name)) return false;
  }

  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  const hostMatch = /^(localhost|127\.0\.0\.1):(\d+)$/i.exec(host);
  if (!hostMatch) return false;

  const portValue = expectedPort === undefined ? req.socket.localPort : expectedPort;
  if (!/^\d+$/.test(String(portValue))) return false;
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (Number(hostMatch[2]) !== port) return false;

  const origin = req.headers.origin;
  if (origin !== undefined && exactOriginForHost(origin, host) === null) return false;

  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined) {
    if (typeof fetchSite !== 'string' || !['none', 'same-origin', 'same-site', 'cross-site'].includes(fetchSite.toLowerCase())) return false;
    if (fetchSite.toLowerCase() === 'cross-site') return false;
  }
  return true;
}

function requireJsonContentType(req) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)\s*(?:;|$)/i.test(contentType)) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
}

function validateLaunchBody(body) {
  const bad = message => { throw new HttpError(400, message); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Launch body must be a JSON object');

  if (
    Object.prototype.hasOwnProperty.call(body, 'jvmExtra')
    || Object.prototype.hasOwnProperty.call(body, 'instanceDir')
  ) bad('jvmExtra and instanceDir are not allowed');

  if (Object.keys(body).some(key => !ALLOWED_LAUNCH_FIELDS.has(key))) bad('Unknown launch field');

  const version = Object.prototype.hasOwnProperty.call(body, 'version') ? body.version : DEFAULT_VERSION;
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version) || version.includes('..')) {
    bad('Invalid version');
  }

  const profile = Object.prototype.hasOwnProperty.call(body, 'profile')
    ? body.profile
    : getSystemInfo().recommendedProfile;
  if (typeof profile !== 'string' || !PROFILE_IDS.has(profile)) bad('Invalid profile');

  const hasNickname = Object.prototype.hasOwnProperty.call(body, 'nickname');
  const hasUsername = Object.prototype.hasOwnProperty.call(body, 'username');
  if (hasNickname && hasUsername && body.nickname !== body.username) bad('Conflicting nickname and username');
  const nickname = hasNickname ? body.nickname : (hasUsername ? body.username : 'Player');
  if (typeof nickname !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(nickname)) bad('Invalid nickname');

  for (const key of ['modded', 'fabric', 'mods']) {
    if (Object.prototype.hasOwnProperty.call(body, key) && typeof body[key] !== 'boolean') {
      bad(`${key} must be boolean`);
    }
  }
  const hasModded = Object.prototype.hasOwnProperty.call(body, 'modded');
  const legacyModded = body.fabric === true || body.mods === true;
  if (hasModded && body.modded === false && legacyModded) bad('Conflicting modded flags');
  const modded = hasModded ? body.modded : legacyModded;

  return { version, profile, nickname, modded };
}

async function handleLaunch(options) {
  const { prepareLaunch } = require('./prepare');
  const launcher = require('./launcher');
  const { cmd, java, fabric } = await prepareLaunch({
    version: options.version,
    profile: options.profile,
    username: options.nickname,
    fabric: options.modded,
    onLog: broadcastLaunchLog,
  });
  broadcastLaunchLog(`[launcher] java major ${java.major}`);
  const child = await launcher.launch(cmd, { onLog: broadcastLaunchLog, waitForLaunch: true });
  if (typeof launcher.waitForSpawn === 'function') await launcher.waitForSpawn(child);
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error('Java process did not start');
  }
  broadcastLaunchLog(`[launcher] started pid=${child.pid}`);
  return {
    child,
    response: {
      pid: child.pid,
      ramMb: cmd.fps.ramMb,
      fabric: fabric ? fabric.loaderVersion : null,
    },
  };
}

function publicJavaInfo(java) {
  return java ? { major: java.major } : null;
}

function requestPath(req) {
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('#')) {
    throw new HttpError(400, 'Invalid request target');
  }
  return new URL(req.url, `http://${HOST}`).pathname;
}

function setSecurityHeaders(res) {
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function startServer(port = 17890) {
  const listenPort = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port;
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new TypeError('port must be an integer between 0 and 65535');
  }

  let launchInProgress = false;
  const activeChildren = new Set();
  const launchAttempts = [];

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, server, {
      launchInProgress: () => launchInProgress,
      setLaunchInProgress: value => { launchInProgress = value; },
      activeChildren,
      launchAttempts,
    }).catch(error => {
      if (res.writableEnded || res.destroyed) return;
      if (error instanceof HttpError) return json(res, error.statusCode, { error: error.message });
      console.error('[server] request failed:', error && error.message ? error.message : error);
      return json(res, 500, { error: 'Internal server error' });
    });
  });

  server.listen({ port: listenPort, host: HOST }, () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : listenPort;
    console.log(`FPS launcher backend on http://${HOST}:${actualPort}`);
  });
  return server;
}

async function handleHttpRequest(req, res, server, state) {
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : req.socket.localPort;
  if (!isLocalRequest(req, actualPort)) {
    req.resume();
    return json(res, 403, { error: 'Forbidden: local requests only' });
  }

  setSecurityHeaders(res);
  const corsOrigin = req.headers.origin === undefined ? null : exactOriginForHost(req.headers.origin, req.headers.host);
  if (corsOrigin) res.setHeader('Access-Control-Allow-Origin', corsOrigin);

  const pathname = requestPath(req);
  if (req.method === 'OPTIONS') {
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (pathname === '/api/system' && req.method === 'GET') return json(res, 200, getSystemInfo());
  if (pathname === '/api/profiles' && req.method === 'GET') return json(res, 200, listProfiles());
  if (pathname === '/api/java' && req.method === 'GET') {
    const found = findJavaExecutables();
    return json(res, 200, {
      found: found.map(publicJavaInfo),
      selected_1_20: publicJavaInfo(selectJava('1.20.1', found)),
      selected_1_8: publicJavaInfo(selectJava('1.8.9', found)),
    });
  }
  if (pathname === '/api/versions' && req.method === 'GET') return json(res, 200, await listVersions());
  if (pathname === '/api/logs' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    logClients.add(res);
    res.once('close', () => logClients.delete(res));
    return;
  }

  if (pathname === '/api/launch' && req.method === 'POST') {
    requireJsonContentType(req);
    const body = await readBody(req);
    const options = validateLaunchBody(body);

    if (state.launchInProgress() || state.activeChildren.size > 0) {
      return json(res, 409, { error: 'Launch already in progress' });
    }

    const now = Date.now();
    while (state.launchAttempts.length > 0 && state.launchAttempts[0] <= now - LAUNCH_RATE_WINDOW_MS) {
      state.launchAttempts.shift();
    }
    if (state.launchAttempts.length >= LAUNCH_RATE_LIMIT) {
      const retryAfter = Math.max(1, Math.ceil((state.launchAttempts[0] + LAUNCH_RATE_WINDOW_MS - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return json(res, 429, { error: 'Too many launch requests' });
    }
    state.launchAttempts.push(now);

    state.setLaunchInProgress(true);
    try {
      const { child, response } = await handleLaunch(options);
      state.activeChildren.add(child);
      const forget = () => state.activeChildren.delete(child);
      child.once('exit', forget);
      child.once('error', forget);
      child.once('close', forget);
      return json(res, 200, { ok: true, ...response });
    } finally {
      state.setLaunchInProgress(false);
    }
  }

  return json(res, 404, { error: 'Not found' });
}

module.exports = {
  startServer,
  handleLaunch,
  broadcastLog,
  isLocalRequest,
  readBody,
  validateLaunchBody,
  HOST,
  MAX_BODY_BYTES,
};
