import { useState, useRef, useEffect, useMemo } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import JSZip from 'jszip';

const tauriAvailable = isTauri();
const win = tauriAvailable ? getCurrentWindow() : null;

interface MinecraftVersion {
  id: string;
  name: string;
  type: 'release' | 'snapshot' | 'modded';
  loader?: 'fabric' | 'forge' | 'neoforge';
  minecraftVersion?: string;
  forgeVersion?: string;
  neoforgeVersion?: string;
  loaderVersion?: string;
  fullForgeVersion?: string;
  channel?: 'recommended' | 'latest' | 'explicit';
  headlessSupported?: boolean;
  tags: { label: string; variant?: 'release' | 'snapshot' | 'fabric' | 'forge' | 'neoforge' | 'secondary' }[];
  isInstalled?: boolean;
  packageUrl?: string;
  vanillaPackageUrl?: string;
  clientUrl?: string;
  clientSize?: number;
}

interface DownloadProgress {
  percent: number;
  currentBytes?: number;
  totalBytes?: number;
  stage?: string;
}

interface ForgeInstallResult {
  profileId: string;
  minecraftVersion: string;
  forgeVersion: string;
  fullForgeVersion: string;
  channel: 'recommended' | 'latest' | 'explicit';
}

interface NeoForgeInstallResult {
  profileId: string;
  minecraftVersion: string;
  neoforgeVersion: string;
}

interface ToastNotification {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  message?: string;
}

interface InstalledMod {
  name: string;
  filename: string;
  size: number;
  enabled: boolean;
}

interface DirItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

interface CatalogItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  icon_url?: string;
  downloads: number;
  type: 'mod' | 'modpack';
  source: 'modrinth' | 'curseforge';
  cfId?: number;
  categories?: string[];
  author?: string;
}

const POPULAR_MODS_PRESET = [
  {
    slug: 'sodium',
    title: 'Sodium',
    category: 'Оптимизация',
    desc: '+40-80% FPS, полностью переписанный графический движок',
    icon: 'https://cdn.modrinth.com/data/AANobbMI/icon.png',
  },
  {
    slug: 'lithium',
    title: 'Lithium',
    category: 'Оптимизация',
    desc: 'Оптимизация тиков мира и физики мобов без изменения механик',
    icon: 'https://cdn.modrinth.com/data/gvQqBUqZ/icon.png',
  },
  {
    slug: 'ferrite-core',
    title: 'FerriteCore',
    category: 'Оптимизация',
    desc: 'Снижает потребление RAM на 30-50% за счет сжатия моделей',
    icon: 'https://cdn.modrinth.com/data/uXXizFIs/icon.png',
  },
  {
    slug: 'immediatelyfast',
    title: 'ImmediatelyFast',
    category: 'Оптимизация',
    desc: 'Быстрый рендер GUI, шрифтов, чата и экранных элементов',
    icon: 'https://cdn.modrinth.com/data/5ZwdcRci/icon.png',
  },
  {
    slug: 'entityculling',
    title: 'Entity Culling',
    category: 'Оптимизация',
    desc: 'Пропускает рендеринг сущностей и сундуков за стенами',
    icon: 'https://cdn.modrinth.com/data/NNAgCjsB/icon.png',
  },
  {
    slug: 'krypton',
    title: 'Krypton',
    category: 'Оптимизация',
    desc: 'Оптимизация сетевых пакетов и устранение микро-лагов',
    icon: 'https://cdn.modrinth.com/data/fQEb0iXm/icon.png',
  },
  {
    slug: 'modernfix',
    title: 'ModernFix',
    category: 'Оптимизация',
    desc: 'Ускоряет загрузку игры в 2 раза и чистит память',
    icon: 'https://cdn.modrinth.com/data/nmDcB62a/icon.png',
  },
  {
    slug: 'clumps',
    title: 'Clumps',
    category: 'Оптимизация',
    desc: 'Объединяет сферы опыта в одну, убирая лаги на фермах',
    icon: 'https://cdn.modrinth.com/data/WnXDvgEr/icon.png',
  },

  {
    slug: 'iris',
    title: 'Iris Shaders',
    category: 'Графика',
    desc: 'Быстрый и современный загрузчик шейдеров для Sodium',
    icon: 'https://cdn.modrinth.com/data/YL57xq9U/icon.png',
  },
  {
    slug: 'continuity',
    title: 'Continuity',
    category: 'Графика',
    desc: 'Соединенные текстуры стекол, книжных полок и блоков',
    icon: 'https://cdn.modrinth.com/data/1IjD5062/icon.png',
  },
  {
    slug: 'lambdabettergrass',
    title: 'LambdaBetterGrass',
    category: 'Графика',
    desc: 'Красивые соединенные текстуры травы и снега',
    icon: 'https://cdn.modrinth.com/data/m1g28l5b/icon.png',
  },
  {
    slug: 'falling-leaves',
    title: 'Falling Leaves',
    category: 'Графика',
    desc: 'Красивые анимированные падающие листья с деревьев',
    icon: 'https://cdn.modrinth.com/data/DY1uR1A5/icon.png',
  },
  {
    slug: 'wavey-capes',
    title: 'Wavey Capes',
    category: 'Графика',
    desc: 'Плавная физика реалистичного движения плащей',
    icon: 'https://cdn.modrinth.com/data/AHiU1Hqf/icon.png',
  },

  {
    slug: 'journeymap',
    title: 'JourneyMap',
    category: 'Карты',
    desc: 'Полнофункциональная карта мира и миникарта в реальном времени',
    icon: 'https://cdn.modrinth.com/data/mOgUt4GM/icon.png',
  },
  {
    slug: 'xaeros-minimap',
    title: 'Xaero\'s Minimap',
    category: 'Карты',
    desc: 'Плавная, легкая и настраиваемая миникарта',
    icon: 'https://cdn.modrinth.com/data/1bokaNcj/icon.png',
  },
  {
    slug: 'xaeros-world-map',
    title: 'Xaero\'s World Map',
    category: 'Карты',
    desc: 'Полноэкранная карта мира с сохранением открытых чанков',
    icon: 'https://cdn.modrinth.com/data/I65wfDgD/icon.png',
  },
  {
    slug: 'waystones',
    title: 'Waystones',
    category: 'Геймплей',
    desc: 'Путеводные камни для телепортации между базами',
    icon: 'https://cdn.modrinth.com/data/osm1C85H/icon.png',
  },

  {
    slug: 'jei',
    title: 'Just Enough Items (JEI)',
    category: 'Рецепты',
    desc: 'Просмотр всех рецептов, крафтов и применений предметов',
    icon: 'https://cdn.modrinth.com/data/u6dRKJwZ/icon.png',
  },
  {
    slug: 'emi',
    title: 'EMI',
    category: 'Рецепты',
    desc: 'Современный и ультрабыстрый просмотрщик рецептов',
    icon: 'https://cdn.modrinth.com/data/fRiHVvU7/icon.png',
  },
  {
    slug: 'appleskin',
    title: 'AppleSkin',
    category: 'Интерфейс',
    desc: 'Наглядные индикаторы сытости еды и насыщения',
    icon: 'https://cdn.modrinth.com/data/EsAfCjCV/icon.png',
  },
  {
    slug: 'jade',
    title: 'Jade',
    category: 'Интерфейс',
    desc: 'Информационная панель при наведении на блок или моба',
    icon: 'https://cdn.modrinth.com/data/nvQzvtQU/icon.png',
  },
  {
    slug: 'shulkerboxtooltip',
    title: 'ShulkerBoxTooltip',
    category: 'Интерфейс',
    desc: 'Предпросмотр содержимого шалкеров во всплывающей подсказке',
    icon: 'https://cdn.modrinth.com/data/2M01OIrb/icon.png',
  },
  {
    slug: 'mouse-tweaks',
    title: 'Mouse Tweaks',
    category: 'Интерфейс',
    desc: 'Удобная сортировка и перетаскивание предметов мышью',
    icon: 'https://cdn.modrinth.com/data/aC3cM3Vq/icon.png',
  },
  {
    slug: 'zoomify',
    title: 'Zoomify',
    category: 'Интерфейс',
    desc: 'Плавный настраиваемый зум с анимацией приближения',
    icon: 'https://cdn.modrinth.com/data/w7ThnYpT/icon.png',
  },
  {
    slug: 'modmenu',
    title: 'Mod Menu',
    category: 'Интерфейс',
    desc: 'Интерфейс списка модов прямо в главном меню игры',
    icon: 'https://cdn.modrinth.com/data/mOgUt4GM/icon.png',
  },

  {
    slug: 'create',
    title: 'Create',
    category: 'Геймплей',
    desc: 'Механика, шестерни, вращение, конвейеры и поезда',
    icon: 'https://cdn.modrinth.com/data/LNytGWDc/icon.png',
  },
  {
    slug: 'farmers-delight',
    title: 'Farmer\'s Delight',
    category: 'Геймплей',
    desc: 'Кулинария, фермерство, сковородки и десятки блюд',
    icon: 'https://cdn.modrinth.com/data/Z2TZsUV4/icon.png',
  },
  {
    slug: 'simple-voice-chat',
    title: 'Simple Voice Chat',
    category: 'Геймплей',
    desc: 'Позиционный 3D голосовой чат прямо внутри игры',
    icon: 'https://cdn.modrinth.com/data/9eGKb6K1/icon.png',
  },
  {
    slug: 'sound-physics-remastered',
    title: 'Sound Physics',
    category: 'Атмосфера',
    desc: 'Реалистичное эхо в пещерах и реверберация звука',
    icon: 'https://cdn.modrinth.com/data/qyVF9oeo/icon.png',
  },
  {
    slug: 'presence-footsteps',
    title: 'Presence Footsteps',
    category: 'Атмосфера',
    desc: 'Детализированные реалистичные звуки шагов',
    icon: 'https://cdn.modrinth.com/data/rcTfTZr3/icon.png',
  },
  {
    slug: 'chat-heads',
    title: 'Chat Heads',
    category: 'Интерфейс',
    desc: 'Отображение голов игроков рядом с сообщениями в чате',
    icon: 'https://cdn.modrinth.com/data/Wnxd13zP/icon.png',
  },
  {
    slug: 'controlling',
    title: 'Controlling',
    category: 'Интерфейс',
    desc: 'Поиск и фильтрация клавиш управления без конфликтов',
    icon: 'https://cdn.modrinth.com/data/xv9v8EZT/icon.png',
  },
  {
    slug: 'no-chat-reports',
    title: 'No Chat Reports',
    category: 'Утилиты',
    desc: 'Отключает криптографические подписи чата и телеметрию',
    icon: 'https://cdn.modrinth.com/data/qQyHxfxd/icon.png',
  },
];

