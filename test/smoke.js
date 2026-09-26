'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { getSystemInfo, recommendRam } = require('../src/system');
const { getFpsJvmArgs } = require('../src/jvm');
const {
  adoptiumMetadataUrl,
  parseAdoptiumPackage,
  adoptiumArchiveType,
  extractTarGz,
  ensureJava,
} = require('../src/java');
const { getProfile } = require('../src/profiles');
const { optimizeOptionsTxt } = require('../src/options');
const { validateModFilename } = require('../src/mods');
const { buildLaunchCommand, waitForSpawn } = require('../src/launcher');
const { buildGameArgs, buildJvmArgsFromMeta, libApplies, ruleApplies } = require('../src/minecraft');
const { assertAllowedUrl, isAllowedUrl, downloadFile, fetchUrl } = require('../src/downloader');
const { extractZip } = require('../src/unzip');
const {
  startServer,
  isLocalRequest,
  validateLaunchBody,
  HOST,
  MAX_BODY_BYTES,
} = require('../src/server');
const optionsModule = require('../src/options');

let n = 0;
function ok(name, fn) {
  try { fn(); n++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}: ${e.message}`); process.exitCode = 1; }
}

async function okAsync(name, fn) {
  try { await fn(); n++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}: ${e.message}`); process.exitCode = 1; }
}

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
  });
}

function crc32ForTest(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZipForTest(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8');
    const raw = Buffer.isBuffer(item.data) ? item.data : Buffer.from(String(item.data));
    const method = item.method || 0;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = item.crc === undefined ? crc32ForTest(raw) : item.crc;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([local, name, compressed]);
    localParts.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(item.externalAttrs || 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, name]));
    offset += localRecord.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

