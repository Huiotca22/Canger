'use strict';

const fs = require('fs');
const path = require('path');
const { getProfile } = require('./profiles');

function profileToOptionsLines(profileId) {
  const p = getProfile(profileId);
  const g = p.game;
  const lines = [];
  lines.push(`version:3465`);
  lines.push(`graphicsMode:${g.graphics}`);
  lines.push(`fancyGraphics:${g.graphics === 0 ? 'false' : 'true'}`);
  lines.push(`renderDistance:${g.renderDistance}`);
  lines.push(`simulationDistance:${g.simulationDistance}`);
  lines.push(`particles:${g.particles}`);
  lines.push(`maxFps:${g.maxFps}`);
  lines.push(`enableVsync:false`);
  lines.push(`vsync:false`);
  lines.push(`entityDistanceScaling:${(g.entityDistance / 100).toFixed(2)}`);
  const cloudStr = g.clouds === 0 ? 'off' : g.clouds === 1 ? 'fast' : 'fancy';
  lines.push(`cloudStatus:${cloudStr}`);
  lines.push(`clouds:${cloudStr}`);
  lines.push(`mipmapLevels:${g.mipmapLevels}`);
  lines.push(`biomeBlendRadius:${g.biomeBlendRadius}`);
  lines.push(`ao:${g.ao}`);
  lines.push(`fullscreen:false`);
  lines.push(`renderClouds:${g.clouds === 0 ? 'false' : 'true'}`);
  lines.push(`entityShadows:${(p.id === 'potato' || g.graphics === 0) ? 'false' : 'true'}`);
  lines.push(`distortionEffectScale:0`);
  lines.push(`fovEffectScale:0`);
  lines.push(`showSubtitles:false`);
  lines.push(`damageTilt:false`);
  return lines;
}

function optimizeOptionsTxt(instanceDir, profileId) {
  const file = path.join(instanceDir, 'options.txt');
  const fpsLines = profileToOptionsLines(profileId);
  const fpsMap = new Map(fpsLines.map(l => [l.split(':')[0], l]));

  let existing = [];
  if (fs.existsSync(file)) {
    existing = fs.readFileSync(file, 'utf8').split('\n').map(s => s.trimEnd()).filter(s => s.length > 0);
  }
  const seen = new Set();
  const out = [];
  for (const line of existing) {
    const key = line.split(':')[0];
    if (fpsMap.has(key)) {
      out.push(fpsMap.get(key));
      seen.add(key);
    } else {
      out.push(line);
    }
  }
  for (const [key, line] of fpsMap) {
    if (!seen.has(key)) out.push(line);
  }
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  return { path: file, written: [...fpsMap.keys()] };
}

module.exports = { profileToOptionsLines, optimizeOptionsTxt };
