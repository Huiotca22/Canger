'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { getFpsJvmArgs } = require('./jvm');
const { findSystemExecutable } = require('./system');
const { getProfile } = require('./profiles');
const { optimizeOptionsTxt } = require('./options');
const { javaMajorOf, validateJavaExecutable } = require('./java');
const mc = require('./minecraft');

function defaultInstanceDir(name = 'default') {
  if (typeof name !== 'string' || !name || name.length > 160 || /[\u0000-\u001f\u007f\\/:]/.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid instance name');
  }
  const base = process.env.FPS_LAUNCHER_DIR || path.join(os.homedir(), '.fps-launcher');
  return path.join(base, 'instances', name);
}

function assertNoSymlinkParents(target) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  const relative = path.relative(root, resolved);
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) throw new Error('native destination has a symlink parent');
      if (current !== resolved && !st.isDirectory()) throw new Error('native destination parent is not a directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      break;
    }
  }
}

function extractNatives(queueItems, nativesRoot) {
  if (!Array.isArray(queueItems)) throw new TypeError('native queue must be an array');
  const root = path.resolve(nativesRoot);
  if (root === path.parse(root).root) throw new Error('native destination cannot be a filesystem root');
  assertNoSymlinkParents(root);
  try {
    const existing = fs.lstatSync(root);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('native destination is not a directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { }
  fs.mkdirSync(root, { recursive: true });
  const jars = queueItems.filter(q => q && q.kind === 'native' && typeof q.path === 'string' && fs.existsSync(q.path));
  if (jars.length === 0) return { extracted: 0 };
  const { extractZip } = require('./unzip');
  let extracted = 0;
  let firstJar = true;
  try {
    for (const jar of jars) {
      try {
        const count = extractZip(jar.path, root, {
          flatten: true,
          rejectExisting: !firstJar,
          filter: entry => {
            const name = entry.name.replace(/\\/g, '/');
            return !/^meta-inf\//i.test(name);
          },
        });
        if (count === 0) throw new Error('no native files');
        extracted += count;
        firstJar = false;
      } catch (error) {
        throw new Error(`Native extraction failed for ${jar.path}: ${error.message}`);
      }
    }
    return { extracted };
  } catch (error) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { }
    throw error;
  }
}

function buildLaunchCommand({ versionMeta, classpath, javaExe, profileId = 'balanced', account = { name: 'Player' }, instanceDir, nativesPath, assetIndexId, logConfigPath = null, fabric = null }) {
  const profile = getProfile(profileId);
  const javaMajor = javaMajorOf(javaExe) || 17;
  const cpuCores = (require('os').cpus() || []).length || 4;
  const modded = fs.existsSync(path.join(instanceDir, 'mods')) || !!fabric;
  const fps = getFpsJvmArgs({ profile: profileId, javaMajor, cpuCores, modded });

  const vars = {
    natives_directory: nativesPath,
    launcher_name: 'fps-launcher',
    launcher_version: '0.1.0',
    classpath: '__CP__',
    auth_player_name: account.name || 'Player',
    version_name: versionMeta.id,
    game_directory: instanceDir,
    assets_root: path.join(mc.mcDir(), 'assets'),
    assets_index_name: assetIndexId || (versionMeta.assetIndex && versionMeta.assetIndex.id) || 'legacy',
    auth_uuid: account.uuid || '00000000-0000-4000-8000-000000000000',
    auth_access_token: account.token || '0',
    clientid: 'fps-launcher',
    auth_xuid: '0',
    user_type: 'legacy',
    version_type: versionMeta.type || 'release',
    user_properties: '{}',
    resolution_width: '854',
    resolution_height: '480',
    path: logConfigPath || '',
  };

  const metaJvm = mc.buildJvmArgsFromMeta(versionMeta, vars);
  const gameArgs = mc.buildGameArgs(versionMeta, vars);

  const cpSep = process.platform === 'win32' ? ';' : ':';
  const fullClasspath = fabric ? [...fabric.classpathPrepend, ...classpath] : classpath;
  const cp = fullClasspath.join(cpSep);

  const args = [];
  args.push(...fps.args);
  let insertedCp = false;
  for (const a of metaJvm) {
    if (a === '__CLASSPATH__') { args.push('-cp', cp); insertedCp = true; }
    else args.push(a);
  }
  if (!insertedCp) { args.push('-cp', cp); }
  if (!args.some(a => String(a).includes('java.library.path'))) {
    args.push(`-Djava.library.path=${nativesPath}`);
  }
  const mainClass = (fabric && fabric.mainClass) || versionMeta.mainClass;
  if (!mc.isJavaClassName(mainClass)) {
    throw new Error('Unsafe mainClass in version metadata');
  }
  args.push(mainClass);
  args.push(...gameArgs);

  return { javaExe, args, classpath: cp, mainClass, gameArgs, fps, vars, profile: profile.id };
}

function waitForSpawn(child) {
  if (child && child.launchReady && typeof child.launchReady.then === 'function') return child.launchReady;
  if (!child || typeof child.once !== 'function') {
    return Promise.reject(new Error('Java spawn did not return a child process'));
  }
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const cleanup = () => {
    child.removeListener('error', onError);
    child.removeListener('spawn', onSpawn);
    child.removeListener('exit', onExit);
  };
  const resolveOnce = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveReady(child);
  };
  const rejectOnce = error => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectReady(error instanceof Error ? error : new Error(String(error || 'Java spawn failed')));
  };
  const onError = error => rejectOnce(error instanceof Error ? error : new Error(String(error || 'Java spawn failed')));
  const onSpawn = () => resolveOnce();
  const onExit = (code, signal) => {
    if (!settled) rejectOnce(new Error(`Java process exited before spawn (code=${code}, signal=${signal || 'none'})`));
  };
  child.once('error', onError);
  child.once('spawn', onSpawn);
  child.once('exit', onExit);
  if (child.spawned === true) queueMicrotask(onSpawn);
  ready.catch(() => {});
  return ready;
}

