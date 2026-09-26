'use strict';

const { fetchJson, downloadMany } = require('./downloader');
const { librariesDir, safeArtifactPath, safeSegment } = require('./minecraft');

const FABRIC_META = 'https://meta.fabricmc.net/v2';

function artifactToQueue(libsBase, mavenUrl, lib) {
  const parts = typeof lib.name === 'string' ? lib.name.split(':') : [];
  if (parts.length !== 3) throw new Error('Unsafe Fabric Maven coordinate');
  const group = safeSegment(parts[0], 'Fabric group').replace(/\./g, '/');
  const artifact = safeSegment(parts[1], 'Fabric artifact');
  const version = safeSegment(parts[2], 'Fabric version');
  const rel = `${group}/${artifact}/${version}/${artifact}-${version}.jar`;
  const base = (lib.url || mavenUrl).replace(/\/$/, '');
  return {
    url: `${base}/${rel}`,
    path: safeArtifactPath(libsBase, rel),
    sha1: lib.sha1,
    size: lib.size,
    kind: 'fabric-lib',
    name: lib.name,
  };
}

async function resolveFabric(mcVersion) {
  const loaders = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`);
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error(`No Fabric loader for ${mcVersion}`);
  }
  const stable = loaders.find(l => l.loader && l.loader.stable) || loaders[0];
  const loaderVersion = stable.loader.version;
  const profile = await fetchJson(
    `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  );
  return { loaderVersion, profile };
}

async function installFabric(mc, mcVersion, { onLog } = {}) {
  const log = onLog || (() => {});
  const { loaderVersion, profile } = await resolveFabric(mcVersion);
  log(`[fabric] loader ${loaderVersion} for ${mcVersion}`);
  const libsBase = librariesDir(mc);
  const libraries = profile.libraries || [];
  const queue = [];
  const prepend = [];
  for (const lib of libraries) {
    if (!lib.name) continue;
    const item = artifactToQueue(libsBase, 'https://maven.fabricmc.net/', lib);
    queue.push(item);
    prepend.push(item.path);
  }
  const r = await downloadMany(queue, { concurrency: 6 });
  if (r.errors.length) {
    throw new Error(`Fabric download failed: ${r.errors.length} errors, first: ${r.errors[0].error}`);
  }
  log(`[fabric] ${prepend.length} libs ready`);
  return {
    loaderVersion,
    mainClass: profile.mainClass || 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    classpathPrepend: prepend,
  };
}

module.exports = { resolveFabric, installFabric, FABRIC_META };