function makeTarForTest(entries) {
  const blocks = [];
  for (const item of entries) {
    const header = Buffer.alloc(512);
    const name = Buffer.from(String(item.name), 'utf8');
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(String(item.data || ''));
    const linkname = Buffer.from(String(item.linkname || ''), 'utf8');
    name.copy(header, 0, 0, Math.min(name.length, 100));
    header.write(`${(item.mode == null ? 0o644 : item.mode).toString(8).padStart(7, '0')} `, 100, 'ascii');
    header.write('0000000 ', 108, 'ascii');
    header.write('0000000 ', 116, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')} `, 124, 'ascii');
    header.write('00000000000 ', 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write(String(item.type || '0'), 156, 'ascii');
    linkname.copy(header, 157, 0, Math.min(linkname.length, 100));
    header.write('ustar' + String.fromCharCode(0), 257, 'ascii');
    header.write('00', 263, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}` + String.fromCharCode(0) + ' ', 148, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function makeTarGzForTest(entries) {
  return zlib.gzipSync(makeTarForTest(entries));
}

const CURRENT_ADOPTIUM_WINDOWS_FIXTURE = [{
  binaries: [{
    architecture: 'x64',
    heap_size: 'normal',
    image_type: 'jre',
    jvm_impl: 'hotspot',
    os: 'windows',
    package: {
      checksum: 'bc21a93923103cdaac93ee337b0ae4365e739fde36df823dd456bc67c8a9d352',
      link: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip',
      name: 'OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip',
      size: 43780109,
    },
    project: 'jdk',
  }],
  release_type: 'ga',
  vendor: 'eclipse',
}];

const CURRENT_ADOPTIUM_LINUX_FIXTURE = [{
  binaries: [{
    architecture: 'x64',
    heap_size: 'normal',
    image_type: 'jre',
    jvm_impl: 'hotspot',
    os: 'linux',
    package: {
      checksum: '0b2b640e3046b64c8ec504de0ab9d91bb5610182bda21fad454681ce54d45a62',
      link: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_linux_hotspot_17.0.20.1_1.tar.gz',
      name: 'OpenJDK17U-jre_x64_linux_hotspot_17.0.20.1_1.tar.gz',
      size: 46640574,
    },
    project: 'jdk',
  }],
  release_type: 'ga',
  vendor: 'eclipse',
}];

function installHttpsMock(handlers) {
  const original = https.get;
  const calls = [];
  https.get = (url, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    calls.push(options);
    const handler = handlers.shift();
    if (!handler) throw new Error('unexpected HTTPS request');
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    const response = new PassThrough();
    response.statusCode = handler.statusCode || 200;
    response.headers = { ...(handler.headers || {}) };
    process.nextTick(() => {
      callback(response);
      setImmediate(() => {
        if (handler.hold) return;
        if (handler.location) response.write(Buffer.from('redirect'));
        if (handler.body !== undefined) response.write(Buffer.from(handler.body));
        response.end();
      });
    });
    return request;
  };
  return { calls, restore: () => { https.get = original; } };
}

function localRequest(server, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const payload = body === undefined ? null : Buffer.from(body);
  const finalHeaders = { ...headers };
  if (payload && finalHeaders['Content-Length'] === undefined && finalHeaders['Transfer-Encoding'] === undefined) {
    finalHeaders['Content-Length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: HOST,
      port: server.address().port,
      method,
      path,
      headers: finalHeaders,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

console.log('== FPS backend smoke ==');

ok('system info', () => {
  const s = getSystemInfo();
  assert(s.ramTotalMb > 0, 'ram');
  assert(s.cpu.cores > 0, 'cpu');
  assert(['potato', 'balanced', 'performance', 'maxfps'].includes(s.recommendedProfile), 'profile=' + s.recommendedProfile);
  console.log(`    CPU=${s.cpu.model} RAM=${s.ramTotalMb}MB GPU=${s.gpu.name} => ${s.recommendedProfile} (score ${s.score})`);
});

ok('ram never exceeds safe limits', () => {
  for (const total of [4096, 8192, 16384, 32768]) {
    const r = recommendRam({ totalMb: total, modded: false, profile: 'potato' });
    assert(r <= total - 2048, `ram ${r} too big for total ${total}`);
    assert(r >= 1024, 'ram too small');
  }
});

ok('potato JVM flags: no ZGC, capped GC threads', () => {
  const { args, ramMb } = getFpsJvmArgs({ profile: 'potato', javaMajor: 17, cpuCores: 4, totalRamMb: 16384 });
  const s = args.join(' ');
  assert(s.includes('-Xmx'), 'has Xmx');
  assert(s.includes('-XX:+UseG1GC'), 'potato must use G1GC');
  assert(!s.includes('UseZGC'), 'potato must NOT use ZGC');
  assert(ramMb <= 3072, 'potato ram sane, got ' + ramMb);
});

ok('maxfps on strong CPU uses ZGC only on Java 21+', () => {
  const { args: args21 } = getFpsJvmArgs({ profile: 'maxfps', javaMajor: 21, cpuCores: 8, ramMb: 4096 });
  assert(args21.join(' ').includes('UseZGC'), 'expected ZGC on Java 21, got: ' + args21.join(' '));
  assert(args21.join(' ').includes('-XX:+ZGenerational'), 'expected ZGenerational on Java 21');

  const { args: args17 } = getFpsJvmArgs({ profile: 'maxfps', javaMajor: 17, cpuCores: 8, ramMb: 4096 });
  assert(!args17.join(' ').includes('-XX:+ZGenerational'), 'ZGenerational must NOT be generated for Java 17');
  assert(args17.join(' ').includes('-XX:+UseG1GC'), 'Java 17 must fallback to G1GC');
});

ok('libApplies and ruleApplies OS and arch handling', () => {
  const libWithOsxDisallow = {
    rules: [
      { action: 'allow' },
      { action: 'disallow', os: { name: 'osx' } },
    ],
  };
  if (process.platform === 'win32' || process.platform === 'linux') {
    assert.strictEqual(libApplies(libWithOsxDisallow), true, 'disallow osx should allow on windows/linux');
  } else if (process.platform === 'darwin') {
    assert.strictEqual(libApplies(libWithOsxDisallow), false, 'disallow osx should disallow on darwin');
  }

  const origArch = os.arch;
  try {
    os.arch = () => 'ia32';
    assert.strictEqual(ruleApplies({ action: 'allow', os: { arch: 'x86' } }), true, 'x86 should match ia32');
    assert.strictEqual(ruleApplies({ action: 'allow', os: { arch: 'x64' } }), false, 'x64 should not match ia32');
  } finally {
    os.arch = origArch;
  }
});

ok('no duplicate -Xmx from mojang meta', () => {
  const fakeMeta = {
    id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    assetIndex: { id: '5' },
    arguments: {
      jvm: [
        '-Xmx2G',
        '-javaagent:attacker.jar',
        '-agentpath:attacker.dll',
        '-XX:OnError=calc.exe',
        '${classpath}',
        '-Dfoo=bar',
        { value: ['-XX:OnOutOfMemoryError=calc.exe', '-Dsafe=yes'] },
      ],
      game: ['--username', '${auth_player_name}'],
    },
  };
  const jvm = buildJvmArgsFromMeta(fakeMeta, { classpath: 'CP' });
  const jvmText = jvm.join(' ');
  assert(!jvmText.includes('-Xmx'), 'meta -Xmx must be filtered, got: ' + jvm);
  assert(!jvmText.includes('-javaagent'), 'meta javaagent must be filtered');
  assert(!jvmText.includes('-agentpath'), 'meta agentpath must be filtered');
  assert(!jvmText.includes('OnError='), 'meta OnError must be filtered');
  assert(!jvmText.includes('OnOutOfMemoryError='), 'meta OnOutOfMemoryError must be filtered');
  assert(jvmText.includes('-Dsafe=yes'), 'safe metadata JVM args must be preserved');
  const game = buildGameArgs(fakeMeta, { auth_player_name: 'Steve' });
  assert(game.includes('Steve'), 'interpolation works');
});

ok('options.txt patched, keybinds kept, potato settings verified', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-test-'));
  fs.writeFileSync(path.join(dir, 'options.txt'), 'key_key.attack:key.mouse.left\nrenderDistance:32\ngraphicsMode:2\n', 'utf8');
  const r = optimizeOptionsTxt(dir, 'potato');
  const txt = fs.readFileSync(r.path, 'utf8');
  assert(txt.includes('key_key.attack:key.mouse.left'), 'keybinds must survive');
  assert(txt.includes('renderDistance:6'), 'potato renderDistance=6, got:\n' + txt);
  assert(txt.includes('maxFps:260'), 'maxFps unlocked');
  assert(txt.includes('graphicsMode:0'), 'potato graphicsMode=0');
  assert(txt.includes('entityShadows:false'), 'potato entityShadows=false');
  assert.strictEqual(optionsModule.GAME_KEY_MAP, undefined, 'GAME_KEY_MAP should be removed');
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('server isLocalRequest blocks CSRF/RCE and spoofing', () => {
  const request = (headers, remoteAddress = '127.0.0.1') => ({
    headers,
    socket: { remoteAddress, localPort: 17890 },
  });

  assert.strictEqual(isLocalRequest(request({ host: 'localhost:17890' })), true);
  assert.strictEqual(isLocalRequest(request({ host: '127.0.0.1:17890' })), true);
  assert.strictEqual(isLocalRequest(request({ host: 'localhost:17890', origin: 'http://localhost:17890' })), true);
  assert.strictEqual(isLocalRequest(request({ host: '127.0.0.1:17890', origin: 'http://127.0.0.1:17890' })), true);
  assert.strictEqual(isLocalRequest(request({ host: 'localhost:17890', origin: 'http://127.0.0.1:17890' })), false);
  assert.strictEqual(isLocalRequest(request({ host: 'localhost:17890', origin: 'http://localhost:17891' })), false);
  assert.strictEqual(isLocalRequest(request({ host: 'localhost:17890', origin: 'http://evil.com' })), false);
  assert.strictEqual(isLocalRequest(request({ host: 'localhost:17890', 'sec-fetch-site': 'cross-site' })), false);
  assert.strictEqual(isLocalRequest(request({ host: 'localhost:17890', forwarded: 'for=127.0.0.1' })), false);
  assert.strictEqual(isLocalRequest(request({ host: 'evil.com:17890', origin: 'http://evil.com:17890' })), false);
  assert.strictEqual(isLocalRequest(request({ host: 'localhost:17891' })), false);
  assert.strictEqual(isLocalRequest(request({ host: 'localhost:17890' }, '192.168.1.10')), false);
  assert.strictEqual(isLocalRequest({ headers: { host: 'localhost:17890' } }), false);
  assert.strictEqual(isLocalRequest(request({ host: 'localhost:17890' }, '::ffff:127.0.0.1')), true);
});

ok('launch command assembles (offline, fake meta)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-inst-'));
  const fakeMeta = {
    id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    assetIndex: { id: '5' },
    arguments: { jvm: ['-Djava.library.path=${natives_directory}', '${classpath}'], game: ['--username', '${auth_player_name}', '--gameDir', '${game_directory}'] },
  };
  const cmd = buildLaunchCommand({
    versionMeta: fakeMeta, classpath: ['a.jar', 'b.jar'], javaExe: process.execPath,
    profileId: 'potato', account: { name: 'Steve' }, instanceDir: dir, nativesPath: path.join(dir, 'natives'),
    jvmExtra: ['-javaagent:attacker.jar'],
  });
  const full = cmd.args.join(' ');
  assert(full.includes('-Xmx'), 'fps flags present');
  assert(!full.includes('attacker.jar'), 'caller-provided JVM options must be ignored');
  assert(full.includes('net.minecraft.client.main.Main'), 'mainClass present');
  assert(full.includes('Steve'), 'username interpolated');
  assert(cmd.args.includes('-cp'), 'classpath flag present');
  assert.throws(() => buildLaunchCommand({
    versionMeta: { ...fakeMeta, mainClass: '-javaagent:metadata.jar' },
    classpath: ['a.jar'], javaExe: process.execPath,
    profileId: 'potato', account: { name: 'Steve' }, instanceDir: dir,
    nativesPath: path.join(dir, 'natives'),
  }), /Unsafe mainClass/);
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('profiles sane', () => {
  const p = getProfile('potato');
  assert(p.game.renderDistance <= 8, 'potato render distance low');
  assert.strictEqual(p.game.graphics, 0, 'potato graphics is 0');
  assert(getProfile('nope').id === 'balanced', 'unknown -> balanced fallback');
});

ok('launch payload is strictly whitelisted', () => {
  assert.deepStrictEqual(
    validateLaunchBody({ version: '1.20.1', profile: 'potato', nickname: 'Steve_1', modded: true }),
    { version: '1.20.1', profile: 'potato', nickname: 'Steve_1', modded: true }
  );
  assert.deepStrictEqual(
    validateLaunchBody({ version: '1.20.1', profile: 'balanced', username: 'Player', fabric: true }),
    { version: '1.20.1', profile: 'balanced', nickname: 'Player', modded: true }
  );
  assert.throws(() => validateLaunchBody({ jvmExtra: ['-javaagent:evil.jar'] }), /not allowed/);
  assert.throws(() => validateLaunchBody({ instanceDir: 'C:\\temp\\owned' }), /not allowed/);
  assert.throws(() => validateLaunchBody({ profile: 'unsafe' }), /Invalid profile/);
  assert.throws(() => validateLaunchBody({ nickname: 'has spaces' }), /Invalid nickname/);
  assert.throws(() => validateLaunchBody({ modded: 'yes' }), /must be boolean/);
});

ok('downloader rejects SSRF and non-HTTPS URL variants', () => {
  assert.strictEqual(isAllowedUrl('https://api.modrinth.com/v2/project/sodium'), true);
  assert.strictEqual(isAllowedUrl('https://maven.minecraftforge.net/net/minecraftforge/forge/'), true);
  for (const url of [
    'http://api.modrinth.com/v2/project/sodium',
    'https://api.modrinth.com.evil.example/v2/project/sodium',
    'https://api.modrinth.com@127.0.0.1/v2/project/sodium',
    'https://api.modrinth.com:444/v2/project/sodium',
    'https://127.0.0.1/v2/project/sodium',
    'https://[::1]/v2/project/sodium',
  ]) assert.strictEqual(isAllowedUrl(url), false, url);
  assert.throws(() => assertAllowedUrl('https://api.modrinth.com\\@evil.example/'), /HTTPS|allowed/);
});

ok('remote mod filenames cannot escape the instance', () => {
  assert.strictEqual(validateModFilename('sodium-fabric-0.6.0.jar'), 'sodium-fabric-0.6.0.jar');
  for (const invalid of ['../evil.jar', '..\\evil.jar', '/absolute.jar', 'C:\\absolute.jar', 'not-a-jar.txt', 'CON.jar']) {
    assert.throws(() => validateModFilename(invalid), /Unsafe mod filename/);
  }
});

ok('Java auto-download requires official SHA-256 metadata', () => {
  const metadataUrl = adoptiumMetadataUrl(17);
  assert.strictEqual(isAllowedUrl(metadataUrl), true);
  const parsed = parseAdoptiumPackage({
    assets: [{
      binary: {
        package: {
          link: 'https://github.com/adoptium/temurin17-binaries/releases/download/test/OpenJDK17.zip',
          checksum: 'a'.repeat(64),
          size: 1234,
        },
      },
    }],
  });
  assert.strictEqual(parsed.sha256, 'a'.repeat(64));
  assert.strictEqual(parsed.size, 1234);
  assert.throws(() => parseAdoptiumPackage({
    assets: [{ binary: { package: { link: 'https://github.com/x', checksum: 'bad', size: 1 } } }],
  }), /SHA-256/);
  assert.throws(() => parseAdoptiumPackage({ assets: [] }), /metadata/);
});

ok('Adoptium current feature-release schema selects the official package', () => {
  const metadataUrl = adoptiumMetadataUrl(17, { platform: 'win32', architecture: 'x64' });
  assert.match(metadataUrl, /\/v3\/assets\/feature_releases\/17\/ga\?/);
  assert(!metadataUrl.includes('/assets/latest/'));
  const parsed = parseAdoptiumPackage(CURRENT_ADOPTIUM_WINDOWS_FIXTURE, { platform: 'win32', architecture: 'x64' });
  assert.deepStrictEqual(parsed, {
    url: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip',
    sha256: 'bc21a93923103cdaac93ee337b0ae4365e739fde36df823dd456bc67c8a9d352',
    size: 43780109,
  });
  assert.strictEqual(adoptiumArchiveType(parsed), 'zip');
  const linuxPackage = parseAdoptiumPackage(CURRENT_ADOPTIUM_LINUX_FIXTURE, { platform: 'linux', architecture: 'x64' });
  assert.strictEqual(adoptiumArchiveType(linuxPackage), 'tar.gz');
  assert.strictEqual(linuxPackage.size, 46640574);
  assert.throws(
    () => parseAdoptiumPackage(CURRENT_ADOPTIUM_WINDOWS_FIXTURE, { platform: 'linux', architecture: 'x64' }),
    /no matching binary package/,
  );
});

ok('TAR.GZ extraction is bounded and materializes safe links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-tar-security-'));
  try {
    const archive = path.join(dir, 'runtime.tar.gz');
    fs.writeFileSync(archive, makeTarGzForTest([
      { name: 'jdk-17/', type: '5', mode: 0o755 },
      { name: 'jdk-17/legal/', type: '5', mode: 0o755 },
      { name: 'jdk-17/legal/java.base/LICENSE', mode: 0o644, data: 'license' },
      { name: 'jdk-17/legal/java.se/', type: '5', mode: 0o755 },
      { name: 'jdk-17/legal/java.se/LICENSE', type: '2', mode: 0o777, linkname: '../java.base/LICENSE' },
    ]));
    const output = path.join(dir, 'out');
    assert.strictEqual(extractTarGz(archive, output), 2);
    assert.strictEqual(fs.readFileSync(path.join(output, 'jdk-17', 'legal', 'java.se', 'LICENSE'), 'utf8'), 'license');
    assert.strictEqual(fs.lstatSync(path.join(output, 'jdk-17', 'legal', 'java.se', 'LICENSE')).isSymbolicLink(), false);

    const unsafe = path.join(dir, 'unsafe.tar.gz');
    fs.writeFileSync(unsafe, makeTarGzForTest([{ name: '../escape', data: 'bad' }]));
    assert.throws(() => extractTarGz(unsafe, path.join(dir, 'unsafe-out')), /unsafe entry path/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

ok('legacy command paths use argv and never shell execution', () => {
  const javaSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'java.js'), 'utf8');
  const launcherSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'launcher.js'), 'utf8');
  assert(!/\bexecSync\s*\(/.test(javaSource), 'java must not use execSync');
  assert(!/\bexecSync\s*\(/.test(launcherSource), 'launcher must not use execSync');
  assert(/spawnSync\(executable, \['-version'\]/.test(javaSource), 'Java probe must pass argv');
  assert(/shell:\s*false/.test(launcherSource), 'launch must explicitly disable shell');
  assert(!/which|exec\s+java|tar\s+-xf/i.test(javaSource), 'Java discovery must not use a shell lookup');
});

ok('ZIP extraction rejects slip, symlink, duplicate flatten targets and bombs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-zip-security-'));
  try {
    const normal = path.join(dir, 'normal.zip');
    fs.writeFileSync(normal, makeZipForTest([{ name: 'folder/hello.txt', data: 'hello' }]));
    const output = path.join(dir, 'out');
    assert.strictEqual(extractZip(normal, output), 1);
    assert.strictEqual(fs.readFileSync(path.join(output, 'folder', 'hello.txt'), 'utf8'), 'hello');

    const slip = path.join(dir, 'slip.zip');
    fs.writeFileSync(slip, makeZipForTest([{ name: '../escape.txt', data: 'bad' }]));
    assert.throws(() => extractZip(slip, path.join(dir, 'slip-out')), /unsafe entry path|slip/i);

    const duplicate = path.join(dir, 'duplicate.zip');
    fs.writeFileSync(duplicate, makeZipForTest([
      { name: 'a/native.dll', data: 'a' },
      { name: 'b/native.dll', data: 'b' },
    ]));
    assert.throws(() => extractZip(duplicate, path.join(dir, 'duplicate-out'), { flatten: true }), /duplicate destination/);

    const bomb = path.join(dir, 'bomb.zip');
    fs.writeFileSync(bomb, makeZipForTest([{ name: 'bomb.txt', data: 'A'.repeat(10000), method: 8 }]));
    assert.throws(() => extractZip(bomb, path.join(dir, 'bomb-out'), { limits: { maxCompressionRatio: 2 } }), /compression ratio/);

    const symlink = path.join(dir, 'symlink.zip');
    fs.writeFileSync(symlink, makeZipForTest([{ name: 'link', data: 'target', externalAttrs: (0o120777 << 16) >>> 0 }]));
    assert.throws(() => extractZip(symlink, path.join(dir, 'symlink-out')), /symlink/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  await okAsync('ensureJava installs the selected OS archive only after validation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-ensure-java-'));
    const previousBase = process.env.FPS_LAUNCHER_DIR;
    const windows = process.platform === 'win32';
    const javaName = windows ? 'java.exe' : 'java';
    const fakeJava = Buffer.from('fake java executable');
    const archive = windows
      ? makeZipForTest([{ name: `jdk-17/bin/${javaName}`, data: fakeJava }])
      : makeTarGzForTest([{ name: `jdk-17/bin/${javaName}`, mode: 0o755, data: fakeJava }]);
    const source = windows ? CURRENT_ADOPTIUM_WINDOWS_FIXTURE : CURRENT_ADOPTIUM_LINUX_FIXTURE;
    const metadata = JSON.parse(JSON.stringify(source));
    const packageInfo = metadata[0].binaries[0].package;
    packageInfo.checksum = crypto.createHash('sha256').update(archive).digest('hex');
    packageInfo.size = archive.length;
    process.env.FPS_LAUNCHER_DIR = root;
    try {
      const result = await ensureJava('1.20.1', {
        findJava: () => [],
        fetchJson: async url => {
          assert.match(url, /feature_releases/);
          return metadata;
        },
        downloadFile: async (url, destination) => {
          assert.strictEqual(url, packageInfo.link);
          fs.writeFileSync(destination, archive);
          return { path: destination, skipped: false };
        },
        validateJava: () => true,
        probeJava: () => 17,
      });
      assert.strictEqual(result.downloaded, true);
      assert.strictEqual(result.major, 17);
      assert(fs.existsSync(result.path));
      assert(!fs.readdirSync(path.dirname(result.path)).some(name => name.endsWith('.part')));
    } finally {
      if (previousBase === undefined) delete process.env.FPS_LAUNCHER_DIR;
      else process.env.FPS_LAUNCHER_DIR = previousBase;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await okAsync('spawn readiness rejects an asynchronous spawn error', async () => {
    const child = new EventEmitter();
    const ready = waitForSpawn(child);
    const error = new Error('simulated spawn failure');
    error.code = 'ENOENT';
    child.emit('error', error);
    await assert.rejects(ready, /simulated spawn failure/);

    const started = new EventEmitter();
    const startedReady = waitForSpawn(started);
    started.emit('spawn');
    assert.strictEqual(await startedReady, started);
  });

  await okAsync('downloader validates every redirect, hash/size and removes parts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-download-security-'));
    const good = Buffer.from('hello');
    const goodSha256 = crypto.createHash('sha256').update(good).digest('hex');
    try {
      const evilRedirect = installHttpsMock([{
        statusCode: 302,
        headers: { location: 'https://evil.example/payload' },
      }]);
      try {
        await assert.rejects(
          downloadFile('https://api.modrinth.com/start', path.join(dir, 'blocked.bin')),
          /host is not allowed/,
        );
        assert.strictEqual(evilRedirect.calls.length, 1);
      } finally {
        evilRedirect.restore();
      }

      const metadataMock = installHttpsMock([{ body: '{"ok":true}' }]);
      try {
        const metadata = await fetchUrl('https://api.modrinth.com/metadata');
        assert.strictEqual(metadata.buffer.toString('utf8'), '{"ok":true}');
      } finally {
        metadataMock.restore();
      }

      const dest = path.join(dir, 'good.bin');
      const allowedRedirect = installHttpsMock([
        { statusCode: 302, headers: { location: 'https://cdn.modrinth.com/file' } },
        { headers: { 'content-length': String(good.length) }, body: good },
      ]);
      try {
        const result = await downloadFile('https://api.modrinth.com/start', dest, {
          size: good.length,
          sha256: goodSha256,
        });
        assert.strictEqual(result.skipped, false);
        assert.deepStrictEqual(allowedRedirect.calls.map(call => call.hostname), ['api.modrinth.com', 'cdn.modrinth.com']);
        assert.deepStrictEqual(fs.readFileSync(dest), good);
        assert(!fs.readdirSync(dir).some(name => name.endsWith('.part')), 'successful download left a part file');
      } finally {
        allowedRedirect.restore();
      }

      const mismatchDest = path.join(dir, 'mismatch.bin');
      const mismatch = installHttpsMock([{ headers: { 'content-length': '5' }, body: good }]);
      const originalUnlink = fs.unlink;
      let unlinkAttempts = 0;
      fs.unlink = function(file, callback) {
        unlinkAttempts++;
        if (unlinkAttempts === 1) {
          const error = new Error('simulated Windows lock');
          error.code = 'EPERM';
          process.nextTick(() => callback(error));
          return;
        }
        return originalUnlink.call(fs, file, callback);
      };
      try {
        await assert.rejects(
          downloadFile('https://api.modrinth.com/mismatch', mismatchDest, {
            size: good.length,
            sha256: crypto.createHash('sha256').update(Buffer.from('other')).digest('hex'),
          }),
          /SHA-256 mismatch/,
        );
        assert.strictEqual(fs.existsSync(mismatchDest), false);
        assert(!fs.readdirSync(dir).some(name => name.endsWith('.part')), 'hash mismatch left a part file');
        assert(unlinkAttempts >= 2, 'part cleanup did not retry EPERM');
      } finally {
        fs.unlink = originalUnlink;
        mismatch.restore();
      }

      const sizeDest = path.join(dir, 'size.bin');
      const wrongSize = installHttpsMock([{ headers: { 'content-length': '5' }, body: good }]);
      try {
        await assert.rejects(
          downloadFile('https://api.modrinth.com/size', sizeDest, { size: 4 }),
          /Content-Length|size mismatch/,
        );
        assert.strictEqual(fs.existsSync(sizeDest), false);
      } finally {
        wrongSize.restore();
      }

      const tooLargeDest = path.join(dir, 'too-large.bin');
      const tooLarge = installHttpsMock([{ body: good }]);
      try {
        await assert.rejects(
          downloadFile('https://api.modrinth.com/too-large', tooLargeDest, { maxBytes: 3 }),
          /exceeds maximum size/,
        );
        assert.strictEqual(fs.existsSync(tooLargeDest), false);
        assert(!fs.readdirSync(dir).some(name => name.endsWith('.part')), 'size limit left a part file');
      } finally {
        tooLarge.restore();
      }

      const timeoutDest = path.join(dir, 'timeout.bin');
      const timeoutMock = installHttpsMock([{ hold: true }]);
      try {
        await assert.rejects(
          downloadFile('https://api.modrinth.com/timeout', timeoutDest, { timeoutMs: 25 }),
          /timeout|closed before completion/,
        );
        assert.strictEqual(fs.existsSync(timeoutDest), false);
        assert(!fs.readdirSync(dir).some(name => name.endsWith('.part')), 'timeout left a part file');
      } finally {
        timeoutMock.restore();
      }

      await assert.rejects(
        downloadFile('https://api.modrinth.com/bad-hash', path.join(dir, 'bad-hash.bin'), { sha1: 'not-a-hash' }),
        /strict SHA1/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await okAsync('server binds only to IPv4 loopback', async () => {
    const server = startServer(0);
    try {
      await waitForListening(server);
      const address = server.address();
      assert.strictEqual(address.address, HOST, `unexpected bind address: ${address.address}`);
      assert.strictEqual(address.family, 'IPv4');
    } finally {
      await closeServer(server);
    }
  });

  await okAsync('launch rejects malformed/oversized JSON and unsafe fields', async () => {
    const server = startServer(0);
    try {
      await waitForListening(server);
      const post = body => localRequest(server, {
        method: 'POST',
        path: '/api/launch',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      const malformed = await post('{"version":');
      assert.strictEqual(malformed.status, 400, malformed.body);
      const empty = await post('');
      assert.strictEqual(empty.status, 400, empty.body);
      const oversized = await post('x'.repeat(MAX_BODY_BYTES + 1));
      assert.strictEqual(oversized.status, 413, oversized.body);

      for (const body of [
        JSON.stringify({ jvmExtra: ['-javaagent:evil.jar'] }),
        JSON.stringify({ instanceDir: 'C:\\Users\\victim\\owned' }),
      ]) {
        const rejected = await post(body);
        assert.strictEqual(rejected.status, 400, rejected.body);
        assert.match(rejected.body, /not allowed/);
      }
    } finally {
      await closeServer(server);
    }
  });

  await okAsync('server reports an asynchronous spawn error instead of HTTP 200', async () => {
    const preparePath = require.resolve('../src/prepare');
    const launcherPath = require.resolve('../src/launcher');
    const prepareModule = require(preparePath);
    const launcherModule = require(launcherPath);
    const originalPrepareLaunch = prepareModule.prepareLaunch;
    const originalLaunch = launcherModule.launch;
    const fakeChild = new EventEmitter();
    fakeChild.pid = 424242;
    prepareModule.prepareLaunch = async () => ({
      cmd: { fps: { ramMb: 1024 } },
      java: { major: 17 },
      fabric: null,
    });
    launcherModule.launch = () => {
      process.nextTick(() => fakeChild.emit('error', new Error('simulated spawn failure')));
      return fakeChild;
    };
    const server = startServer(0);
    try {
      await waitForListening(server);
      const response = await localRequest(server, {
        method: 'POST',
        path: '/api/launch',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '1.20.1', profile: 'balanced', nickname: 'Player' }),
      });
      assert.notStrictEqual(response.status, 200, response.body);
      assert.strictEqual(response.status, 500, response.body);
      assert.match(response.body, /error/);
    } finally {
      prepareModule.prepareLaunch = originalPrepareLaunch;
      launcherModule.launch = originalLaunch;
      await closeServer(server);
    }
  });

  await okAsync('CORS and Host/Origin spoofing are blocked', async () => {
    const server = startServer(0);
    try {
      await waitForListening(server);
      const port = server.address().port;
      const exactOrigin = `http://localhost:${port}`;

      const noCors = await localRequest(server, { path: '/api/profiles' });
      assert.strictEqual(noCors.status, 200, noCors.body);
      assert.strictEqual(noCors.headers['access-control-allow-origin'], undefined);

      const allowed = await localRequest(server, {
        path: '/api/profiles',
        headers: { Host: `localhost:${port}`, Origin: exactOrigin },
      });
      assert.strictEqual(allowed.status, 200, allowed.body);
      assert.strictEqual(allowed.headers['access-control-allow-origin'], exactOrigin);

      const preflight = await localRequest(server, {
        method: 'OPTIONS',
        path: '/api/launch',
        headers: { Host: `localhost:${port}`, Origin: exactOrigin },
      });
      assert.strictEqual(preflight.status, 204);
      assert.strictEqual(preflight.headers['access-control-allow-origin'], exactOrigin);

      const crossSite = await localRequest(server, {
        path: '/api/profiles',
        headers: { Origin: 'http://evil.example' },
      });
      assert.strictEqual(crossSite.status, 403, crossSite.body);
      assert.strictEqual(crossSite.headers['access-control-allow-origin'], undefined);

      const spoofedHost = await localRequest(server, {
        path: '/api/profiles',
        headers: { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` },
      });
      assert.strictEqual(spoofedHost.status, 403, spoofedHost.body);
      assert.strictEqual(spoofedHost.headers['access-control-allow-origin'], undefined);
    } finally {
      await closeServer(server);
    }
  });

  console.log(`\n${process.exitCode ? 'FAILED' : `ALL ${n} PASSED`}`);
})().catch(error => {
  console.error(`  FAIL - async test harness: ${error.stack || error.message}`);
  process.exitCode = 1;
  console.log(`\nFAILED`);
});
