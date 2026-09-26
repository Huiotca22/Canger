'use strict';

const PROFILES = {
  potato: {
    id: 'potato',
    name: 'Картошка (MAX FPS)',
    description: 'Слабые ПК: 2-4 ядра, встройка или старая дискретка. Приоритет — кадры, картинка минимальная.',
    ram: { vanilla: 2048, modded: 3072 },
    game: {
      graphics: 0,
      renderDistance: 6,
      simulationDistance: 6,
      particles: 2,
      maxFps: 260,
      vsync: false,
      vsyncOption: 0,
      entityDistance: 50,
      clouds: 0,
      fullscreen: false,
      mipmapLevels: 0,
      biomeBlendRadius: 0,
      enableVsync: false,
      ao: 0,
    },
    extraJvm: [],
    sodiumExtra: ['sodium', 'lithium', 'ferrite-core', 'krypton', 'immediatelyfast', 'modernfix'],
  },
  balanced: {
    id: 'balanced',
    name: 'Сбалансированный',
    description: 'Средние ПК. Хорошие FPS с терпимой картинкой.',
    ram: { vanilla: 3072, modded: 4096 },
    game: {
      graphics: 1,
      renderDistance: 10,
      simulationDistance: 10,
      particles: 1,
      maxFps: 260,
      vsync: false,
      entityDistance: 75,
      clouds: 1,
      mipmapLevels: 2,
      biomeBlendRadius: 2,
      ao: 1,
    },
    extraJvm: [],
    sodiumExtra: ['sodium', 'lithium', 'ferrite-core', 'krypton'],
  },
  performance: {
    id: 'performance',
    name: 'Производительный',
    description: 'ПК выше среднего. Высокие FPS + красивая картинка.',
    ram: { vanilla: 4096, modded: 5120 },
    game: {
      graphics: 2,
      renderDistance: 12,
      simulationDistance: 12,
      particles: 1,
      maxFps: 260,
      vsync: false,
      entityDistance: 100,
      clouds: 2,
      mipmapLevels: 4,
      biomeBlendRadius: 3,
      ao: 2,
    },
    extraJvm: [],
    sodiumExtra: ['sodium', 'lithium', 'ferrite-core'],
  },
  maxfps: {
    id: 'maxfps',
    name: 'MAX FPS (киберспорт)',
    description: 'Топовое железо / PvP. Всё ради 500+ FPS: минимальная картинка, разблокированный лимит.',
    ram: { vanilla: 4096, modded: 6144 },
    game: {
      graphics: 1,
      renderDistance: 8,
      simulationDistance: 6,
      particles: 2,
      maxFps: 260,
      vsync: false,
      entityDistance: 50,
      clouds: 0,
      mipmapLevels: 0,
      biomeBlendRadius: 0,
      ao: 0,
    },
    extraJvm: [],
    sodiumExtra: ['sodium', 'lithium', 'ferrite-core', 'krypton', 'immediatelyfast'],
  },
};

function getProfile(id) {
  if (!id || !PROFILES[id]) return PROFILES.balanced;
  return PROFILES[id];
}

function listProfiles() {
  return Object.values(PROFILES).map(p => ({ id: p.id, name: p.name, description: p.description }));
}

module.exports = { PROFILES, getProfile, listProfiles };
