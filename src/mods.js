'use strict';

const fs = require('fs');
const path = require('path');
const { fetchJson, downloadFile } = require('./downloader');

const MODRINTH_API = 'https://api.modrinth.com/v2';

const FPS_MODS = {
  sodium:        { required: true,  note: '+40-80% FPS, переписанный рендер' },
  lithium:       { required: true,  note: 'оптимизация тиков мира' },
  'ferrite-core':{ required: true,  note: '-40% RAM на чанках' },
  krypton:       { required: false, note: 'быстрее сеть/пакеты' },
  immediatelyfast:{ required: false, note: 'быстрый рендер GUI/шрифтов' },
  modernfix:     { required: false, note: 'быстрее запуск, меньше RAM' },
  'entity-culling': { required: false, note: 'не рендерит скрытые сущности' },
};

function validateModFilename(value) {
  if (
    typeof value !== 'string'
    || !value
    || value.length > 160
    || value !== path.basename(value)
    || /[\u0000-\u001f\u007f\\/:*?"<>|]/.test(value)
    || value === '.'
    || value === '..'
    || /[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
    || !/\.jar$/i.test(value)
  ) throw new Error('Unsafe mod filename');
  return value;
}

async function resolveModVersion(slug, mcVersion, loader = 'fabric') {
  const url = `${MODRINTH_API}/project/${encodeURIComponent(slug)}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
  const list = await fetchJson(url);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`No ${slug} build for ${loader} ${mcVersion}`);
  }
  const v = list.find(x => x.version_type === 'release') || list[0];
  const file = (v.files || []).find(f => f.primary) || v.files[0];
  if (!file) throw new Error(`No files for ${slug} ${v.version_number}`);
  const filename = validateModFilename(file.filename);
  const sha1 = file.hashes && file.hashes.sha1;
  if (typeof sha1 !== 'string' || !/^[0-9a-f]{40}$/i.test(sha1)) throw new Error(`No valid SHA-1 for ${slug}`);
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 100 * 1024 * 1024) {
    throw new Error(`Invalid size for ${slug}`);
  }
  return {
    version: v.version_number,
    file: { url: file.url, filename, sha1, size: file.size },
  };
}

async function installFpsMods({ instanceDir, mcVersion, loader = 'fabric', slugs, onProgress } = {}) {
  const modsDir = path.join(instanceDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const want = slugs || Object.keys(FPS_MODS);
  const installed = [];
  const skipped = [];
  for (const slug of want) {
    try {
      const { version, file } = await resolveModVersion(slug, mcVersion, loader);
      const dest = path.join(modsDir, file.filename);
      await downloadFile(file.url, dest, {
        sha1: file.sha1,
        size: file.size,
        maxBytes: 100 * 1024 * 1024,
      });
      installed.push({ slug, version, file: file.filename });
      if (onProgress) onProgress({ slug, status: 'ok', installed: installed.length, total: want.length });
    } catch (e) {
      skipped.push({ slug, error: String(e && e.message || e) });
      if (onProgress) onProgress({ slug, status: 'skip', error: String(e && e.message || e) });
    }
  }
  return { modsDir, installed, skipped };
}

module.exports = { FPS_MODS, validateModFilename, resolveModVersion, installFpsMods };
