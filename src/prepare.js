'use strict';

const fs = require('fs');
const path = require('path');
const { getSystemInfo } = require('./system');
const { resolveVersionMeta, buildLibrariesQueue, buildAssetsQueue, mcDir, nativesDir } = require('./minecraft');
const { downloadMany } = require('./downloader');
const { defaultInstanceDir, extractNatives, buildLaunchCommand } = require('./launcher');
const { ensureJava } = require('./java');
const { installFabric } = require('./fabric');
const { installFpsMods } = require('./mods');

async function prepareLaunch({ version = '1.20.1', profile, username = 'Player', fabric = false, mods = false, instanceDir, jvmExtra = [], onLog } = {}) {
  const log = onLog || (() => {});
  profile = profile || getSystemInfo().recommendedProfile;
  instanceDir = instanceDir || defaultInstanceDir(`fps-${version}${fabric ? '-fabric' : ''}`);
  if (mods && !fabric) {
    fabric = true;
    log('[launcher] mods requested without loader — enabling Fabric');
  }

  log(`[launcher] version=${version} profile=${profile} user=${username}${fabric ? ' +fabric' : ''}`);
  const meta = await resolveVersionMeta(undefined, version);
  const { queue, classpath } = buildLibrariesQueue(undefined, meta);
  log(`[launcher] downloading ${queue.length} files...`);
  const r1 = await downloadMany(queue, { concurrency: 8 });
  if (r1.errors.length) {
    throw new Error(`Download failed: ${r1.errors.length} errors, first: ${r1.errors[0].error} (${r1.errors[0].item.url})`);
  }
  log(`[launcher] core files ok (${r1.done}/${r1.total})`);

  try {
    const aiJson = JSON.parse(fs.readFileSync(path.join(mcDir(), 'assets', 'indexes', `${meta.assetIndex.id}.json`), 'utf8'));
    const aq = buildAssetsQueue(undefined, aiJson);
    log(`[launcher] downloading ${aq.length} assets...`);
    const r2 = await downloadMany(aq, { concurrency: 8 });
    if (r2.errors.length) log(`[launcher] WARN ${r2.errors.length} assets failed (sounds/lang may be missing)`);
    else log('[launcher] assets ok');
  } catch (e) { log(`[launcher] assets warn: ${e.message}`); }

  const natDir = nativesDir(undefined, meta.id);
  const dl = queue.filter(q => fs.existsSync(q.path));
  const ex = extractNatives(dl, natDir);
  log(`[launcher] natives: ${ex.extracted} files -> ${natDir}`);

  const logCfg = queue.find(q => q.kind === 'logconfig' && fs.existsSync(q.path));
  const logConfigPath = logCfg ? logCfg.path : null;

  let fabricInfo = null;
  if (fabric) {
    fabricInfo = await installFabric(undefined, version, { onLog: log });
    const mr = await installFpsMods({ instanceDir, mcVersion: version, loader: 'fabric' });
    log(`[launcher] FPS mods: ${mr.installed.length} installed, ${mr.skipped.length} skipped`);
  } else if (mods) {
    const mr = await installFpsMods({ instanceDir, mcVersion: version, loader: 'fabric' });
    log(`[launcher] FPS mods: ${mr.installed.length} installed, ${mr.skipped.length} skipped`);
  }

  const java = await ensureJava(version, { onLog: log });
  const cmd = buildLaunchCommand({
    versionMeta: meta, classpath, javaExe: java.path,
    profileId: profile, account: { name: username }, instanceDir,
    nativesPath: natDir, jvmExtra, logConfigPath, fabric: fabricInfo,
  });
  log(`[launcher] RAM: ${cmd.fps.ramMb}M, JVM flags: ${cmd.fps.args.length}, main: ${cmd.mainClass}`);
  return { cmd, meta, java, instanceDir, fabric: fabricInfo };
}

module.exports = { prepareLaunch };