function launch(cmd, { onLog, waitForLaunch = false, waitForSpawn: waitForSpawnOption = false } = {}) {
  const executable = validateJavaExecutable(cmd && cmd.javaExe);
  if (!executable) throw new Error('Unsafe or missing Java executable');
  if (!cmd || !cmd.vars || typeof cmd.vars.game_directory !== 'string' || !Array.isArray(cmd.args)) {
    throw new TypeError('invalid launch command');
  }
  const args = cmd.args.map(arg => {
    if (typeof arg !== 'string' || arg.includes('\0')) throw new TypeError('invalid JVM argument');
    return arg;
  });
  try { optimizeOptionsTxt(cmd.vars.game_directory, cmd.profile); } catch (_) { }
  fs.mkdirSync(cmd.vars.game_directory, { recursive: true });
  const child = spawn(executable, args, {
    cwd: cmd.vars.game_directory,
    windowsHide: true,
    shell: false,
  });
  const ready = waitForSpawn(child);
  child.launchReady = ready;
  try {
    if (process.platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
      const pid = String(child.pid);
      const wmic = findSystemExecutable(['System32/wmic.exe'], { names: ['wmic.exe'] });
      let prioritySet = false;
      if (wmic) {
        try {
          execFileSync(wmic, ['process', 'where', `processid=${pid}`, 'CALL', 'setpriority', 'high priority'], {
            stdio: 'ignore', windowsHide: true, shell: false, timeout: 3000,
          });
          prioritySet = true;
        } catch (_) { }
      }
      if (!prioritySet) {
        const powershell = findSystemExecutable([
          'System32/WindowsPowerShell/v1.0/powershell.exe',
          'System32/WindowsPowerShell/v1.0/pwsh.exe',
        ], { names: ['powershell.exe', 'pwsh.exe'] });
        if (powershell) {
          try {
            execFileSync(powershell, [
              '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
              `(Get-Process -Id ${pid}).PriorityClass='AboveNormal'`,
            ], { stdio: 'ignore', windowsHide: true, shell: false, timeout: 3000 });
          } catch (_) { }
        }
      }
    } else if (process.platform !== 'win32') {
      try { child.nice = -5; } catch (_) {}
    }
  } catch (_) { }
  if (child.stdout) child.stdout.on('data', d => { try { if (onLog) onLog(String(d)); } catch (_) {} });
  if (child.stderr) child.stderr.on('data', d => { try { if (onLog) onLog(String(d)); } catch (_) {} });
  child.on('error', (e) => {
    try { if (onLog) onLog(`[launcher] spawn error: ${e.message}`); } catch (_) {}
  });
  return (waitForLaunch || waitForSpawnOption) ? ready.then(() => child) : child;
}

module.exports = { defaultInstanceDir, extractNatives, buildLaunchCommand, launch, waitForSpawn };