const MINECRAFT_VERSIONS: MinecraftVersion[] = [
  {
    id: '1.21.4',
    name: '1.21.4',
    type: 'release',
    tags: [
      { label: 'Релиз', variant: 'release' },
      { label: 'Vanilla', variant: 'secondary' },
      { label: 'LTS', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '1.21.4-fabric',
    name: 'Fabric 1.21.4',
    type: 'modded',
    loader: 'fabric',
    minecraftVersion: '1.21.4',
    loaderVersion: '0.19.5',
    packageUrl: 'https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.19.5/profile/json',
    tags: [
      { label: 'Fabric', variant: 'fabric' },
      { label: '0.19.5', variant: 'secondary' },
      { label: 'Моды', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '1.21.1',
    name: '1.21.1',
    type: 'release',
    tags: [
      { label: 'Релиз', variant: 'release' },
      { label: 'Vanilla', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '1.20.4',
    name: '1.20.4',
    type: 'release',
    tags: [
      { label: 'Релиз', variant: 'release' },
      { label: 'Vanilla', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '1.20.1-fabric',
    name: 'Fabric 1.20.1',
    type: 'modded',
    loader: 'fabric',
    minecraftVersion: '1.20.1',
    loaderVersion: '0.19.5',
    packageUrl: 'https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.19.5/profile/json',
    tags: [
      { label: 'Fabric', variant: 'fabric' },
      { label: '0.19.5', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '1.20.1-forge-47.4.10',
    name: 'Forge 1.20.1 · 47.4.10',
    type: 'modded',
    loader: 'forge',
    minecraftVersion: '1.20.1',
    forgeVersion: '47.4.10',
    fullForgeVersion: '1.20.1-47.4.10',
    channel: 'recommended',
    headlessSupported: true,
    tags: [
      { label: 'Forge', variant: 'forge' },
      { label: '47.4.10', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '1.19.4',
    name: '1.19.4',
    type: 'release',
    tags: [
      { label: 'Релиз', variant: 'release' },
      { label: 'Vanilla', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '1.16.5-forge-36.2.34',
    name: 'Forge 1.16.5 · 36.2.34',
    type: 'modded',
    loader: 'forge',
    minecraftVersion: '1.16.5',
    forgeVersion: '36.2.34',
    fullForgeVersion: '1.16.5-36.2.34',
    channel: 'recommended',
    headlessSupported: true,
    tags: [
      { label: 'Forge', variant: 'forge' },
      { label: '36.2.34', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '1.12.2-forge-14.23.5.2859',
    name: 'Forge 1.12.2 · 14.23.5.2859',
    type: 'modded',
    loader: 'forge',
    minecraftVersion: '1.12.2',
    forgeVersion: '14.23.5.2859',
    fullForgeVersion: '1.12.2-14.23.5.2859',
    channel: 'recommended',
    headlessSupported: false,
    tags: [
      { label: 'Forge', variant: 'forge' },
      { label: '14.23.5.2859', variant: 'secondary' },
      { label: 'Вручную', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '1.8.9',
    name: '1.8.9',
    type: 'release',
    tags: [
      { label: 'Релиз', variant: 'release' },
      { label: 'PvP', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '25w08a',
    name: '25w08a',
    type: 'snapshot',
    tags: [
      { label: 'Снапшот', variant: 'snapshot' },
      { label: 'Тест', variant: 'secondary' },
    ],
    isInstalled: false,
  },
  {
    id: '24w46a',
    name: '24w46a',
    type: 'snapshot',
    tags: [
      { label: 'Снапшот', variant: 'snapshot' },
    ],
    isInstalled: false,
  },
];

const FABRIC_LOADER_CARD_LIMIT = 1;
const FABRIC_GAME_CARD_LIMIT = 8;
const FORGE_BUILD_CARD_LIMIT = 1;
const NEOFORGE_BUILD_CARD_LIMIT = 1;

const FALLBACK_FABRIC_LOADERS = ['0.19.5', '0.18.6', '0.17.3', '0.16.14', '0.15.11'];
const FALLBACK_FORGE_BUILDS: Record<string, string[]> = {
  '1.20.1': ['47.4.10', '47.3.39'],
  '1.20.4': ['49.2.0'],
  '1.20.6': ['50.2.1'],
  '1.21.1': ['52.1.2'],
  '1.21.4': ['54.1.6'],
  '1.16.5': ['36.2.34', '36.2.42'],
  '1.12.2': ['14.23.5.2859'],
};
const FALLBACK_NEOFORGE_BUILDS: Record<string, string[]> = {
  '1.20.2': ['20.2.93', '20.2.92', '20.2.91'],
  '1.20.4': ['20.4.251', '20.4.250', '20.4.249'],
  '1.21.1': ['21.1.251', '21.1.250', '21.1.249'],
  '1.21.4': ['21.4.157', '21.4.156', '21.4.155'],
  '1.21.11': ['21.11.45', '21.11.44', '21.11.42'],
  '26.1.2': ['26.1.2.109', '26.1.2.108', '26.1.2.107'],
  '26.2': ['26.2.0.88', '26.2.0.87', '26.2.0.86'],
};

const FALLBACK_MODDED_VERSIONS: MinecraftVersion[] = [
  {
    id: '1.21.4-fabric-0.18.6', name: 'Fabric 1.21.4 · 0.18.6', type: 'modded', loader: 'fabric',
    minecraftVersion: '1.21.4', loaderVersion: '0.18.6',
    packageUrl: 'https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.18.6/profile/json',
    tags: [{ label: 'Fabric', variant: 'fabric' }, { label: '0.18.6', variant: 'secondary' }],
  },
  {
    id: '1.20.1-fabric-0.18.6', name: 'Fabric 1.20.1 · 0.18.6', type: 'modded', loader: 'fabric',
    minecraftVersion: '1.20.1', loaderVersion: '0.18.6',
    packageUrl: 'https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.18.6/profile/json',
    tags: [{ label: 'Fabric', variant: 'fabric' }, { label: '0.18.6', variant: 'secondary' }],
  },
  {
    id: '1.21.1-forge-52.1.2', name: 'Forge 1.21.1 · 52.1.2', type: 'modded', loader: 'forge',
    minecraftVersion: '1.21.1', forgeVersion: '52.1.2', fullForgeVersion: '1.21.1-52.1.2',
    channel: 'explicit', headlessSupported: true,
    tags: [{ label: 'Forge', variant: 'forge' }, { label: '52.1.2', variant: 'secondary' }],
  },
  {
    id: '1.21.4-forge-54.1.6', name: 'Forge 1.21.4 · 54.1.6', type: 'modded', loader: 'forge',
    minecraftVersion: '1.21.4', forgeVersion: '54.1.6', fullForgeVersion: '1.21.4-54.1.6',
    channel: 'explicit', headlessSupported: true,
    tags: [{ label: 'Forge', variant: 'forge' }, { label: '54.1.6', variant: 'secondary' }],
  },
  {
    id: 'neoforge-20.2.93', name: 'NeoForge 1.20.2 · 20.2.93', type: 'modded', loader: 'neoforge',
    minecraftVersion: '1.20.2', neoforgeVersion: '20.2.93', loaderVersion: '20.2.93',
    channel: 'explicit', headlessSupported: true,
    tags: [{ label: 'NeoForge', variant: 'neoforge' }, { label: '20.2.93', variant: 'secondary' }],
  },
  {
    id: 'neoforge-21.1.251', name: 'NeoForge 1.21.1 · 21.1.251', type: 'modded', loader: 'neoforge',
    minecraftVersion: '1.21.1', neoforgeVersion: '21.1.251', loaderVersion: '21.1.251',
    channel: 'explicit', headlessSupported: true,
    tags: [{ label: 'NeoForge', variant: 'neoforge' }, { label: '21.1.251', variant: 'secondary' }],
  },
  {
    id: 'neoforge-26.2.0.88', name: 'NeoForge 26.2 · 26.2.0.88', type: 'modded', loader: 'neoforge',
    minecraftVersion: '26.2', neoforgeVersion: '26.2.0.88', loaderVersion: '26.2.0.88',
    channel: 'explicit', headlessSupported: true,
    tags: [{ label: 'NeoForge', variant: 'neoforge' }, { label: '26.2.0.88', variant: 'secondary' }],
  },
];

function numericVersionParts(value: string): number[] {
  return (value.match(/\d+/g) || []).map((part) => Number.parseInt(part, 10));
}

function compareNumericVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

function parseForgeMetadataVersions(xml: string): string[] {
  return Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g), (match) => match[1].trim())
    .filter((version) => /^[A-Za-z0-9._+-]+$/.test(version));
}

function parseForgeMavenBuild(value: string): { minecraftVersion: string; forgeVersion: string } | null {
  const separator = value.indexOf('-');
  if (separator <= 0) return null;
  const minecraftVersion = value.slice(0, separator);
  const forgeVersion = value.slice(separator + 1);
  if (!/^\d+(?:\.\d+){1,2}$/.test(minecraftVersion)) return null;
  if (!/^[A-Za-z0-9._+-]+$/.test(forgeVersion)) return null;
  return { minecraftVersion, forgeVersion };
}

function parseNeoForgeMavenBuild(value: string): { minecraftVersion: string; neoforgeVersion: string } | null {
  if (!/^\d+(?:\.\d+){2,3}$/.test(value)) return null;
  const parts = value.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;

  if (parts[0] >= 26) {
    if (parts.length !== 4) return null;
    return {
      minecraftVersion: parts[2] === 0
        ? `${parts[0]}.${parts[1]}`
        : `${parts[0]}.${parts[1]}.${parts[2]}`,
      neoforgeVersion: value,
    };
  }

  if (parts.length !== 3 || parts[0] < 20) return null;
  return {
    minecraftVersion: parts[1] === 0
      ? `1.${parts[0]}`
      : `1.${parts[0]}.${parts[1]}`,
    neoforgeVersion: value,
  };
}

function takeRecent<T>(
  values: T[],
  versionOf: (value: T) => string,
  limit: number,
): T[] {
  const seen = new Set<string>();
  return values
    .filter((value) => {
      const version = versionOf(value);
      if (seen.has(version)) return false;
      seen.add(version);
      return true;
    })
    .sort((left, right) => compareNumericVersions(versionOf(right), versionOf(left)))
    .slice(0, limit);
}

function keepLatestLoaderCards(versions: MinecraftVersion[]): MinecraftVersion[] {
  const seenLoaderVersions = new Set<string>();
  return versions.filter((version) => {
    if (version.type !== 'modded') return true;
    if (!version.loader) return false;
    const key = `${version.loader}:${version.minecraftVersion || version.id}`;
    if (seenLoaderVersions.has(key)) return false;
    seenLoaderVersions.add(key);
    return true;
  });
}

function reconstructInstalledVersionCard(id: string): MinecraftVersion | null {
  const forge = id.match(/^(.+)-forge-(.+)$/);
  if (forge && /^\d+\.\d+(?:\.\d+)?$/.test(forge[1]) && /^[A-Za-z0-9._+-]+$/.test(forge[2])) {
    const minecraftVersion = forge[1];
    const forgeVersion = forge[2];
    const legacyForge = /^1\.(?:[0-9]|1[0-2])(?:\.|$)/.test(minecraftVersion);
    return {
      id,
      name: `Forge ${minecraftVersion} · ${forgeVersion}`,
      type: 'modded',
      loader: 'forge',
      minecraftVersion,
      forgeVersion,
      fullForgeVersion: `${minecraftVersion}-${forgeVersion}`,
      channel: 'explicit',
      headlessSupported: !legacyForge,
      tags: [
        { label: 'Forge', variant: 'forge' },
        { label: forgeVersion, variant: 'secondary' },
      ],
    };
  }

  const fabric = id.match(/^(.+)-fabric(?:-(.+))?$/);
  if (fabric && /^\d+\.\d+(?:\.\d+)?$/.test(fabric[1])) {
    const minecraftVersion = fabric[1];
    const loaderVersion = fabric[2] || FALLBACK_FABRIC_LOADERS[0];
    return {
      id,
      name: `Fabric ${minecraftVersion} · ${loaderVersion}`,
      type: 'modded',
      loader: 'fabric',
      minecraftVersion,
      loaderVersion,
      packageUrl: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraftVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`,
      tags: [
        { label: 'Fabric', variant: 'fabric' },
        { label: loaderVersion, variant: 'secondary' },
      ],
    };
  }

  const neoforge = id.match(/^neoforge-(.+)$/);
  if (neoforge) {
    const build = parseNeoForgeMavenBuild(neoforge[1]);
    if (build) {
      return {
        id,
        name: `NeoForge ${build.minecraftVersion} · ${build.neoforgeVersion}`,
        type: 'modded',
        loader: 'neoforge',
        minecraftVersion: build.minecraftVersion,
        neoforgeVersion: build.neoforgeVersion,
        loaderVersion: build.neoforgeVersion,
        channel: 'explicit',
        headlessSupported: true,
        tags: [
          { label: 'NeoForge', variant: 'neoforge' },
          { label: build.neoforgeVersion, variant: 'secondary' },
        ],
      };
    }
  }

  const prefixedFabric = id.match(/^Fabric\s+(\d+\.\d+(?:\.\d+)?)$/i);
  if (prefixedFabric) {
    const minecraftVersion = prefixedFabric[1];
    return {
      id,
      name: `Fabric ${minecraftVersion}`,
      type: 'modded',
      loader: 'fabric',
      minecraftVersion,
      loaderVersion: FALLBACK_FABRIC_LOADERS[0],
      tags: [
        { label: 'Fabric', variant: 'fabric' },
        { label: FALLBACK_FABRIC_LOADERS[0], variant: 'secondary' },
      ],
    };
  }

  if (/^\d+\.\d+(?:\.\d+)?$/.test(id)) {
    return {
      id,
      name: id,
      type: 'release',
      tags: [
        { label: 'Релиз', variant: 'release' },
        { label: 'Vanilla', variant: 'secondary' },
      ],
    };
  }

  return null;
}

function mergeInstalledVersionCards(
  knownVersions: MinecraftVersion[],
  installedIds: Iterable<string>,
): MinecraftVersion[] {
  const result = [...knownVersions];
  const knownIds = new Set(result.map((version) => version.id));
  for (const id of installedIds) {
    if (knownIds.has(id)) continue;
    const card = reconstructInstalledVersionCard(id);
    if (!card) continue;
    result.push(card);
    knownIds.add(id);
  }
  return result;
}

const MAX_MODPACK_BYTES = 100 * 1024 * 1024;

function modFileIntegrity(file: any): { sha1: string | null; sha512: string | null } {
  return {
    sha1: file?.hashes?.sha1 || null,
    sha512: file?.hashes?.sha512 || null,
  };
}

function curseFileIntegrity(file: any): { sha1: string | null; sha512: string | null } {
  const hashes = Array.isArray(file?.hashes) ? file.hashes : [];
  const findHash = (algorithms: Array<number | string>) => hashes.find((hash: any) => (
    algorithms.includes(hash.algorithm) || algorithms.includes(String(hash.algorithm))
  ))?.value || null;
  return {
    sha1: findHash([1, 'sha1']),
    sha512: findHash([4, 'sha512']),
  };
}

async function fetchCatalogSlice(
  query: string,
  type: 'all' | 'mod' | 'modpack',
  source: 'all' | 'modrinth' | 'curseforge',
  mrOffset: number,
  cfIndex: number,
  batchMultiplier = 2
): Promise<{ items: CatalogItem[]; nextMrOffset: number; nextCfIndex: number; hasMore: boolean }> {
  const items: CatalogItem[] = [];
  let nextMrOffset = mrOffset;
  let nextCfIndex = cfIndex;
  let mrHasMore = true;
  let cfHasMore = true;

  const tasks: Promise<void>[] = [];

  if (source === 'all' || source === 'modrinth') {
    let facets: string[][] = [];
    if (type === 'mod') facets = [['project_type:mod']];
    else if (type === 'modpack') facets = [['project_type:modpack']];
    const facetsParam = facets.length > 0 ? `&facets=${encodeURIComponent(JSON.stringify(facets))}` : '';
    const queryParam = query ? `query=${encodeURIComponent(query)}&` : '';

    for (let i = 0; i < batchMultiplier; i++) {
      const off = mrOffset + i * 100;
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://api.modrinth.com/v2/search?${queryParam}limit=100&offset=${off}&index=downloads${facetsParam}`
            );
            if (res.ok) {
              const data = await res.json();
              const hits = data.hits || [];
              if (hits.length < 100) {
                mrHasMore = false;
              }
              for (const h of hits) {
                items.push({
                  id: h.project_id,
                  slug: h.slug,
                  title: h.title,
                  description: h.description,
                  icon_url: h.icon_url,
                  downloads: h.downloads || 0,
                  type: h.project_type === 'modpack' ? 'modpack' : 'mod',
                  source: 'modrinth',
                  categories: h.categories || [],
                  author: h.author,
                });
              }
            } else {
              mrHasMore = false;
            }
          } catch (e) {
            console.warn('Modrinth batch error:', e);
            mrHasMore = false;
          }
        })()
      );
    }
    nextMrOffset = mrOffset + batchMultiplier * 100;
  }

  if (source === 'all' || source === 'curseforge') {
    const classIdsToQuery: number[] = [];
    if (type === 'all') {
      classIdsToQuery.push(6, 4471);
    } else if (type === 'mod') {
      classIdsToQuery.push(6);
    } else if (type === 'modpack') {
      classIdsToQuery.push(4471);
    }

    const filterParam = query ? `&searchFilter=${encodeURIComponent(query)}` : '&sortField=2&sortOrder=desc';

    for (const cId of classIdsToQuery) {
      for (let i = 0; i < batchMultiplier; i++) {
        const idx = cfIndex + i * 50;
        tasks.push(
          (async () => {
            try {
              const endpoint = `mods/search?gameId=432&classId=${cId}${filterParam}&pageSize=50&index=${idx}`;
              const responseText = await invoke<string>('fetch_curseforge_api', { endpoint });
              const data = JSON.parse(responseText);
              const cfList = data.data || [];
              if (cfList.length < 50) {
                cfHasMore = false;
              }
              for (const m of cfList) {
                items.push({
                  id: String(m.id),
                  slug: m.slug,
                  title: m.name,
                  description: m.summary || '',
                  icon_url: m.logo?.thumbnailUrl,
                  downloads: m.downloadCount || 0,
                  type: m.classId === 4471 ? 'modpack' : 'mod',
                  source: 'curseforge',
                  cfId: m.id,
                  categories: (m.categories || []).map((c: any) => c.name),
                });
              }
            } catch (e) {
              console.warn('CurseForge batch error:', e);
              cfHasMore = false;
            }
          })()
        );
      }
    }
    nextCfIndex = cfIndex + batchMultiplier * 50;
  }

  await Promise.all(tasks);

  return {
    items,
    nextMrOffset,
    nextCfIndex,
    hasMore: mrHasMore || cfHasMore,
  };
}

const GAME_FOLDERS = [
  { id: 'root', name: 'Корень версии', sub: '', desc: 'Файлы выбранной версии' },
  { id: 'mods', name: 'Модификации (mods)', sub: 'mods', desc: 'Моды игры' },
  { id: 'resourcepacks', name: 'Ресурспаки (resourcepacks)', sub: 'resourcepacks', desc: 'Текстур-паки' },
  { id: 'shaderpacks', name: 'Шейдеры (shaderpacks)', sub: 'shaderpacks', desc: 'Шейдеры' },
  { id: 'saves', name: 'Миры и сохранения (saves)', sub: 'saves', desc: 'Одиночные миры' },
  { id: 'screenshots', name: 'Скриншоты (screenshots)', sub: 'screenshots', desc: 'Снимки F2' },
  { id: 'config', name: 'Конфигурации (config)', sub: 'config', desc: 'Настройки модов' },
  { id: 'logs', name: 'Логи и отчёты (logs)', sub: 'logs', desc: 'Краши и логи' },
];

const VALID_THEME_IDS = new Set(['theme-1', 'theme-2', 'theme-3', 'theme-4', 'theme-5', 'theme-6']);

function readStoredString(key: string, fallback: string): string {
  try {
    const value = localStorage.getItem(key);
    return typeof value === 'string' && value.trim() ? value : fallback;
  } catch {
    return fallback;
  }
}

function readStoredStringArray(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  } catch {
    return [];
  }
}

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getDialogFocusableElements(...containers: Array<HTMLElement | null>): HTMLElement[] {
  const elements = containers.flatMap((container) => (
    container ? Array.from(container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)) : []
  ));

  return Array.from(new Set(elements)).filter((element) => (
    element.tabIndex >= 0
    && !element.hasAttribute('disabled')
    && element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0
  ));
}

export default function App() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('home');
  const [folderGroupOpen, setFolderGroupOpen] = useState(true);

  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState<string | null>(null);
  const [confirmDeleteMod, setConfirmDeleteMod] = useState<string | null>(null);
  const [isConfirmClosing, setIsConfirmClosing] = useState(false);

  const handleOpenFolder = async (sub: string, name: string) => {
    try {
      await invoke('open_game_folder', { subfolder: sub, version: selectedRuntimeVersion });
      showToast('info', 'Папка открыта', name);
    } catch (err: any) {
      showToast('error', 'Не удалось открыть папку', err?.message || String(err));
    }
  };
  const [themePageIndex, setThemePageIndex] = useState(0);
  const themeGridRef = useRef<HTMLDivElement>(null);
  const [pixelsOn, setPixelsOn] = useState(() => {
    try { return localStorage.getItem('pixels') !== 'off'; } catch { return true; }
  });
  const [ram, setRam] = useState(() => readStoredNumber('ram', 2048, 512, 131_072));
  const [theme, setTheme] = useState(() => {
    const storedTheme = readStoredString('theme', 'theme-1');
    return VALID_THEME_IDS.has(storedTheme) ? storedTheme : 'theme-1';
  });
  const themes = [
    { id: 'theme-1', src: '/themes/theme-1.avif' },
    { id: 'theme-2', src: '/themes/theme-2.avif' },
    { id: 'theme-3', src: '/themes/theme-3.avif' },
    { id: 'theme-4', src: '/themes/theme-4.jpg' },
    { id: 'theme-5', src: '/themes/theme-5.jpg' },
    { id: 'theme-6', src: '/themes/theme-6.jpg' },
  ];
  const themeSrc = (themes.find((t) => t.id === theme) || themes[0]).src;
  const pickTheme = (t: string) => {
    setTheme(t);
    try { localStorage.setItem('theme', t); } catch { }
  };
  const togglePixels = () => {
    setPixelsOn((v) => {
      try { localStorage.setItem('pixels', v ? 'off' : 'on'); } catch { }
      return !v;
    });
  };
  const handleThemeScroll = () => {
    if (themeGridRef.current) {
      const { scrollLeft, clientWidth } = themeGridRef.current;
      const page = Math.round(scrollLeft / (clientWidth || 1));
      setThemePageIndex(page);
    }
  };
  const scrollToThemePage = (page: number) => {
    if (themeGridRef.current) {
      themeGridRef.current.scrollTo({
        left: page * themeGridRef.current.clientWidth,
        behavior: 'smooth',
      });
    }
  };
  const newsItems = [
    {
      id: 1,
      tag: 'FPS BOOST',
      date: '20.09',
      title: 'Пресет potato — до +80 FPS на слабом железе',
      desc: 'Оптимизированная куча Java, флаги Aikar GC и сбалансированные настройки графики.',
      img: '/banner.jpg',
    },
    {
      id: 2,
      tag: 'ОПТИМИЗАЦИЯ',
      date: '18.09',
      title: 'Sodium-стек ставится в один клик',
      desc: 'Sodium, Lithium, FerriteCore и Krypton с мгновенной загрузкой через Modrinth.',
      img: '/themes/theme-2.avif',
    },
    {
      id: 3,
      tag: 'ДИЗАЙН',
      date: '15.09',
      title: 'Стеклянный интерфейс canger и новые темы',
      desc: 'Атмосферный дизайн, плавное листание и выбор оформления без лишних рамок.',
      img: '/themes/theme-5.jpg',
    },
  ];
  const [newsIndex, setNewsIndex] = useState(0);
  const [isNewsHovered, setIsNewsHovered] = useState(false);
  const [isAddAccountOpen, setIsAddAccountOpen] = useState(false);
  const [isModalClosing, setIsModalClosing] = useState(false);
  const [isVersionsOpen, setIsVersionsOpen] = useState(false);
  const [isVersionsClosing, setIsVersionsClosing] = useState(false);
  const [versionSearch, setVersionSearch] = useState('');
  const [selectedVersion, setSelectedVersion] = useState<string>(() => readStoredString('canger_selected_version', '1.21.4'));
  const [versionFilter, setVersionFilter] = useState<'all' | 'release' | 'snapshot' | 'modded'>('all');

  const [newNick, setNewNick] = useState('');
  const [accounts, setAccounts] = useState<string[]>(() => readStoredStringArray('canger_accounts'));
  const [activeAccount, setActiveAccount] = useState<string>(() => readStoredString('canger_active_account', ''));
  const [deletingAccount, setDeletingAccount] = useState<string | null>(null);
  const [newlyAddedAccount, setNewlyAddedAccount] = useState<string | null>(null);

  const isLastAccountDeleting = accounts.length === 1 && accounts[0] === deletingAccount;
  const showEmpty = accounts.length === 0 || isLastAccountDeleting;

  const closeModal = () => {
    if (isModalClosing) return;
    setIsModalClosing(true);
    setTimeout(() => {
      setIsAddAccountOpen(false);
      setIsModalClosing(false);
    }, 200);
  };

  const CACHE_KEY = 'canger_cached_manifest_v8';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  const [allVersions, setAllVersions] = useState<MinecraftVersion[]>(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (
          cached
          && cached.schema === 8
          && Array.isArray(cached.versions)
          && cached.versions.length > 0
          && cached.versions.every((version: any) => (
            version && typeof version.id === 'string' && Array.isArray(version.tags)
          ))
        ) {
          return cached.versions;
        }
      }
    } catch { }
    return keepLatestLoaderCards([...MINECRAFT_VERSIONS, ...FALLBACK_MODDED_VERSIONS]);
  });

  const [installedVersions, setInstalledVersions] = useState<string[]>(() => readStoredStringArray('canger_installed_versions'));

  useEffect(() => {
    const matched = allVersions.find((version) => version.id === selectedVersion)
      || allVersions.find((version) => version.name === selectedVersion);
    if (matched && matched.id !== selectedVersion) {
      setSelectedVersion(matched.id);
      try { localStorage.setItem('canger_selected_version', matched.id); } catch { }
    }
  }, [allVersions, selectedVersion]);

  const [modsSubTab, setModsSubTab] = useState<'preset' | 'catalog' | 'installed'>('preset');
  const [modSearch, setModSearch] = useState('');
  const [installedMods, setInstalledMods] = useState<InstalledMod[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [catalogType, setCatalogType] = useState<'all' | 'mod' | 'modpack'>('all');
  const [catalogSource, setCatalogSource] = useState<'all' | 'modrinth' | 'curseforge'>('all');
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingMoreCatalog, setLoadingMoreCatalog] = useState(false);
  const [catalogMrOffset, setCatalogMrOffset] = useState(0);
  const [catalogCfIndex, setCatalogCfIndex] = useState(0);
  const [hasMoreCatalog, setHasMoreCatalog] = useState(true);
  const [installingModSlug, setInstallingModSlug] = useState<string | null>(null);
  const [installingStack, setInstallingStack] = useState(false);
  const [installingModpackId, setInstallingModpackId] = useState<string | null>(null);
  const [modpackProgress, setModpackProgress] = useState<{ current: number; total: number; title: string } | null>(null);
  const [stackProgress, setStackProgress] = useState<{ current: number; total: number } | null>(null);
  const [deletingMod, setDeletingMod] = useState<string | null>(null);
  const [presetCategory, setPresetCategory] = useState<string>('all');
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [dirContents, setDirContents] = useState<Record<string, DirItem[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({});
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [dragTargetFolder, setDragTargetFolder] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    relPath: string;
    name: string;
    isDir: boolean;
    parentPath: string;
  } | null>(null);
  const [isDeleteClosing, setIsDeleteClosing] = useState(false);
  const dragTargetFolderRef = useRef<string | null>(null);

  useEffect(() => {
    dragTargetFolderRef.current = dragTargetFolder;
  }, [dragTargetFolder]);

  const [downloadingVersion, setDownloadingVersion] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{ [versionName: string]: DownloadProgress }>({});
  const [sidebarVisibleCount, setSidebarVisibleCount] = useState(40);

  useEffect(() => {
    setSidebarVisibleCount(40);
  }, [versionFilter, versionSearch]);

  const handleSidebarScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 150) {
      setSidebarVisibleCount((prev) => Math.min(prev + 30, filteredVersionsSidebar.length));
    }
  };

  const loadMoreCatalog = async () => {
    if (loadingCatalog || loadingMoreCatalog || !hasMoreCatalog || catalogItems.length >= 1000) return;
    setLoadingMoreCatalog(true);
    try {
      const q = modSearch.trim();
      const res = await fetchCatalogSlice(
        q,
        'all',
        'all',
        catalogMrOffset,
        catalogCfIndex,
        2
      );
      setCatalogMrOffset(res.nextMrOffset);
      setCatalogCfIndex(res.nextCfIndex);
      if (!res.hasMore || res.items.length === 0) {
        setHasMoreCatalog(false);
      }
      setCatalogItems((prev) => {
        const existingIds = new Set(prev.map((it) => `${it.source}-${it.id}`));
        const filteredNew = res.items.filter((it) => !existingIds.has(`${it.source}-${it.id}`));
        const merged = [...prev, ...filteredNew];
        if (merged.length >= 1000) {
          setHasMoreCatalog(false);
          return merged.slice(0, 1000);
        }
        return merged;
      });
    } catch (e) {
      console.warn('Failed to load more catalog items:', e);
    } finally {
      setLoadingMoreCatalog(false);
    }
  };

  const displayMods: CatalogItem[] = useMemo(() => {
    if (catalogItems.length > 0) return catalogItems;
    if (modSearch.trim()) return [];
    return POPULAR_MODS_PRESET.map((p) => ({
      id: p.slug,
      slug: p.slug,
      title: p.title,
      description: p.desc,
      icon_url: p.icon,
      downloads: 10000000,
      type: 'mod',
      source: 'modrinth',
    }));
  }, [catalogItems, modSearch]);

  const handleCatalogScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (loadingCatalog || loadingMoreCatalog || !hasMoreCatalog || catalogItems.length >= 1000) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 250) {
      loadMoreCatalog();
    }
  };

  useEffect(() => {
    if (!tauriAvailable) return;
    let unlisten: (() => void) | undefined;
    listen<{ version: string; percent: number; current: number; total: number; stage?: string }>(
      'download-progress',
      (event) => {
        const { version, percent, current, total, stage } = event.payload || {};
        if (version) {
          setDownloadProgress((prev) => ({
            ...prev,
            [version]: {
              percent: Math.min(100, Math.max(0, percent || 0)),
              currentBytes: current,
              totalBytes: total,
              stage,
            },
          }));
          if (version.startsWith('Java')) {
            showToast('info', stage || version, `Прогресс: ${percent}%`);
          }
        }
      }
    ).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const [toast, setToast] = useState<ToastNotification | null>(null);

  const showToast = (type: 'success' | 'error' | 'info', title: string, message?: string) => {
    setToast({ id: String(Date.now()), type, title, message });
  };

  useEffect(() => {
    if (!tauriAvailable) return;
    let mounted = true;

    const bootstrap = async () => {
      try {
        const fromDisk = await invoke<string[]>('get_installed_versions');
        if (!mounted || !Array.isArray(fromDisk)) return;
        setInstalledVersions(fromDisk);
        try {
          localStorage.setItem('canger_installed_versions', JSON.stringify(fromDisk));
        } catch { }

        if (fromDisk.length > 0 && !fromDisk.includes(selectedVersion)) {
          const fallback = fromDisk[0];
          setSelectedVersion(fallback);
          try { localStorage.setItem('canger_selected_version', fallback); } catch { }
        }
      } catch (err) {
        console.log('Not running in Tauri or error checking installed versions:', err);
      }
    };

    void bootstrap();
    return () => { mounted = false; };
  }, []);

  const persistRam = (ramMb: number) => {
    if (ramMb === ram) return;
    try { localStorage.setItem('ram', String(ramMb)); } catch { }
  };
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!tauriAvailable) return;
    const unlisten = listen<string>('game-crashed', (event) => {
      showToast('error', 'Игра упала', event.payload);
      setIsLaunching(false);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const [isLaunching, setIsLaunching] = useState(false);

  const syncInstalledMods = async (version = selectedRuntimeVersion) => {
    const requestedVersion = version;
    try {
      const list = await invoke<InstalledMod[]>('get_installed_mods', {
        version: requestedVersion,
      });
      if (Array.isArray(list) && requestedVersion === selectedRuntimeVersionRef.current) {
        setInstalledMods(list);
      }
    } catch (err) {
      console.log('Not in Tauri or error checking installed mods:', err);
    }
  };

  useEffect(() => {
    if (tab === 'mods') {
      setInstalledMods([]);
      void syncInstalledMods();
    }
  }, [tab, selectedVersion, installedVersions]);

  useEffect(() => {
    if (tab !== 'mods') return;
    let active = true;
    setLoadingCatalog(true);
    setHasMoreCatalog(true);

    const timer = setTimeout(async () => {
      try {
        const q = modSearch.trim();
        const res = await fetchCatalogSlice(q, 'all', 'all', 0, 0, 2);
        if (active) {
          setCatalogMrOffset(res.nextMrOffset);
          setCatalogCfIndex(res.nextCfIndex);
          if (!res.hasMore || res.items.length === 0) {
            setHasMoreCatalog(false);
          }
          const items = res.items.slice(0, 1000);
          items.sort((a, b) => b.downloads - a.downloads);
          setCatalogItems(items);
        }
      } catch (e) {
        console.warn('Failed to load catalog:', e);
      } finally {
        if (active) setLoadingCatalog(false);
      }
    }, 350);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tab, modSearch]);

  const selectedVersionMeta = useMemo(
    () => allVersions.find((version) => version.id === selectedVersion)
      || allVersions.find((version) => version.name === selectedVersion),
    [allVersions, selectedVersion]
  );

  const selectedRuntimeVersion = useMemo(() => {
    const meta = allVersions.find((version) => version.id === selectedVersion)
      || allVersions.find((version) => version.name === selectedVersion);
    if (!meta) return selectedVersion;
    if (!installedVersions.includes(meta.id) && installedVersions.includes(meta.name)) {
      return meta.name;
    }
    return meta.id;
  }, [allVersions, selectedVersion, installedVersions]);

  const selectedRuntimeVersionRef = useRef(selectedRuntimeVersion);
  useEffect(() => {
    selectedRuntimeVersionRef.current = selectedRuntimeVersion;
  }, [selectedRuntimeVersion]);

  const currentMcVersion = useMemo(() => {
    if (selectedVersionMeta?.minecraftVersion) return selectedVersionMeta.minecraftVersion;
    if (!selectedVersion) return '1.21.4';
    const match = selectedVersion.match(/\d+\.\d+(\.\d+)?/);
    return match ? match[0] : '1.21.4';
  }, [selectedVersion, selectedVersionMeta]);

  const currentLoader = useMemo(() => {
    if (selectedVersionMeta?.loader) return selectedVersionMeta.loader;
    return 'vanilla';
  }, [selectedVersionMeta]);

  const detectModVersion = (filename: string): string | null => {
    const mcMatch = filename.match(/\+?mc(\d+\.\d+(\.\d+)?)/i);
    if (mcMatch) return mcMatch[1];
    const dashMatch = filename.match(/[-_](\d+\.\d+(\.\d+)?)\.jar/i);
    if (dashMatch) return dashMatch[1];
    return null;
  };

  const mismatchedInstalledMods = useMemo(() => {
    return installedMods.filter((m) => {
      const v = detectModVersion(m.filename);
      return v && v !== currentMcVersion;
    });
  }, [installedMods, currentMcVersion]);

  const isModInstalled = (slug: string) => {
    const s = slug.toLowerCase().replace(/[-_]/g, '');
    return installedMods.some((m) => {
      const fn = m.filename.toLowerCase().replace(/[-_]/g, '');
      return fn.includes(s);
    });
  };

  const isFpsStackInstalled = useMemo(() => {
    const coreSlugs = ['sodium', 'lithium', 'ferrite-core', 'iris', 'immediatelyfast', 'entityculling'];
    return coreSlugs.every((s) => isModInstalled(s));
  }, [installedMods]);

  const resolveAndInstallDependencies = async (
    versionObj: any,
    mcVer: string,
    loader: string,
    visitedSlugs: Set<string>,
    installedFilenames?: Set<string>
  ): Promise<string[]> => {
    const installedDepNames: string[] = [];
    const seen = installedFilenames || new Set<string>(
      installedMods.map((m) => m.filename.toLowerCase())
    );
    if (!versionObj?.dependencies || !Array.isArray(versionObj.dependencies)) {
      return installedDepNames;
    }

    const pickForMc = (list: any[]): any | null => {
      if (!Array.isArray(list) || list.length === 0) return null;
      const forMc = list.filter((x: any) => (x.game_versions || []).includes(mcVer));
      const pool = forMc.length > 0 ? forMc : [];
      if (pool.length === 0) return null;
      return pool.find((x: any) => x.version_type === 'release') || pool[0];
    };

    for (const dep of versionObj.dependencies) {
      if (dep.dependency_type !== 'required') continue;

      if (dep.version_id) {
        if (visitedSlugs.has(dep.version_id)) continue;
        visitedSlugs.add(dep.version_id);

        try {
          const vRes = await fetch(`https://api.modrinth.com/v2/version/${encodeURIComponent(dep.version_id)}`);
          if (vRes.ok) {
            const vData = await vRes.json();
            const file = (vData.files || []).find((f: any) => f.primary) || vData.files?.[0];
            if (file?.url && file?.filename) {
              const key = file.filename.toLowerCase();
              if (!seen.has(key)) {
                seen.add(key);
                await invoke('install_mod_file', { url: file.url, filename: file.filename, version: selectedRuntimeVersion, ...modFileIntegrity(file) });
                installedDepNames.push(file.filename);
              }
              const subDeps = await resolveAndInstallDependencies(vData, mcVer, loader, visitedSlugs, seen);
              installedDepNames.push(...subDeps);
            }
          }
        } catch (err) {
          console.warn('Failed to resolve dependency by version_id:', dep.version_id, err);
        }
      } else if (dep.project_id) {
        if (visitedSlugs.has(dep.project_id)) continue;
        visitedSlugs.add(dep.project_id);

        try {
          const pRes = await fetch(
            `https://api.modrinth.com/v2/project/${encodeURIComponent(dep.project_id)}/version?loaders=${encodeURIComponent(JSON.stringify([loader]))}`
          );
          const pList = pRes.ok ? await pRes.json() : [];
          const rel = pickForMc(pList);
          if (!rel) {
            console.warn(`Зависимость ${dep.project_id}: нет сборки под ${mcVer}/${loader} — пропущена`);
            continue;
          }
          const file = (rel.files || []).find((f: any) => f.primary) || rel.files?.[0];
          if (file?.url && file?.filename) {
            const key = file.filename.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              await invoke('install_mod_file', { url: file.url, filename: file.filename, version: selectedRuntimeVersion, ...modFileIntegrity(file) });
              installedDepNames.push(file.filename);
            }
            const subDeps = await resolveAndInstallDependencies(rel, mcVer, loader, visitedSlugs, seen);
            installedDepNames.push(...subDeps);
          }
        } catch (err) {
          console.warn('Failed to resolve dependency by project_id:', dep.project_id, err);
        }
      }
    }

    return installedDepNames;
  };

  const handleInstallMod = async (slug: string, title?: string) => {
    if (installingModSlug) return;
    setInstallingModSlug(slug);
    try {
      const loader = currentLoader;
      const mcVer = currentMcVersion;
      if (loader === 'vanilla') {
        throw new Error('Vanilla не поддерживает моды — выберите Fabric или Forge');
      }

      const vRes = await fetch(
        `https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVer]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`
      );
      const vList = vRes.ok ? await vRes.json() : [];
      const compatible = Array.isArray(vList)
        ? vList.filter((version: any) => (version.game_versions || []).includes(mcVer))
        : [];
      if (compatible.length === 0) {
        throw new Error(`Не найдена сборка для ${slug} (${mcVer}/${loader})`);
      }

      const rel = compatible.find((version: any) => version.version_type === 'release') || compatible[0];
      const file = (rel.files || []).find((f: any) => f.primary) || rel.files[0];
      if (!file || !file.url) {
        throw new Error(`Файл не найден для ${slug}`);
      }

      const visitedSlugs = new Set<string>([slug]);
      const deps = await resolveAndInstallDependencies(rel, mcVer, loader, visitedSlugs);

      await invoke('install_mod_file', {
        url: file.url,
        filename: file.filename,
        version: selectedRuntimeVersion,
        ...modFileIntegrity(file),
      });

      await syncInstalledMods();
      const depMsg = deps.length > 0 ? ` (+ ${deps.length} зависимостей)` : '';
      showToast('success', 'Мод установлен', `${title || slug}${depMsg}`);
    } catch (err: any) {
      console.error('Install mod error:', err);
      showToast('error', `Ошибка установки ${title || slug}`, err?.message || String(err));
    } finally {
      setInstallingModSlug(null);
    }
  };

  const handleInstallPresetStack = async () => {
    if (installingStack) return;
    setInstallingStack(true);
    const coreSlugs = ['sodium', 'lithium', 'ferrite-core', 'iris', 'immediatelyfast', 'entityculling'];
    setStackProgress({ current: 0, total: coreSlugs.length });
    const loader = currentLoader;
    const mcVer = currentMcVersion;
    if (loader === 'vanilla') {
      setInstallingStack(false);
      setStackProgress(null);
      showToast('error', 'Vanilla не поддерживает моды', 'Выберите Fabric или Forge');
      return;
    }

    let installedCount = 0;
    const visitedSlugs = new Set<string>();

    for (let i = 0; i < coreSlugs.length; i++) {
      const slug = coreSlugs[i];
      setStackProgress({ current: i + 1, total: coreSlugs.length });
      try {
        const vRes = await fetch(
          `https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVer]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`
        );
        const vList = vRes.ok ? await vRes.json() : [];
        const compatible = Array.isArray(vList)
          ? vList.filter((version: any) => (version.game_versions || []).includes(mcVer))
          : [];
        if (compatible.length > 0) {
          const rel = compatible.find((version: any) => version.version_type === 'release') || compatible[0];
          const file = (rel.files || []).find((f: any) => f.primary) || rel.files[0];
          if (file && file.url) {
            visitedSlugs.add(slug);
            await resolveAndInstallDependencies(rel, mcVer, loader, visitedSlugs);
            await invoke('install_mod_file', { url: file.url, filename: file.filename, version: selectedRuntimeVersion, ...modFileIntegrity(file) });
            installedCount++;
          }
        }
      } catch (err) {
        console.warn(`Failed to install stack mod ${slug}:`, err);
      }
    }

    await syncInstalledMods();
    setInstallingStack(false);
    setStackProgress(null);
    if (installedCount > 0) {
      showToast('success', `FPS Стек установлен (${mcVer})`, `Успешно установлено ${installedCount} из ${coreSlugs.length} модов со всеми зависимостями`);
    } else {
      showToast('error', 'Стек не установлен', `Не найдено совместимых сборок для ${mcVer}/${loader}`);
    }
  };

  const handleInstallCfMod = async (cfId: number, title?: string) => {
    if (installingModSlug) return;
    setInstallingModSlug(String(cfId));
    try {
      const mcVer = currentMcVersion;
      const loader = currentLoader;
      if (loader === 'vanilla') {
        throw new Error('Vanilla не поддерживает моды — выберите Fabric или Forge');
      }

      const endpoint = `mods/${cfId}/files`;
      const responseText = await invoke<string>('fetch_curseforge_api', { endpoint });
      const data = JSON.parse(responseText);
      const files: any[] = data.data || [];
      if (files.length === 0) throw new Error('Нет доступных файлов для этого мода');

      const matched = files.find((file: any) => {
        const gameVersions = (file.gameVersions || []).map((value: string) => value.toLowerCase());
        return gameVersions.includes(mcVer) && gameVersions.includes(loader);
      });
      if (!matched) {
        throw new Error(`Нет файла для ${mcVer}/${loader}`);
      }

      let downloadUrl = matched.downloadUrl;
      let fileName = matched.fileName;

      if (!downloadUrl) {
        const dlEndpoint = `mods/${cfId}/files/${matched.id}/download-url`;
        const dlResponseText = await invoke<string>('fetch_curseforge_api', { endpoint: dlEndpoint });
        const dlData = JSON.parse(dlResponseText);
        downloadUrl = dlData.data;
      }

      if (!downloadUrl) throw new Error('CurseForge не предоставил ссылку на скачивание');

      await invoke('install_mod_file', { url: downloadUrl, filename: fileName, version: selectedRuntimeVersion, ...curseFileIntegrity(matched) });
      await syncInstalledMods();
      showToast('success', 'Мод установлен', title || fileName);
    } catch (err: any) {
      showToast('error', `Ошибка установки ${title || cfId}`, err?.message || String(err));
    } finally {
      setInstallingModSlug(null);
    }
  };

  const handleInstallModpack = async (item: CatalogItem) => {
    if (installingModpackId) return;
    setInstallingModpackId(item.id);
    setModpackProgress({ current: 0, total: 1, title: item.title });

    try {
      const mcVer = currentMcVersion;
      const loader = currentLoader;
      if (loader === 'vanilla') {
        throw new Error('Vanilla не поддерживает сборки модов — выберите Fabric или Forge');
      }

      if (item.source === 'modrinth') {
        const vRes = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(item.slug)}/version`);
        if (!vRes.ok) throw new Error('Не удалось получить версии сборки');
        const vList = await vRes.json();
        if (!Array.isArray(vList) || vList.length === 0) throw new Error('Сборка не содержит файлов версий');

        const ver = vList.find((version: any) => (
          (version.game_versions || []).includes(mcVer)
          && (version.loaders || []).includes(loader)
        ));
        if (!ver) throw new Error(`Нет сборки для ${mcVer}/${loader}`);

        const mrpackFile = (ver.files || []).find((file: any) => file.filename?.endsWith('.mrpack'));
        if (!mrpackFile?.url) throw new Error('Файл .mrpack не найден');

        const packRes = await fetch(mrpackFile.url);
        if (!packRes.ok) throw new Error('Не удалось скачать файл сборки');
        if (Number(packRes.headers.get('content-length') || 0) > MAX_MODPACK_BYTES) {
          throw new Error('Архив сборки превышает 100 МБ');
        }
        const ab = await packRes.arrayBuffer();
        if (ab.byteLength > MAX_MODPACK_BYTES) throw new Error('Архив сборки превышает 100 МБ');

        const zip = await JSZip.loadAsync(ab);
        const indexFile = zip.file('modrinth.index.json');
        if (!indexFile) throw new Error('В архиве отсутствует modrinth.index.json');

        const indexText = await indexFile.async('string');
        const index = JSON.parse(indexText);
        if (index.gameVersion && index.gameVersion !== mcVer) {
          throw new Error(`Сборка предназначена для ${index.gameVersion}, а не ${mcVer}`);
        }
        if (index.loader && String(index.loader).toLowerCase() !== loader) {
          throw new Error(`Сборка не поддерживает ${loader}`);
        }
        const dependencies = index.dependencies && typeof index.dependencies === 'object'
          ? Object.values(index.dependencies)
          : [];
        const packFiles = (dependencies as any[])
          .flatMap((dependency: any) => Array.isArray(dependency?.files) ? dependency.files : [])
          .filter((file: any) => file.path && typeof file.path === 'string' && !file.path.includes('..') && !file.path.startsWith('/'));
        const modFiles = packFiles.filter((file: any) => file.path.startsWith('mods/'));
        if (modFiles.length > 1000) throw new Error('В сборке слишком много модов');

        if (modFiles.length === 0) throw new Error('В сборке не найдено модов в папке mods');

        const overrideEntries = Object.values(zip.files).filter((entry) => {
          if (entry.dir) return false;
          if (!entry.name.startsWith('overrides/')) return false;
          const relative = entry.name.slice('overrides/'.length);
          return relative.length > 0 && !relative.includes('..') && !relative.startsWith('/');
        });

        setModpackProgress({ current: 0, total: modFiles.length + overrideEntries.length, title: item.title });

        const failed: string[] = [];
        let installed = 0;
        const total = modFiles.length + overrideEntries.length;
        for (let i = 0; i < total; i++) {
          setModpackProgress({ current: i + 1, total, title: item.title });
          if (i < modFiles.length) {
            const mf = modFiles[i];
            const filename = mf.path.replace(/^mods\//, '');
            const dlUrl = mf.downloads?.[0];
            if (dlUrl && filename) {
              try {
                await invoke('install_mod_file', { url: dlUrl, filename, version: selectedRuntimeVersion, ...modFileIntegrity(mf) });
                installed++;
              } catch (e) {
                failed.push(filename);
                console.warn('Failed to install mod from pack:', filename, e);
              }
            } else {
              failed.push(filename || mf.path);
            }
          } else {
            const entry = overrideEntries[i - modFiles.length];
            const relative = entry.name.replace(/^overrides\//, '');
            try {
              const bytes = await entry.async('uint8array');
              let binary = '';
              const chunkSize = 0x8000;
              for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
              }
              await invoke('write_game_file', {
                relativePath: relative,
                contentsBase64: btoa(binary),
                version: selectedRuntimeVersion,
              });
            } catch (e) {
              console.warn('Failed to apply pack override:', relative, e);
            }
          }
        }

        await syncInstalledMods();
        if (failed.length > 0) {
          showToast('error', `Сборка "${item.title}" установлена частично`, `Установлено ${installed} из ${modFiles.length} модов, не удалось: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ` и ещё ${failed.length - 3}` : ''}`);
        } else {
          showToast('success', `Сборка "${item.title}" установлена`, `Успешно установлено ${installed} из ${modFiles.length} модов${overrideEntries.length > 0 ? ` и применено ${overrideEntries.length} файлов настроек` : ''}`);
        }
      } else if (item.source === 'curseforge' && item.cfId) {
        const fEndpoint = `mods/${item.cfId}/files`;
        const fResponseText = await invoke<string>('fetch_curseforge_api', { endpoint: fEndpoint });
        const fData = JSON.parse(fResponseText);
        const files: any[] = fData.data || [];
        if (files.length === 0) throw new Error('Файлы сборки не найдены');

        const matchedFile = files.find((file: any) => {
          const gameVersions = (file.gameVersions || []).map((value: string) => value.toLowerCase());
          return gameVersions.includes(mcVer) && gameVersions.includes(loader);
        });
        if (!matchedFile) throw new Error(`Нет сборки для ${mcVer}/${loader}`);
        let dlUrl = matchedFile.downloadUrl;
        if (!dlUrl) {
          const dlEndpoint = `mods/${item.cfId}/files/${matchedFile.id}/download-url`;
          const dlResponseText = await invoke<string>('fetch_curseforge_api', { endpoint: dlEndpoint });
          const dlData = JSON.parse(dlResponseText);
          dlUrl = dlData.data;
        }
        if (!dlUrl) throw new Error('CurseForge не предоставил ссылку на скачивание архива сборки');

        const zipRes = await fetch(dlUrl);
        if (!zipRes.ok) throw new Error('Не удалось скачать zip сборки');
        if (Number(zipRes.headers.get('content-length') || 0) > MAX_MODPACK_BYTES) {
          throw new Error('Архив сборки превышает 100 МБ');
        }
        const ab = await zipRes.arrayBuffer();
        if (ab.byteLength > MAX_MODPACK_BYTES) throw new Error('Архив сборки превышает 100 МБ');

        const zip = await JSZip.loadAsync(ab);
        const manifestFile = zip.file('manifest.json');
        if (!manifestFile) throw new Error('В архиве отсутствует manifest.json');

        const manifestText = await manifestFile.async('string');
        const manifest = JSON.parse(manifestText);
        if (manifest.minecraft?.version && manifest.minecraft.version !== mcVer) {
          throw new Error(`Сборка предназначена для ${manifest.minecraft.version}, а не ${mcVer}`);
        }
        const manifestLoaders = (manifest.modLoaders || []).map((value: any) => String(value.id || value).toLowerCase());
        if (manifestLoaders.length > 0 && !manifestLoaders.includes(loader)) {
          throw new Error(`Сборка не поддерживает ${loader}`);
        }
        const modEntries: any[] = manifest.files || [];
        if (modEntries.length > 1000) throw new Error('В сборке слишком много модов');

        setModpackProgress({ current: 0, total: modEntries.length, title: item.title });

        const failedCf: string[] = [];
        let installed = 0;
        for (let i = 0; i < modEntries.length; i++) {
          const entry = modEntries[i];
          setModpackProgress({ current: i + 1, total: modEntries.length, title: item.title });
          try {
            const infoEndpoint = `mods/${entry.projectID}/files/${entry.fileID}`;
            const infoResponseText = await invoke<string>('fetch_curseforge_api', { endpoint: infoEndpoint });
            const infoData = JSON.parse(infoResponseText);
            const fInfo = infoData.data;
            let fileDl = fInfo?.downloadUrl;
            if (!fileDl) {
              const uEndpoint = `mods/${entry.projectID}/files/${entry.fileID}/download-url`;
              const uResponseText = await invoke<string>('fetch_curseforge_api', { endpoint: uEndpoint });
              const uData = JSON.parse(uResponseText);
              fileDl = uData.data;
            }
            if (fileDl && fInfo?.fileName) {
              await invoke('install_mod_file', { url: fileDl, filename: fInfo.fileName, version: selectedRuntimeVersion, ...curseFileIntegrity(fInfo) });
              installed++;
            } else {
              failedCf.push(String(entry.fileID));
            }
          } catch (e) {
            failedCf.push(String(entry.fileID));
            console.warn('Failed to install CF mod from manifest:', entry, e);
          }
        }

        await syncInstalledMods();
        if (failedCf.length > 0) {
          showToast('error', `Сборка "${item.title}" установлена частично`, `Установлено ${installed} из ${modEntries.length} модов, не удалось: ${failedCf.slice(0, 3).join(', ')}${failedCf.length > 3 ? ` и ещё ${failedCf.length - 3}` : ''}`);
        } else {
          showToast('success', `Сборка "${item.title}" установлена`, `Успешно установлено ${installed} из ${modEntries.length} модов`);
        }
      }
    } catch (err: any) {
      console.error('Install modpack error:', err);
      showToast('error', `Ошибка установки сборки ${item.title}`, err?.message || String(err));
    } finally {
      setInstallingModpackId(null);
      setModpackProgress(null);
    }
  };

  const handleInstallCatalogItem = (item: CatalogItem) => {
    if (item.type === 'modpack') {
      handleInstallModpack(item);
    } else {
      if (item.source === 'modrinth') {
        handleInstallMod(item.slug, item.title);
      } else if (item.cfId) {
        handleInstallCfMod(item.cfId, item.title);
      }
    }
  };

  const handleUpdateModsToCurrentVersion = async () => {
    if (installingStack) return;
    setInstallingStack(true);
    const mcVer = currentMcVersion;
    const loader = currentLoader;
    if (loader === 'vanilla') {
      setInstallingStack(false);
      showToast('error', 'Vanilla не поддерживает моды', 'Выберите Fabric или Forge');
      return;
    }

    const slugsToUpdate = new Set<string>();
    for (const m of mismatchedInstalledMods) {
      for (const p of POPULAR_MODS_PRESET) {
        if (m.filename.toLowerCase().includes(p.slug.replace(/[-_]/g, ''))) {
          slugsToUpdate.add(p.slug);
        }
      }
    }
    if (slugsToUpdate.size === 0) {
      setInstallingStack(false);
      showToast('info', 'Обновлять нечего', 'Не найдено модов с другой версией Minecraft');
      return;
    }

    const slugs = Array.from(slugsToUpdate);
    setStackProgress({ current: 0, total: slugs.length });

    let updatedCount = 0;
    const visitedSlugs = new Set<string>();

    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      setStackProgress({ current: i + 1, total: slugs.length });
      try {
        const vRes = await fetch(
          `https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVer]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`
        );
        const vList = vRes.ok ? await vRes.json() : [];
        const compatible = Array.isArray(vList)
          ? vList.filter((version: any) => (version.game_versions || []).includes(mcVer))
          : [];
        if (compatible.length > 0) {
          const rel = compatible.find((version: any) => version.version_type === 'release') || compatible[0];
          const file = (rel.files || []).find((f: any) => f.primary) || rel.files[0];
          if (file?.url && file?.filename) {
            visitedSlugs.add(slug);
            await resolveAndInstallDependencies(rel, mcVer, loader, visitedSlugs);
            await invoke('install_mod_file', { url: file.url, filename: file.filename, version: selectedRuntimeVersion, ...modFileIntegrity(file) });
            const normalizedSlug = slug.replace(/[-_]/g, '');
            for (const oldMod of mismatchedInstalledMods) {
              if (oldMod.filename.toLowerCase().replace(/[-_]/g, '').includes(normalizedSlug)) {
                await invoke('delete_mod', { filename: oldMod.filename, version: selectedRuntimeVersion })
                  .catch((error) => console.warn('Failed to delete old mod:', oldMod.filename, error));
              }
            }
            updatedCount++;
          }
        }
      } catch (err) {
        console.warn(`Failed to update mod ${slug}:`, err);
      }
    }

    await syncInstalledMods();
    setInstallingStack(false);
    setStackProgress(null);
    if (updatedCount > 0) {
      showToast('success', `Моды обновлены под ${mcVer}`, `Успешно обновлено ${updatedCount} модов для ${mcVer}`);
    } else {
      showToast('error', 'Моды не обновлены', `Не найдено совместимых сборок для ${mcVer}/${loader}`);
    }
  };

  const handleToggleMod = async (filename: string, enable: boolean) => {
    try {
      const newFilename = await invoke<string>('toggle_mod', { filename, enable, version: selectedRuntimeVersion });
      setInstalledMods((prev) =>
        prev.map((m) =>
          m.filename === filename
            ? {
                ...m,
                filename: newFilename,
                enabled: enable,
                name: enable ? newFilename.replace(/\.jar$/, '') : newFilename.replace(/\.jar\.disabled$/, ''),
              }
            : m
        )
      );
    } catch (err: any) {
      showToast('error', 'Ошибка изменения мода', err?.message || String(err));
    }
  };

  const openDeleteModConfirm = (filename: string) => {
    setConfirmDeleteMod(filename);
  };

  const closeDeleteModConfirm = () => {
    setIsConfirmClosing(true);
    setTimeout(() => {
      setConfirmDeleteMod(null);
      setIsConfirmClosing(false);
    }, 180);
  };

  const handleDeleteMod = async (filename: string) => {
    setDeletingMod(filename);
    setTimeout(async () => {
      try {
        await invoke('delete_mod', { filename, version: selectedRuntimeVersion });
        setInstalledMods((prev) => prev.filter((m) => m.filename !== filename));
        showToast('info', 'Мод удален', filename);
      } catch (err: any) {
        showToast('error', 'Ошибка удаления мода', err?.message || String(err));
      } finally {
        setDeletingMod(null);
      }
    }, 350);
  };

  const handleOpenModsFolder = async () => {
    try {
      await invoke('open_mods_folder', { version: selectedRuntimeVersion });
    } catch (err: any) {
      showToast('error', 'Не удалось открыть папку', err?.message || String(err));
    }
  };

  const toggleDir = async (path: string) => {
    const isCurrentlyExpanded = !!expandedDirs[path];
    if (isCurrentlyExpanded) {
      setExpandedDirs((prev) => ({ ...prev, [path]: false }));
      return;
    }

    setExpandedDirs((prev) => ({ ...prev, [path]: true }));

    if (!dirContents[path]) {
      setLoadingDirs((prev) => ({ ...prev, [path]: true }));
      try {
        const items = await invoke<DirItem[]>('list_dir_contents', { subpath: path || null, version: selectedRuntimeVersion });
        setDirContents((prev) => ({ ...prev, [path]: items }));
      } catch (err: any) {
        showToast('error', 'Не удалось открыть папку', err?.message || String(err));
      } finally {
        setLoadingDirs((prev) => ({ ...prev, [path]: false }));
      }
    }
  };

  const refreshDir = async (
    path: string,
    version = selectedRuntimeVersion,
  ) => {
    try {
      const items = await invoke<DirItem[]>('list_dir_contents', { subpath: path || null, version });
      setDirContents((prev) => ({ ...prev, [path]: items }));
    } catch (err) {
      console.error('Failed to refresh dir:', err);
    }
  };

  useEffect(() => {
    if (!tauriAvailable) return;
    let unlisteners: (() => void)[] = [];

    const setupDragDrop = async () => {
      try {
        const uEnter = await listen<any>('tauri://drag-enter', () => {
          setIsDraggingFiles(true);
        });

        const uOver = await listen<any>('tauri://drag-over', (event) => {
          const pos = event.payload?.position;
          if (pos && typeof pos.x === 'number') {
            const x = pos.x / window.devicePixelRatio;
            const y = pos.y / window.devicePixelRatio;
            const el = document.elementFromPoint(x, y);
            const folderEl = el?.closest('[data-folder-path]');
            const newTarget = folderEl ? (folderEl.getAttribute('data-folder-path') ?? '') : '';
            if (dragTargetFolderRef.current !== newTarget) {
              setDragTargetFolder(newTarget);
              dragTargetFolderRef.current = newTarget;
            }
          }
        });

        const uDrop = await listen<any>('tauri://drag-drop', async (event) => {
          setIsDraggingFiles(false);
          const pos = event.payload?.position;
          let target = dragTargetFolderRef.current ?? '';
          if (pos && typeof pos.x === 'number') {
            const x = pos.x / window.devicePixelRatio;
            const y = pos.y / window.devicePixelRatio;
            const el = document.elementFromPoint(x, y);
            const folderEl = el?.closest('[data-folder-path]');
            if (folderEl) {
              target = folderEl.getAttribute('data-folder-path') ?? '';
            }
          }

          setDragTargetFolder(null);
          dragTargetFolderRef.current = null;

          const droppedPaths: string[] = event.payload?.paths || [];
          if (!droppedPaths || droppedPaths.length === 0) return;
          const version = selectedRuntimeVersionRef.current;

          try {
            const imported = await invoke<string[]>('import_game_files', {
              sourcePaths: droppedPaths,
              targetSubpath: target || null,
              version,
            });
            const targetName = target ? target.split(/[\\/]/).pop() : '.minecraft';
            showToast(
              'success',
              'Файлы скопированы',
              `Добавлено ${imported.length} эл. в "${targetName}"`
            );
            await refreshDir(target, version);
            setExpandedDirs((prev) => ({
              ...prev,
              '': true,
              ...(target ? { [target]: true } : {}),
            }));
            if (target === 'mods' || target === '') {
              syncInstalledMods(version);
            }
          } catch (err: any) {
            showToast('error', 'Ошибка импорта', err?.message || String(err));
          }
        });

        const uLeave = await listen<any>('tauri://drag-leave', () => {
          setIsDraggingFiles(false);
          setDragTargetFolder(null);
          dragTargetFolderRef.current = null;
        });

        unlisteners = [uEnter, uOver, uDrop, uLeave];
      } catch (e) {
        console.error('Failed to setup drag and drop listener:', e);
      }
    };

    setupDragDrop();

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const handleOpenGamePath = async (relPath: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      await invoke('open_game_path', { relativePath: relPath || null, version: selectedRuntimeVersion });
    } catch (err: any) {
      showToast('error', 'Не удалось открыть', err?.message || String(err));
    }
  };

  const openDeleteModal = (
    relPath: string,
    name: string,
    isDir: boolean,
    parentPath: string,
    e?: React.MouseEvent
  ) => {
    if (e) e.stopPropagation();
    setDeleteTarget({ relPath, name, isDir, parentPath });
  };

  const closeDeleteModal = () => {
    setIsDeleteClosing(true);
    setTimeout(() => {
      setDeleteTarget(null);
      setIsDeleteClosing(false);
    }, 180);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const { relPath, name, isDir, parentPath } = deleteTarget;
    closeDeleteModal();
    try {
      await invoke('delete_game_path', { relativePath: relPath, version: selectedRuntimeVersion });
      showToast('info', 'Удалено', `${isDir ? 'Папка' : 'Файл'} "${name}" успешно удален(а)`);
      const items = await invoke<DirItem[]>('list_dir_contents', { subpath: parentPath || null, version: selectedRuntimeVersion });
      setDirContents((prev) => ({ ...prev, [parentPath]: items }));
    } catch (err: any) {
      showToast('error', 'Ошибка удаления', err?.message || String(err));
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const renderDirBranch = (parentPath: string, level: number = 0): React.ReactNode => {
    const items = dirContents[parentPath] || [];
    const isLoading = loadingDirs[parentPath];

    if (isLoading) {
      return (
        <div className="folder-tree-loading">
          <div className="mod-spinner-small" />
          <span>Загрузка содержимого...</span>
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="folder-tree-empty">
          <span>Папка пуста</span>
        </div>
      );
    }

    return (
      <div className="folder-tree-branches">
        {items.map((item) => {
          const isOpen = !!expandedDirs[item.path];
          const isDragTarget = dragTargetFolder === item.path;
          return (
            <div key={item.path} className="folder-tree-node">
              <div
                className={`folder-tree-row ${item.is_dir ? 'is-dir' : 'is-file'}${isDragTarget ? ' drag-over' : ''}`}
                data-folder-path={item.is_dir ? item.path : parentPath}
                role={item.is_dir ? 'button' : undefined}
                tabIndex={item.is_dir ? 0 : undefined}
                aria-expanded={item.is_dir ? isOpen : undefined}
                onClick={() => {
                  if (item.is_dir) {
                    toggleDir(item.path);
                  }
                }}
                onKeyDown={(event) => {
                  if (item.is_dir && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    void toggleDir(item.path);
                  }
                }}
              >
                <div className="folder-tree-row-left">
                  {item.is_dir ? (
                    <svg viewBox="0 0 24 24" className="folder-tree-row-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="folder-tree-row-icon file-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
                      <polyline points="13 2 13 9 20 9" />
                    </svg>
                  )}
                  <span className="folder-tree-row-name" title={item.name}>{item.name}</span>
                  {!item.is_dir && item.size > 0 && (
                    <span className="folder-tree-file-size">{formatFileSize(item.size)}</span>
                  )}
                </div>
                <div
                  className="folder-tree-row-right"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="folder-row-action-btn delete-btn"
                    onClick={(e) => openDeleteModal(item.path, item.name, item.is_dir, parentPath, e)}
                    aria-label={`Удалить ${item.is_dir ? 'папку' : 'файл'} ${item.name}`}
                    title="Удалить"
                  >
                    <svg viewBox="0 0 24 24" className="folder-tree-action-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                  {item.is_dir && (
                    <div
                      className={`folder-tree-chevron-wrap${isOpen ? ' open' : ''}`}
                      aria-hidden="true"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleDir(item.path);
                      }}
                      title={isOpen ? 'Свернуть' : 'Развернуть'}
                    >
                      <svg viewBox="0 0 24 24" className="folder-chevron-icon" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                  )}
                </div>
              </div>

              {item.is_dir && (
                <div className={`folder-expandable-wrap${isOpen ? ' open' : ''}`}>
                  <div className="folder-expandable-inner">
                    {(isOpen || dirContents[item.path]) && renderDirBranch(item.path, level + 1)}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const formatDownloads = (num: number) => {
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(0) + 'K';
    return String(num);
  };

  const filteredPresetMods = useMemo(() => {
    let list = POPULAR_MODS_PRESET;
    if (presetCategory !== 'all') {
      list = list.filter((m) => m.category === presetCategory);
    }
    if (!modSearch.trim()) return list;
    const q = modSearch.trim().toLowerCase();
    return list.filter(
      (m) => m.title.toLowerCase().includes(q) || m.desc.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)
    );
  }, [modSearch, presetCategory]);

  const filteredInstalledMods = useMemo(() => {
    if (!modSearch.trim()) return installedMods;
    const q = modSearch.trim().toLowerCase();
    return installedMods.filter(
      (m) => m.name.toLowerCase().includes(q) || m.filename.toLowerCase().includes(q)
    );
  }, [installedMods, modSearch]);

  const handlePlay = async () => {
    if (isLaunching) return;
    if (!activeAccount) {
      setIsAddAccountOpen(true);
      return;
    }
    if (!installedVersions.includes(selectedRuntimeVersion)) {
      openVersionsModal();
      return;
    }

    setIsLaunching(true);
    try {
      const res: string = await invoke('launch_game', {
        versionName: selectedRuntimeVersion,
        nickname: activeAccount,
        ramMb: ram,
      });
      showToast('success', 'Игра запущена', res);
    } catch (err: any) {
      console.error('Launch error:', err);
      showToast('error', 'Ошибка запуска', err?.message || String(err));
    } finally {
      setIsLaunching(false);
    }
  };

  const handleDownloadVersion = async (v: MinecraftVersion, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (downloadingVersion) return;

    if (v.loader === 'forge' && v.headlessSupported === false) {
      showToast(
        'error',
        'Forge требует ручной установки',
        'Официальный installer до 1.13 не поддерживает безопасную автоматическую установку. Используйте Java 8 и запустите installer вручную.'
      );
      return;
    }

    setDownloadingVersion(v.id);
    setDownloadProgress((prev) => ({
      ...prev,
      [v.id]: {
        percent: 2,
        currentBytes: 0,
        totalBytes: v.clientSize || 0,
        stage: v.loader === 'forge'
          ? 'Поиск официального Forge...'
          : v.loader === 'neoforge'
            ? 'Поиск официального NeoForge...'
            : 'Подготовка...',
      },
    }));

    try {
      let installedVersionId = v.id;

      if (v.loader === 'neoforge') {
        if (!v.minecraftVersion || !v.neoforgeVersion) {
          throw new Error('Не удалось определить версию Minecraft или NeoForge');
        }
        const result = await invoke<NeoForgeInstallResult>('install_neoforge', {
          minecraftVersion: v.minecraftVersion,
          neoforgeVersion: v.neoforgeVersion,
        });
        installedVersionId = result.profileId;
      } else if (v.loader === 'forge') {
        if (!v.minecraftVersion || !v.forgeVersion) {
          throw new Error('Не удалось определить версию Minecraft или Forge');
        }
        const result = await invoke<ForgeInstallResult>('install_forge', {
          minecraftVersion: v.minecraftVersion,
          forgeVersion: v.forgeVersion,
        });
        installedVersionId = result.profileId;
      } else {
        let clientUrl = v.clientUrl;
        const packageUrl = v.packageUrl;
        let vanillaPackageUrl = v.vanillaPackageUrl;
        let expectedSize = v.clientSize;

        const manifestVersionId = v.type === 'modded' ? v.minecraftVersion : v.id;
        if (!vanillaPackageUrl && manifestVersionId) {
          try {
            const manifestResponse = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
            if (manifestResponse.ok) {
              const manifest = await manifestResponse.json();
              const release = Array.isArray(manifest?.versions)
                ? manifest.versions.find((entry: any) => (
                  entry?.id === manifestVersionId && entry?.type === 'release'
                ))
                : null;
              if (typeof release?.url === 'string') vanillaPackageUrl = release.url;
            }
          } catch (manifestError) {
            console.warn('Could not resolve Minecraft package URL:', manifestError);
          }
        }

        if (!clientUrl) {
          const urlToFetch = vanillaPackageUrl || packageUrl;
          if (urlToFetch) {
            try {
              const pkgRes = await fetch(urlToFetch);
              if (pkgRes.ok) {
                const pkgData = await pkgRes.json();
                if (pkgData?.downloads?.client?.url) {
                  clientUrl = pkgData.downloads.client.url;
                }
                if (!expectedSize && pkgData?.downloads?.client?.size) {
                  expectedSize = pkgData.downloads.client.size;
                }
              }
            } catch (fetchErr) {
              console.warn('Could not prefetch package json:', fetchErr);
            }
          }
        }

        await invoke('download_version', {
          versionName: v.id,
          packageUrl: packageUrl || null,
          clientUrl: clientUrl || null,
          vanillaPackageUrl: vanillaPackageUrl || null,
          expectedSize: expectedSize || null,
        });
      }

      const updated = await invoke<string[]>('get_installed_versions');
      if (Array.isArray(updated)) {
        setInstalledVersions(updated);
        try {
          localStorage.setItem('canger_installed_versions', JSON.stringify(updated));
        } catch { }
      }

      setSelectedVersion(installedVersionId);
      try {
        localStorage.setItem('canger_selected_version', installedVersionId);
      } catch { }

      showToast('success', 'Версия установлена', `${v.name} готова к запуску`);
    } catch (err: any) {
      console.error('Failed to install version:', err);
      showToast('error', `Ошибка установки ${v.name}`, err?.message || String(err));
    } finally {
      setDownloadingVersion(null);
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[v.id];
        return next;
      });
    }
  };

  useEffect(() => {
    let isMounted = true;
    const previousVersions = allVersions;
    const installedVersionIds = new Set([
      ...readStoredStringArray('canger_installed_versions'),
      ...installedVersions,
    ]);
    async function loadRealManifest() {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          if (
            cached
            && cached.schema === 8
            && cached.timestamp
            && (Date.now() - cached.timestamp < CACHE_TTL_MS)
            && Array.isArray(cached.versions)
            && cached.versions.length > 0
            && cached.versions.every((version: any) => (
              version && typeof version.id === 'string' && Array.isArray(version.tags)
            ))
          ) {
            const merged = mergeInstalledVersionCards(cached.versions, installedVersionIds);
            setAllVersions(merged);
            try {
              localStorage.setItem(CACHE_KEY, JSON.stringify({
                schema: 8,
                timestamp: cached.timestamp,
                versions: merged,
              }));
            } catch { }
            return;
          }
        }
      } catch { }

      try {
        const res = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
        if (!res.ok) return;
        const data = await res.json();
        if (!isMounted || !data?.versions) return;

        const releaseEntries = Array.isArray(data.versions)
          ? data.versions.filter((entry: any) => entry?.type === 'release')
          : [];
        const releaseIds = new Set<string>(releaseEntries.map((entry: any) => entry.id));

        let fabricGameVersions: Set<string> = new Set();
        let fabricLoaderVersion = FALLBACK_FABRIC_LOADERS[0];
        try {
          const fabRes = await fetch('https://meta.fabricmc.net/v2/versions/game');
          if (fabRes.ok) {
            const fabData = await fabRes.json();
            if (Array.isArray(fabData)) {
              fabricGameVersions = new Set(
                fabData
                  .filter((entry: any) => entry?.stable && typeof entry.version === 'string')
                  .map((entry: any) => entry.version)
              );
            }
          }
        } catch { }
        if (fabricGameVersions.size === 0) {
          fabricGameVersions = new Set(['1.21.4', '1.21.1', '1.20.1', '1.19.4', '1.16.5']);
        }

        try {
          const loaderRes = await fetch('https://meta.fabricmc.net/v2/versions/loader');
          if (loaderRes.ok) {
            const loaderData = await loaderRes.json();
            const latest = Array.isArray(loaderData)
              ? loaderData
                .map((entry: any) => typeof entry === 'string' ? entry : entry?.version)
                .find((version: any) => typeof version === 'string')
              : null;
            if (latest) fabricLoaderVersion = latest;
          }
        } catch { }

        const fabricLoadersByGame = new Map<string, string[]>();
        const fabricGameEntries = releaseEntries
          .filter((entry: any) => fabricGameVersions.has(entry.id))
          .slice(0, FABRIC_GAME_CARD_LIMIT);
        await Promise.all(fabricGameEntries.map(async (entry: any) => {
          try {
            const response = await fetch(
              `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(entry.id)}`
            );
            if (!response.ok) return;
            const payload = await response.json();
            if (!Array.isArray(payload)) return;
            const versions = payload
              .map((item: any) => typeof item === 'string' ? item : item?.loader?.version)
              .filter((version: any): version is string => typeof version === 'string');
            const selected = takeRecent(versions, (version) => version, FABRIC_LOADER_CARD_LIMIT);
            if (selected.length > 0) fabricLoadersByGame.set(entry.id, selected);
          } catch { }
        }));

        type ForgeCard = { version: string; channel: 'recommended' | 'latest' | 'explicit' };
        const forgeBuilds = new Map<string, ForgeCard[]>();
        const addForgeBuild = (minecraftVersion: string, version: string, channel: ForgeCard['channel']) => {
          if (!/^[A-Za-z0-9._+-]+$/.test(version)) return;
          const list = forgeBuilds.get(minecraftVersion) || [];
          const existing = list.find((build) => build.version === version);
          if (existing) {
            if (channel === 'recommended') existing.channel = channel;
            return;
          }
          list.push({ version, channel });
          forgeBuilds.set(minecraftVersion, list);
        };
        for (const [minecraftVersion, versions] of Object.entries(FALLBACK_FORGE_BUILDS)) {
          for (const version of versions) addForgeBuild(minecraftVersion, version, 'explicit');
        }

        if (tauriAvailable) {
          try {
            const forgeJson = await invoke<string>('get_forge_promotions');
            const forgeData = JSON.parse(forgeJson) as { promos?: Record<string, unknown> };
            for (const [key, value] of Object.entries(forgeData.promos || {})) {
              const match = key.match(/^(.*)-(recommended|latest)$/);
              if (!match || typeof value !== 'string') continue;
              addForgeBuild(match[1], value, match[2] as ForgeCard['channel']);
            }
          } catch { }
          try {
            const metadata = await invoke<string>('get_forge_versions');
            for (const raw of parseForgeMetadataVersions(metadata)) {
              const build = parseForgeMavenBuild(raw);
              if (build && releaseIds.has(build.minecraftVersion)) {
                addForgeBuild(build.minecraftVersion, build.forgeVersion, 'explicit');
              }
            }
          } catch { }
        }

        const neoforgeBuilds = new Map<string, string[]>(
          Object.entries(FALLBACK_NEOFORGE_BUILDS).map(([minecraftVersion, versions]) => [minecraftVersion, [...versions]])
        );
        if (tauriAvailable) {
          try {
            const payload = JSON.parse(await invoke<string>('get_neoforge_versions'));
            const rawVersions = Array.isArray(payload) ? payload : payload?.versions;
            if (Array.isArray(rawVersions)) {
              for (const raw of rawVersions) {
                if (typeof raw !== 'string') continue;
                const build = parseNeoForgeMavenBuild(raw);
                if (!build || !releaseIds.has(build.minecraftVersion)) continue;
                const list = neoforgeBuilds.get(build.minecraftVersion) || [];
                if (!list.includes(build.neoforgeVersion)) list.push(build.neoforgeVersion);
                neoforgeBuilds.set(build.minecraftVersion, list);
              }
            }
          } catch { }
        }

        const fallbackFabricVersions = takeRecent(
          [fabricLoaderVersion, ...FALLBACK_FABRIC_LOADERS],
          (version) => version,
          FABRIC_LOADER_CARD_LIMIT
        );

        const parsed: MinecraftVersion[] = [];

        for (const v of data.versions) {
          if (v.type === 'release') {
            const vanillaUrl = v.url;
            parsed.push({
              id: v.id,
              name: v.id,
              type: 'release',
              packageUrl: vanillaUrl,
              tags: [
                { label: 'Релиз', variant: 'release' },
                { label: 'Vanilla', variant: 'secondary' },
              ],
            });

            const fabricVersions = takeRecent(
              fabricLoadersByGame.get(v.id) || fallbackFabricVersions,
              (version) => version,
              FABRIC_LOADER_CARD_LIMIT
            );
            if (fabricGameVersions.has(v.id)) {
              fabricVersions.forEach((loaderVersion, index) => {
                parsed.push({
                  id: index === 0 ? `${v.id}-fabric` : `${v.id}-fabric-${loaderVersion}`,
                  name: `Fabric ${v.id} · ${loaderVersion}`,
                  type: 'modded',
                  loader: 'fabric',
                  minecraftVersion: v.id,
                  loaderVersion,
                  packageUrl: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(v.id)}/${encodeURIComponent(loaderVersion)}/profile/json`,
                  vanillaPackageUrl: vanillaUrl,
                  tags: [
                    { label: 'Fabric', variant: 'fabric' },
                    { label: loaderVersion, variant: 'secondary' },
                  ],
                });
              });
            }

            const forgeBuildsForGame = forgeBuilds.get(v.id) || [];
            const recommendedForge = forgeBuildsForGame.find(
              (build) => build.channel === 'recommended'
            );
            const forgeCards = recommendedForge
              ? [recommendedForge]
              : takeRecent(forgeBuildsForGame, (build) => build.version, FORGE_BUILD_CARD_LIMIT);
            const legacyForge = /^1\.(?:[0-9]|1[0-2])(?:\.|$)/.test(v.id);
            for (const forgeBuild of forgeCards) {
              const channelLabel = forgeBuild.channel === 'recommended'
                ? 'Рекомендуемый'
                : forgeBuild.channel === 'latest'
                  ? 'Последний'
                  : 'Сборка';
              parsed.push({
                id: `${v.id}-forge-${forgeBuild.version}`,
                name: `Forge ${v.id} · ${forgeBuild.version}`,
                type: 'modded',
                loader: 'forge',
                minecraftVersion: v.id,
                forgeVersion: forgeBuild.version,
                fullForgeVersion: `${v.id}-${forgeBuild.version}`,
                channel: forgeBuild.channel,
                headlessSupported: !legacyForge,
                vanillaPackageUrl: vanillaUrl,
                tags: [
                  { label: 'Forge', variant: 'forge' },
                  { label: forgeBuild.version, variant: 'secondary' },
                  { label: legacyForge ? 'Вручную' : channelLabel, variant: 'secondary' },
                ],
              });
            }

            const neoforgeCards = takeRecent(
              neoforgeBuilds.get(v.id) || [],
              (version) => version,
              NEOFORGE_BUILD_CARD_LIMIT
            );
            for (const neoforgeVersion of neoforgeCards) {
              parsed.push({
                id: `neoforge-${neoforgeVersion}`,
                name: `NeoForge ${v.id} · ${neoforgeVersion}`,
                type: 'modded',
                loader: 'neoforge',
                minecraftVersion: v.id,
                neoforgeVersion,
                loaderVersion: neoforgeVersion,
                channel: 'explicit',
                headlessSupported: true,
                vanillaPackageUrl: vanillaUrl,
                tags: [
                  { label: 'NeoForge', variant: 'neoforge' },
                  { label: neoforgeVersion, variant: 'secondary' },
                ],
              });
            }
          } else if (v.type === 'snapshot') {
            parsed.push({
              id: v.id,
              name: v.id,
              type: 'snapshot',
              packageUrl: v.url,
              tags: [
                { label: 'Снапшот', variant: 'snapshot' },
              ],
            });
          }
        }

        const compactParsed = keepLatestLoaderCards(parsed);
        const finalParsed = mergeInstalledVersionCards(compactParsed, installedVersionIds);
        const knownIds = new Set(finalParsed.map((version) => version.id));
        for (const previous of previousVersions) {
          if (installedVersionIds.has(previous.id) && !knownIds.has(previous.id)) {
            finalParsed.push(previous);
            knownIds.add(previous.id);
          }
        }

        if (finalParsed.length > 0 && isMounted) {
          setAllVersions(finalParsed);
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
              schema: 8,
              timestamp: Date.now(),
              versions: finalParsed,
            }));
          } catch { }
        }
      } catch (err) {
        console.warn('Failed to load real manifest:', err);
      }
    }
    loadRealManifest();
    return () => { isMounted = false; };
  }, []);

  useEffect(() => {
    if (installedVersions.length === 0) return;
    setAllVersions((current) => mergeInstalledVersionCards(current, installedVersions));
  }, [installedVersions]);

  const closeVersionsModal = () => {
    if (isVersionsClosing) return;
    setIsVersionsClosing(true);
    setTimeout(() => {
      setIsVersionsOpen(false);
      setIsVersionsClosing(false);
      setVersionSearch('');
    }, 200);
  };

  const filteredVersionsSidebar = useMemo(() => {
    return allVersions.filter((v) => {
      if (versionFilter === 'release' && v.type !== 'release') return false;
      if (versionFilter === 'snapshot' && v.type !== 'snapshot') return false;
      if (versionFilter === 'modded' && v.type !== 'modded') return false;
      if (versionSearch.trim()) {
        const q = versionSearch.trim().toLowerCase();
        const matchName = v.name.toLowerCase().includes(q);
        const matchTags = v.tags.some((t) => t.label.toLowerCase().includes(q));
        return matchName || matchTags;
      }
      return true;
    });
  }, [allVersions, versionFilter, versionSearch]);

  const filteredVersionsModal = useMemo(() => {
    return allVersions.filter((v) => {
      if (!installedVersions.includes(v.id) && !installedVersions.includes(v.name)) return false;
      if (versionFilter === 'release' && v.type !== 'release') return false;
      if (versionFilter === 'snapshot' && v.type !== 'snapshot') return false;
      if (versionFilter === 'modded' && v.type !== 'modded') return false;
      if (versionSearch.trim()) {
        const q = versionSearch.trim().toLowerCase();
        const matchName = v.name.toLowerCase().includes(q);
        const matchTags = v.tags.some((t) => t.label.toLowerCase().includes(q));
        return matchName || matchTags;
      }
      return true;
    });
  }, [allVersions, installedVersions, versionFilter, versionSearch]);

  const handleSelectVersion = (versionName: string) => {
    setSelectedVersion(versionName);
    try {
      localStorage.setItem('canger_selected_version', versionName);
    } catch { }
  };

  const openVersionsModal = () => {
    setIsVersionsClosing(false);
    setIsVersionsOpen(true);
  };

  const validateNickname = (nick: string): { valid: boolean; error?: string } => {
    if (!nick.trim()) return { valid: false, error: 'Никнейм не может быть пустым' };
    if (nick.length > 16) return { valid: false, error: 'Максимум 16 символов' };
    if (!/^[a-zA-Z0-9_]+$/.test(nick)) {
      return { valid: false, error: 'Только латиница, цифры и underscore' };
    }
    return { valid: true };
  };

  const handleAddAccount = () => {
    const trimmed = newNick.trim();
    const validation = validateNickname(trimmed);

    if (!validation.valid) {
      showToast('error', 'Неверный никнейм', validation.error);
      return;
    }

    if (!accounts.includes(trimmed)) {
      const updated = [...accounts, trimmed];
      setAccounts(updated);
      setNewlyAddedAccount(trimmed);
      setTimeout(() => setNewlyAddedAccount(null), 850);
      try {
        localStorage.setItem('canger_accounts', JSON.stringify(updated));
      } catch { }
      setActiveAccount(trimmed);
      try {
        localStorage.setItem('canger_active_account', trimmed);
      } catch { }
    } else {
      setActiveAccount(trimmed);
      try {
        localStorage.setItem('canger_active_account', trimmed);
      } catch { }
    }
    setNewNick('');
    closeModal();
  };

  const openDeleteAccountConfirm = (nameToDelete?: string) => {
    const target = nameToDelete || activeAccount;
    if (!target || deletingAccount) return;
    setConfirmDeleteAccount(target);
  };

  const closeDeleteAccountConfirm = () => {
    setIsConfirmClosing(true);
    setTimeout(() => {
      setConfirmDeleteAccount(null);
      setIsConfirmClosing(false);
    }, 180);
  };

  const handleDeleteAccount = (nameToDelete?: string) => {
    const target = nameToDelete || activeAccount;
    if (!target || deletingAccount) return;
    setDeletingAccount(target);
    setTimeout(() => {
      const updated = accounts.filter((a) => a !== target);
      setAccounts(updated);
      try {
        localStorage.setItem('canger_accounts', JSON.stringify(updated));
      } catch { }
      if (activeAccount === target) {
        const nextActive = updated.length > 0 ? updated[0] : '';
        setActiveAccount(nextActive);
        try {
          localStorage.setItem('canger_active_account', nextActive);
        } catch { }
      }
      setDeletingAccount(null);
    }, 850);
  };

  const selectAccount = (name: string) => {
    setActiveAccount(name);
    try {
      localStorage.setItem('canger_active_account', name);
    } catch { }
  };

  useEffect(() => {
    if (isNewsHovered) return;
    const timer = setInterval(() => {
      setNewsIndex((prev) => (prev + 1) % newsItems.length);
    }, 6000);
    return () => clearInterval(timer);
  }, [isNewsHovered, newsItems.length]);
  return (
    <div className={`window ${theme}`} style={{ ['--theme-bg' as string]: `url('${themeSrc}')` }}>
      {toast && (
        <div className={`toast-banner toast-${toast.type}`} onClick={() => setToast(null)}>
          <div className="toast-icon">
            {toast.type === 'success' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : toast.type === 'error' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            )}
          </div>
          <div className="toast-body">
            <span className="toast-title">{toast.title}</span>
            {toast.message && <span className="toast-msg">{toast.message}</span>}
          </div>
          <button className="toast-close" onClick={(e) => { e.stopPropagation(); setToast(null); }}>×</button>
        </div>
      )}
      <div
        className="titlebar"
        data-tauri-drag-region
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('.controls') || (e.target as HTMLElement).closest('button')) return;
          if (e.buttons === 1) {
            void win?.startDragging();
          }
        }}
      >
        <div className="controls">
          <button className="btn" onClick={() => void win?.minimize()} aria-label="minimize" disabled={!tauriAvailable}>
            <svg viewBox="0 0 100 100" className="icon" fill="none" aria-hidden>
              <line x1="18" y1="50" x2="82" y2="50" stroke="currentColor" strokeWidth="12" strokeLinecap="round" />
            </svg>
          </button>
          <button className="btn close" onClick={() => void win?.close()} aria-label="close" disabled={!tauriAvailable}>
            <svg viewBox="0 0 100 100" className="icon" fill="none" aria-hidden>
              <line x1="22" y1="22" x2="78" y2="78" stroke="currentColor" strokeWidth="12" strokeLinecap="round" />
              <line x1="78" y1="22" x2="22" y2="78" stroke="currentColor" strokeWidth="12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <main className="body">
        <div
          className={`sidebar-pill ${open ? 'open' : ''}`}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <button className={`pill-btn${tab === 'home' ? ' active' : ''}`} aria-label="Главная" aria-current={tab === 'home' ? 'page' : undefined} onClick={() => setTab('home')}>
            <svg viewBox="0 0 24 24" className="pill-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <span className="pill-label">Главная</span>
          </button>
          <button className={`pill-btn${tab === 'settings' ? ' active' : ''}`} aria-label="Настройки" aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}>
            <svg viewBox="0 0 100 100" className="pill-icon" fill="currentColor" aria-hidden>
              <rect x="34" y="18" width="56" height="28" rx="14" />
              <circle cx="18" cy="32" r="18" stroke="rgba(42,28,35,0.18)" strokeWidth="3" />
              <rect x="10" y="54" width="56" height="28" rx="14" />
              <circle cx="82" cy="68" r="18" stroke="rgba(42,28,35,0.18)" strokeWidth="3" />
            </svg>
            <span className="pill-label">Настройки</span>
          </button>
          <button className={`pill-btn${tab === 'mods' ? ' active' : ''}`} aria-label="Моды" aria-current={tab === 'mods' ? 'page' : undefined} onClick={() => setTab('mods')}>
            <svg viewBox="0 0 24 24" className="pill-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3l7 4v8l-7 4-7-4V7l7-4z" />
              <path d="M12 11v8" />
            </svg>
            <span className="pill-label">Моды</span>
          </button>
          <button className={`pill-btn${tab === 'versions' ? ' active' : ''}`} aria-label="Версии" aria-current={tab === 'versions' ? 'page' : undefined} onClick={() => { setTab('versions'); }}>
            <svg viewBox="0 0 24 24" className="pill-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 12 12 17 22 12" />
              <polyline points="2 17 12 22 22 17" />
            </svg>
            <span className="pill-label">Версии</span>
          </button>
          <button className={`pill-btn${tab === 'accounts' ? ' active' : ''}`} aria-label="Аккаунты" aria-current={tab === 'accounts' ? 'page' : undefined} onClick={() => setTab('accounts')}>
            <svg viewBox="0 0 24 24" className="pill-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span className="pill-label">Аккаунты</span>
          </button>
          <button className={`pill-btn${tab === 'folder' ? ' active' : ''}`} aria-label="Папка" aria-current={tab === 'folder' ? 'page' : undefined} onClick={() => setTab('folder')}>
            <svg viewBox="0 0 24 24" className="pill-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
            <span className="pill-label">Папка</span>
          </button>
        </div>
        <div className="content">
          {pixelsOn && (
          <div className="pixel-bg" aria-hidden>
            {Array.from({ length: 90 }).map((_, i) => {
              const r = (n: number) => ((i * 9301 + n * 49297) % 233280) / 233280;
              const size = 2 + Math.round(r(1) * 4);
              const palette = ['#e9f2ff', '#c7b8ff', '#ffd6f5', '#b8e0ff', '#f0f4f8'];
              const col = palette[Math.floor(r(2) * palette.length)];
              const dx = (r(3) * 2 - 1) * 24;
              return (
                <span
                  key={i}
                  className="pixel"
                  style={{
                    left: `${(r(4) * 100).toFixed(2)}%`,
                    top: `${(60 + r(5) * 45).toFixed(2)}%`,
                    ['--sz' as any]: `${size}px`,
                    ['--col' as any]: col,
                    ['--dx' as any]: `${dx.toFixed(1)}px`,
                    ['--dur' as any]: `${(5.5 + r(6) * 6).toFixed(2)}s`,
                    ['--delay' as any]: `${(r(7) * 7).toFixed(2)}s`,
                    ['--peak' as any]: (0.35 + r(8) * 0.45).toFixed(2),
                    ['--glow' as any]: `${(4 + size * 1.6).toFixed(1)}px`,
                  }}
                />
              );
            })}
          </div>
          )}
          <div className="views">
            <div className={`tabview${tab === 'home' ? ' visible' : ''}`}>
              <div
                className="hero-banner"
                onMouseEnter={() => setIsNewsHovered(true)}
                onMouseLeave={() => setIsNewsHovered(false)}
              >
                <div className="hero-banner-inner">
                  {newsItems.map((item, idx) => (
                    <div
                      key={item.id}
                      className={`hero-slide ${idx === newsIndex ? 'active' : ''}`}
                    >
                      <img src={item.img} alt="" className="hero-img" draggable={false} />
                      <div className="hero-overlay" />
                      <div className="hero-content">
                        <div className="hero-top">
                          <span className="hero-date">{item.date}</span>
                        </div>
                        <h3 className="hero-title">{item.title}</h3>
                        <p className="hero-desc">{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="hero-nav">
                  {newsItems.map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={`hero-dot ${idx === newsIndex ? 'active' : ''}`}
                      onClick={() => setNewsIndex(idx)}
                      aria-label={`Новость ${idx + 1}`}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className={`tabview wide${tab === 'settings' ? ' visible' : ''}`}>
              <div className="tab-placeholder">
                <div
                  ref={themeGridRef}
                  className="theme-grid"
                  onScroll={handleThemeScroll}
                  onWheel={(e) => {
                    if (e.deltaY !== 0 && themeGridRef.current) {
                      e.currentTarget.scrollLeft += e.deltaY;
                    }
                  }}
                >
                  {themes.map((t) => (
                    <button
                      key={t.id}
                      className={`theme-thumb${theme === t.id ? ' active' : ''}`}
                      onClick={() => pickTheme(t.id)}
                      aria-label={t.id}
                    >
                      <img src={t.src} alt="" draggable={false} />
                    </button>
                  ))}
                </div>
                <div className="theme-dots">
                  <button
                    type="button"
                    className={`theme-dot${themePageIndex === 0 ? ' active' : ''}`}
                    onClick={() => scrollToThemePage(0)}
                    aria-label="Страница 1"
                  />
                  <button
                    type="button"
                    className={`theme-dot${themePageIndex === 1 ? ' active' : ''}`}
                    onClick={() => scrollToThemePage(1)}
                    aria-label="Страница 2"
                  />
                </div>
                <div className="set-row">
                  <span className="set-label">Пиксели</span>
                  <button className={`switch${pixelsOn ? ' on' : ''}`} onClick={togglePixels} aria-label="Пиксели" />
                </div>
                <div className="set-row">
                  <span className="set-label">RAM</span>
                  <span className="set-value">{(ram / 1024).toFixed(1)} ГБ</span>
                </div>
                <input
                  className="ram-slider"
                  type="range"
                  aria-label="Оперативная память"
                  min={1024}
                  max={8192}
                  step={16}
                  value={ram}
                  style={{ ['--fill' as string]: `${((ram - 1024) / (8192 - 1024)) * 100}%` }}
                  onChange={(e) => {
                    setRam(parseInt(e.target.value, 10));
                    try { localStorage.setItem('ram', e.target.value); } catch { }
                  }}
                  onPointerUp={() => persistRam(ram)}
                  onKeyUp={() => persistRam(ram)}
                />
              </div>
            </div>
            <div className={`tabview wide${tab === 'mods' ? ' visible' : ''}`}>
              <div className="tab-placeholder mods-tab-placeholder">
                <div className="mods-header-row">
                  <div className="mods-header-left">
                    <span className="mods-title">Моды</span>
                    <span className="mods-count">{displayMods.length}</span>
                  </div>
                  <div className="mods-header-actions">
                    <button
                      type="button"
                      className="mods-folder-btn"
                      onClick={handleOpenModsFolder}
                      title="Открыть папку модов выбранной версии"
                    >
                      <svg viewBox="0 0 24 24" className="mods-folder-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                      </svg>
                      <span>Папка</span>
                    </button>
                    <div className="ver-search-box mods-search-box">
                      <svg viewBox="0 0 24 24" className="ver-search-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        type="text"
                        className="ver-search-input"
                        placeholder="Поиск..."
                        aria-label="Поиск модов"
                        value={modSearch}
                        onChange={(e) => setModSearch(e.target.value)}
                      />
                      {modSearch && (
                        <button className="ver-search-clear" onClick={() => setModSearch('')}>×</button>
                      )}
                    </div>
                  </div>
                </div>

                {modpackProgress && (
                  <div className="modpack-progress-banner">
                    <div className="mod-spinner" />
                    <span>
                      Установка сборки <strong>{modpackProgress.title}</strong>: {modpackProgress.current}/{modpackProgress.total} модов...
                    </span>
                  </div>
                )}

                <div className="mods-unified-list" onScroll={handleCatalogScroll}>
                  {loadingCatalog ? (
                    <div className="mods-loading">
                      <div className="mod-spinner" />
                      <span>Поиск в Modrinth и CurseForge...</span>
                    </div>
                  ) : displayMods.length === 0 ? (
                    <div className="ver-empty">
                      <span className="ver-empty-title">
                        {currentLoader === 'vanilla'
                          ? 'Vanilla не загружает моды — выберите Fabric или Forge'
                          : 'Ничего не найдено'}
                      </span>
                    </div>
                  ) : (
                    displayMods.map((item) => {
                      const isModpack = item.type === 'modpack';
                      const isInstalled = !isModpack && isModInstalled(item.slug);
                      const isInstalling = isModpack
                        ? installingModpackId === item.id
                        : installingModSlug === (item.source === 'curseforge' ? String(item.cfId) : item.slug);

                      return (
                        <div key={`${item.source}-${item.id}`} className="folder-card mod-folder-card">
                          <div className="folder-icon-box">
                            {item.icon_url ? (
                              <img
                                src={item.icon_url}
                                alt={item.title}
                                className="mod-icon-img"
                                onError={(e) => {
                                  (e.currentTarget as HTMLElement).style.display = 'none';
                                  const fallback = e.currentTarget.nextElementSibling as HTMLElement;
                                  if (fallback) fallback.style.display = 'flex';
                                }}
                              />
                            ) : null}
                            <div className="mod-icon-fallback" style={{ display: item.icon_url ? 'none' : 'flex' }}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                                <path d="M12 3l7 4v8l-7 4-7-4V7l7-4z" />
                                <path d="M12 11v8" />
                              </svg>
                            </div>
                          </div>
                          <div className="folder-info">
                            <span className="folder-name">{item.title}</span>
                            <span className="folder-desc">{item.description}</span>
                          </div>
                          <div className="folder-card-action">
                            {isInstalling ? (
                              <div className="mod-pack-installing-status">
                                <div className="mod-spinner-small" title="Установка..." />
                                {isModpack && modpackProgress && (
                                  <span className="mod-pack-progress-text">
                                    {modpackProgress.current}/{modpackProgress.total}
                                  </span>
                                )}
                              </div>
                            ) : isInstalled ? (
                              <div className="ver-installed-badge" title="Установлен">
                                <svg viewBox="0 0 24 24" className="ver-installed-icon" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="folder-open-btn"
                                onClick={() => handleInstallCatalogItem(item)}
                              >
                                {isModpack ? 'Установить' : 'Скачать'}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}

                  {displayMods.length > 0 && (
                    <div className="mods-load-more-wrap">
                      {displayMods.length >= 1000 ? (
                        <span className="mods-load-more-done">Показано 1000 модов (максимум)</span>
                      ) : hasMoreCatalog ? (
                        <button
                          type="button"
                          className="mods-load-more-btn"
                          onClick={loadMoreCatalog}
                          disabled={loadingMoreCatalog}
                        >
                          {loadingMoreCatalog ? (
                            <>
                              <div className="mod-spinner-small" />
                              <span>Загрузка...</span>
                            </>
                          ) : (
                            `Загрузить ещё (+200)... (${displayMods.length}/1000)`
                          )}
                        </button>
                      ) : (
                        <span className="mods-load-more-done">Все найденные результаты загружены ({displayMods.length})</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className={`tabview wide folder-tabview${tab === 'folder' ? ' visible' : ''}`}>
              <div
                className="tab-placeholder folder-tab-placeholder"
                data-folder-path=""
              >
                <div className="folder-tree-root" data-folder-path="">
                  <div
                    className={`folder-tree-header${expandedDirs[''] ? ' open' : ''}${dragTargetFolder === '' ? ' drag-over' : ''}`}
                    data-folder-path=""
                    role="button"
                    tabIndex={0}
                    aria-expanded={Boolean(expandedDirs[''])}
                    onClick={() => void toggleDir('')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void toggleDir('');
                      }
                    }}
                  >
                    <div className="folder-tree-header-left">
                      <svg viewBox="0 0 24 24" className="folder-tree-header-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                      </svg>
                      <span className="folder-tree-header-title">{selectedVersionMeta?.name || selectedVersion}</span>
                      <span className="folder-tree-header-sub">
                        Папка выбранной версии
                      </span>
                    </div>
                    <div
                      className="folder-tree-header-actions"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="folder-tree-chevron-btn"
                        onClick={() => void toggleDir('')}
                        aria-label={expandedDirs[''] ? 'Свернуть папку версии' : 'Развернуть папку версии'}
                        aria-expanded={Boolean(expandedDirs[''])}
                        title={expandedDirs[''] ? 'Свернуть' : 'Развернуть'}
                      >
                        <svg viewBox="0 0 24 24" className={`folder-chevron-icon${expandedDirs[''] ? ' open' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <div className={`folder-root-expandable${expandedDirs[''] ? ' open' : ''}`}>
                    <div className="folder-expandable-inner folder-tree-scroll">
                      {(expandedDirs[''] || dirContents['']) && renderDirBranch('', 0)}
                    </div>
                  </div>

                  {!expandedDirs[''] && !dirContents[''] && (
                    <div className="folder-tree-closed-hint">
                      <span>Нажмите на версию, чтобы просмотреть её файлы</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div
              id="versions-section-panel"
              className={`tabview wide versions-view${tab === 'versions' ? ' visible' : ''}`}
              role="tabpanel"
              aria-labelledby="versions-section-tab-versions"
            >
              <div className="tab-placeholder ver-tab-placeholder">
                <div className="ver-header-row">
                  <div className="version-section-tabs" role="tablist" aria-label="Разделы версий">
                    <button
                      id="versions-section-tab-versions"
                      type="button"
                      className="version-section-tab active"
                      role="tab"
                      aria-selected="true"
                      aria-controls="versions-section-panel"
                    >
                      <span>Версии</span>
                      <span className="version-section-count">{filteredVersionsSidebar.length}</span>
                    </button>
                  </div>
                  {true && (
                    <div className="ver-search-box">
                      <svg viewBox="0 0 24 24" className="ver-search-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        type="text"
                        className="ver-search-input"
                        placeholder="Поиск..."
                        aria-label="Поиск версий"
                        value={versionSearch}
                        onChange={(e) => setVersionSearch(e.target.value)}
                      />
                      {versionSearch && (
                        <button className="ver-search-clear" onClick={() => setVersionSearch('')}>×</button>
                      )}
                    </div>
                  )}
                </div>

                <div className="ver-chips">
                  {[
                    { key: 'all', label: 'Все' },
                    { key: 'release', label: 'Релизы' },
                    { key: 'modded', label: 'Моды' },
                    { key: 'snapshot', label: 'Снапшоты' },
                  ].map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className={`ver-chip${versionFilter === f.key ? ' active' : ''}`}
                      aria-pressed={versionFilter === f.key}
                      onClick={() => setVersionFilter(f.key as any)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                <div
                  key={versionFilter}
                  className="ver-list"
                  role="list"
                  aria-label="Доступные версии Minecraft"
                  onScroll={handleSidebarScroll}
                >
                  {filteredVersionsSidebar.length === 0 ? (
                    <div className="ver-empty" role="listitem">
                      <span className="ver-empty-title">Версии не найдены</span>
                    </div>
                  ) : (
                    filteredVersionsSidebar.slice(0, sidebarVisibleCount).map((v) => {
                      const isInstalled = installedVersions.includes(v.id) || installedVersions.includes(v.name);
                      const isDownloading = downloadingVersion === v.id;
                      const progress = downloadProgress[v.id];
                      return (
                        <div
                          key={v.id}
                          className="ver-card"
                          role="listitem"
                          aria-label={v.name}
                          aria-busy={isDownloading}
                        >
                          <div className="ver-icon-badge">
                            {v.type === 'modded' ? (
                              <img src="/icons/modded.png" alt="" className="ver-card-icon ver-anvil-icon" draggable={false} />
                            ) : (
                              <img src="/icons/minecraft.svg" alt="" className="ver-card-icon ver-mc-icon" draggable={false} />
                            )}
                          </div>
                          <div className="ver-info">
                            <span className="ver-name">{v.name}</span>
                            <div className="ver-tags">
                              {v.tags.map((t, idx) => (
                                <span key={idx} className={`ver-tag ver-tag-${t.variant || 'secondary'}`}>
                                  {t.label}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="ver-card-right" onClick={(e) => e.stopPropagation()}>
                            {isDownloading ? (
                              <div className="ver-download-progress-wrap" title={`Загрузка: ${progress?.percent || 0}%`}>
                                <div className="ver-progress-info">
                                  <span className="ver-progress-percent">{progress?.percent || 0}%</span>
                                  {progress?.stage ? (
                                    <span className="ver-progress-stage">{progress.stage}</span>
                                  ) : progress?.currentBytes && progress?.totalBytes ? (
                                    <span className="ver-progress-bytes">
                                      {(progress.currentBytes / 1048576).toFixed(1)}/{(progress.totalBytes / 1048576).toFixed(1)} МБ
                                    </span>
                                  ) : null}
                                </div>
                                <div className="ver-progress-bar-bg">
                                  <div
                                    className="ver-progress-bar-fill"
                                    style={{ width: `${Math.max(4, Math.min(100, progress?.percent || 0))}%` }}
                                  />
                                </div>
                              </div>
                            ) : isInstalled ? (
                              <div className="ver-installed-badge" title="Скачано">
                                <svg viewBox="0 0 24 24" className="ver-installed-icon" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="ver-download-btn"
                                onClick={(e) => handleDownloadVersion(v, e)}
                                aria-label={`Скачать версию ${v.name}`}
                                title="Скачать версию"
                              >
                                <img src="/icons/download.png" alt="Скачать" className="ver-download-icon" draggable={false} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
            <div className={`tabview wide${tab === 'accounts' ? ' visible' : ''}`}>
              <div className="tab-placeholder">
                <div className="acc-header">
                  <span className="acc-title">Аккаунты</span>
                  <span className="acc-count">{accounts.length}</span>
                </div>
                <div className="acc-actions">
                  <button
                    className="acc-icon-btn"
                    aria-label="Добавить"
                    title="Добавить аккаунт"
                    onClick={() => setIsAddAccountOpen(true)}
                  >
                    <img src="/icons/add.png" alt="" className="acc-icon-img" draggable={false} />
                  </button>
                  <button
                    className="acc-icon-btn"
                    aria-label="Удалить"
                    title="Удалить выбранный аккаунт"
                    onClick={() => openDeleteAccountConfirm()}
                    disabled={!activeAccount}
                  >
                    <img src="/icons/trash.png" alt="" className="acc-icon-img" draggable={false} />
                  </button>
                </div>
                <div className={`acc-empty${showEmpty ? ' visible' : ''}`}>
                  <span className="acc-empty-title">Нет аккаунтов</span>
                  <span className="acc-empty-sub">Добавьте никнейм для офлайн-игры</span>
                </div>
                <div className="acc-list">
                  {accounts.map((name) => {
                      const isActive = name === activeAccount;
                      const isDeleting = name === deletingAccount;
                      const isNew = name === newlyAddedAccount;
                      return (
                        <div
                          key={name}
                          className={`acc-card${isActive ? ' active' : ''}${isDeleting ? ' evaporating' : ''}${isNew ? ' appearing' : ''}`}
                          role="button"
                          tabIndex={isDeleting ? -1 : 0}
                          aria-pressed={isActive}
                          aria-disabled={isDeleting || undefined}
                          onClick={() => !isDeleting && selectAccount(name)}
                          onKeyDown={(event) => {
                            if (!isDeleting && (event.key === 'Enter' || event.key === ' ')) {
                              event.preventDefault();
                              selectAccount(name);
                            }
                          }}
                        >
                          <div className="acc-avatar" aria-hidden>
                            <div className="acc-avatar-fallback" style={{ display: 'flex' }}>
                              {name[0]?.toUpperCase() || 'P'}
                            </div>
                          </div>
                          <div className="acc-info">
                            <span className="acc-name">{name}</span>
                            <span className="acc-status">
                              {isActive ? 'Выбран' : 'Нажмите, чтобы выбрать'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
              </div>
            </div>
          </div>
          {tab === 'home' && (
            <div className="home-actions">
              <button
                className="version-round-btn"
                onClick={openVersionsModal}
                aria-label="Выбор версии"
                title={`Выбранная версия: ${selectedVersion}`}
              >
                <svg viewBox="0 0 24 24" className="version-btn-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polygon points="12 2 2 7 12 12 22 7 12 2" />
                  <polyline points="2 12 12 17 22 12" />
                  <polyline points="2 17 12 22 22 17" />
                </svg>
              </button>
              <button
                className={`play-button${isLaunching ? ' launching' : ''}`}
                onClick={handlePlay}
                disabled={isLaunching}
                aria-label={`Запустить игру — ${selectedVersionMeta?.name || selectedVersion}`}
                title={`Версия: ${selectedVersionMeta?.name || selectedVersion}`}
              >
                <svg viewBox="0 0 24 24" className="play-button-icon" fill="currentColor">
                  <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86z" />
                </svg>
                <span className="play-button-text">{isLaunching ? 'Запуск...' : 'Играть'}</span>
              </button>
            </div>
          )}
        </div>
      </main>
      {isAddAccountOpen && (
        <div className={`modal-root${isModalClosing ? ' closing' : ''}`}>
          <div className="modal-backdrop" onClick={closeModal} />
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Добавить аккаунт</h3>
            <input
              type="text"
              className="modal-input"
              placeholder="Введите ник"
              value={newNick}
              onChange={(e) => setNewNick(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddAccount();
                if (e.key === 'Escape') closeModal();
              }}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={closeModal}
              >
                Отмена
              </button>
              <button
                type="button"
                className="modal-btn-submit"
                onClick={handleAddAccount}
                disabled={!newNick.trim()}
              >
                Добавить
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className={`modal-root${isDeleteClosing ? ' closing' : ''}`}>
          <div className="modal-backdrop" onClick={closeDeleteModal} />
          <div
            className="modal-window"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleConfirmDelete();
              if (e.key === 'Escape') closeDeleteModal();
            }}
            tabIndex={-1}
          >
            <h3 className="modal-title">Удаление {deleteTarget.isDir ? 'папки' : 'файла'}</h3>
            <p className="modal-desc">
              Вы действительно хотите удалить {deleteTarget.isDir ? 'папку' : 'файл'}{' '}
              <span className="modal-highlight">"{deleteTarget.name}"</span>?
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={closeDeleteModal}
              >
                Отмена
              </button>
              <button
                type="button"
                className="modal-btn-danger"
                onClick={handleConfirmDelete}
                autoFocus
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDeleteAccount && (
        <div className={`modal-root${isConfirmClosing ? ' closing' : ''}`}>
          <div className="modal-backdrop" onClick={closeDeleteAccountConfirm} />
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Удаление аккаунта</h3>
            <p className="modal-desc">
              Вы действительно хотите удалить аккаунт{' '}
              <span className="modal-highlight">"{confirmDeleteAccount}"</span>?
            </p>
            <p className="modal-desc" style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginTop: '8px' }}>
              Это действие нельзя отменить.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={closeDeleteAccountConfirm}
              >
                Отмена
              </button>
              <button
                type="button"
                className="modal-btn-danger"
                onClick={() => {
                  closeDeleteAccountConfirm();
                  setTimeout(() => handleDeleteAccount(confirmDeleteAccount), 200);
                }}
                autoFocus
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDeleteMod && (
        <div className={`modal-root${isConfirmClosing ? ' closing' : ''}`}>
          <div className="modal-backdrop" onClick={closeDeleteModConfirm} />
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Удаление мода</h3>
            <p className="modal-desc">
              Вы действительно хотите удалить мод{' '}
              <span className="modal-highlight">"{confirmDeleteMod}"</span>?
            </p>
            <p className="modal-desc" style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginTop: '8px' }}>
              Файл будет удалён из папки mods.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={closeDeleteModConfirm}
              >
                Отмена
              </button>
              <button
                type="button"
                className="modal-btn-danger"
                onClick={() => {
                  closeDeleteModConfirm();
                  setTimeout(() => handleDeleteMod(confirmDeleteMod), 200);
                }}
                autoFocus
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
      {isVersionsOpen && (
        <div className={`modal-root${isVersionsClosing ? ' closing' : ''}`}>
          <div className="modal-backdrop" onClick={closeVersionsModal} />
          <div className="modal-window version-modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="version-modal-header">
              <div className="version-search-pill">
                <svg viewBox="0 0 24 24" className="version-search-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  className="version-search-input"
                  placeholder="Поиск..."
                  aria-label="Поиск установленных версий"
                  value={versionSearch}
                  onChange={(e) => setVersionSearch(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') closeVersionsModal();
                  }}
                />
              </div>
            </div>

            <div className="version-filter-tabs">
              {[
                { key: 'all', label: 'Все' },
                { key: 'release', label: 'Релизы' },
                { key: 'snapshot', label: 'Снапшоты' },
                { key: 'modded', label: 'Моды' },
              ].map((tabItem) => (
                <button
                  key={tabItem.key}
                  type="button"
                  className={`version-filter-chip${versionFilter === tabItem.key ? ' active' : ''}`}
                  aria-pressed={versionFilter === tabItem.key}
                  onClick={() => setVersionFilter(tabItem.key as any)}
                >
                  {tabItem.label}
                </button>
              ))}
            </div>

            <div
              key={versionFilter}
              className="version-list"
              role={filteredVersionsModal.length > 0 ? 'listbox' : undefined}
              aria-label={filteredVersionsModal.length > 0 ? 'Установленные версии Minecraft' : undefined}
            >
              {filteredVersionsModal.length === 0 ? (
                <div className="version-empty">
                  <span className="ver-empty-title">Нет скачанных версий</span>
                  <button
                    type="button"
                    className="ver-go-download-btn"
                    onClick={() => {
                      closeVersionsModal();
                      setTab('versions');
                    }}
                  >
                    Скачать в меню версий →
                  </button>
                </div>
              ) : (
                filteredVersionsModal.map((v) => {
                  const isSelected = selectedVersion === v.id;
                  return (
                    <div
                      key={v.id}
                      className={`version-item${isSelected ? ' selected' : ''}`}
                      role="option"
                      tabIndex={0}
                      aria-selected={isSelected}
                      onClick={() => {
                        handleSelectVersion(v.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleSelectVersion(v.id);
                        }
                      }}
                    >
                      <div className="version-item-icon-box">
                        {v.type === 'modded' ? (
                          <img src="/icons/modded.png" alt="" className="version-item-icon ver-anvil-icon" draggable={false} />
                        ) : (
                          <img src="/icons/minecraft.svg" alt="" className="version-item-icon ver-mc-icon" draggable={false} />
                        )}
                      </div>
                      <div className="version-item-info">
                        <div className="version-item-title-row">
                          <span className="version-item-name">
                            {v.name}
                            {v.isInstalled && (
                              <span style={{
                                fontSize: '11px',
                                color: '#4ade80',
                                marginLeft: '6px',
                                fontWeight: 700,
                                verticalAlign: 'middle'
                              }}>
                                ✓
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="version-item-tags">{v.tags.map((t, idx) => (
                            <span key={idx} className={`version-tag version-tag-${t.variant || 'secondary'}`}>
                              {t.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
