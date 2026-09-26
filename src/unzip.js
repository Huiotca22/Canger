'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxEntries: 20000,
  maxEntrySize: 512 * 1024 * 1024,
  maxCompressedSize: 512 * 1024 * 1024,
  maxTotalSize: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxArchiveBytes: 512 * 1024 * 1024,
});

function positiveLimit(value, name, { allowZero = false } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return value;
}

function normalizeLimits(options = {}) {
  const source = { ...DEFAULT_ZIP_LIMITS, ...(options.limits || {}) };
  for (const key of Object.keys(DEFAULT_ZIP_LIMITS)) {
    if (options[key] !== undefined) source[key] = options[key];
  }
  return {
    maxEntries: positiveLimit(source.maxEntries, 'maxEntries'),
    maxEntrySize: positiveLimit(source.maxEntrySize, 'maxEntrySize'),
    maxCompressedSize: positiveLimit(source.maxCompressedSize, 'maxCompressedSize'),
    maxTotalSize: positiveLimit(source.maxTotalSize, 'maxTotalSize'),
    maxCompressionRatio: positiveLimit(source.maxCompressionRatio, 'maxCompressionRatio'),
    maxArchiveBytes: positiveLimit(source.maxArchiveBytes, 'maxArchiveBytes'),
  };
}

function findEOCD(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('ZIP: EOCD not found');
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      const commentLength = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLength <= buf.length) return i;
    }
  }
  throw new Error('ZIP: EOCD not found (not a zip?)');
}

function zipNameParts(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || /[\r\n]/.test(name)) {
    throw new Error('ZIP: invalid entry name');
  }
  const normalized = name.replace(/\\/g, '/');
  if (
    normalized.startsWith('/')
    || normalized.startsWith('//')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes('://')
  ) throw new Error(`ZIP: unsafe entry path: ${name}`);
  const isDirectory = normalized.endsWith('/');
  const parts = normalized.split('/');
  const meaningful = isDirectory ? parts.slice(0, -1) : parts;
  for (const part of meaningful) {
    if (!part || part === '.' || part === '..' || part.includes(':')) {
      throw new Error(`ZIP: unsafe entry path: ${name}`);
    }
    if (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(`ZIP: unsafe entry name: ${part}`);
    }
  }
  return { normalized, parts, isDirectory };
}

function isSymlinkEntry(entry) {
  const unixMode = (entry.externalAttrs >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function checkDeclaredSize(entry, limits, totalSize) {
  positiveLimit(entry.size, 'entry size', { allowZero: true });
  positiveLimit(entry.compSize, 'compressed entry size', { allowZero: true });
  if (entry.size > limits.maxEntrySize) throw new Error(`ZIP: entry is too large: ${entry.name}`);
  if (entry.compSize > limits.maxCompressedSize) throw new Error(`ZIP: compressed entry is too large: ${entry.name}`);
  if (entry.size > limits.maxTotalSize - totalSize) throw new Error('ZIP: total uncompressed size limit exceeded');
  if (entry.method === 0 && entry.compSize !== entry.size) {
    throw new Error(`ZIP: invalid stored entry size: ${entry.name}`);
  }
  if (entry.method === 8) {
    if (entry.compSize === 0 && entry.size > 0) throw new Error(`ZIP: invalid compression sizes: ${entry.name}`);
    if (entry.compSize > 0 && entry.size / entry.compSize > limits.maxCompressionRatio) {
      throw new Error(`ZIP: compression ratio limit exceeded: ${entry.name}`);
    }
  }
}

function listEntries(zipPath, options = {}) {
  if (typeof zipPath !== 'string' || zipPath.includes('\0')) throw new TypeError('invalid ZIP path');
  const limits = normalizeLimits(options);
  let archiveStat;
  try {
    archiveStat = fs.lstatSync(zipPath);
    if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) throw new Error('ZIP: archive is not a regular file');
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw error;
  }
  if (archiveStat.size > limits.maxArchiveBytes) throw new Error('ZIP: archive size limit exceeded');
  const buf = fs.readFileSync(zipPath);
  if (buf.length > limits.maxArchiveBytes) throw new Error('ZIP: archive size limit exceeded');
  const eocd = findEOCD(buf);
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const diskEntries = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== count || count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    throw new Error('ZIP: ZIP64/multi-disk archives are not supported');
  }
  if (count > limits.maxEntries) throw new Error('ZIP: entry count limit exceeded');
  if (cdOff > eocd || cdOff + cdSize > eocd) throw new Error('ZIP: invalid central directory');

  const entries = [];
  let p = cdOff;
  let totalSize = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP: bad central header');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOff = buf.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > eocd) throw new Error('ZIP: central directory entry exceeds archive');
    const rawName = buf.slice(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800) ? rawName.toString('utf8') : rawName.toString('latin1');
    const parsedName = zipNameParts(name);
    if (flags & 0x1) throw new Error(`ZIP: encrypted entry is not supported: ${name}`);
    const entry = {
      name,
      normalizedName: parsedName.normalized,
      method,
      crc,
      compSize,
      size,
      localOff,
      utf8: !!(flags & 0x800),
      externalAttrs,
      isDirectory: parsedName.isDirectory || !!(externalAttrs & 0x10),
    };
    if (isSymlinkEntry(entry)) throw new Error(`ZIP: symlink entry is not allowed: ${name}`);
    if (!entry.isDirectory) {
      if (entry.compSize > archiveStat.size) throw new Error(`ZIP: compressed entry exceeds archive: ${name}`);
      checkDeclaredSize(entry, limits, totalSize);
      totalSize += entry.size;
    }
    entries.push(entry);
    p = next;
  }
  if (p > eocd) throw new Error('ZIP: malformed central directory');
  return entries;
}

function readExact(fd, buffer, offset, length, position) {
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buffer, offset + read, length - read, position + read);
    if (!n) throw new Error('ZIP: truncated file');
    read += n;
  }
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readEntryData(zipPath, entry, options = {}) {
  const limits = normalizeLimits(options);
  if (!entry || typeof entry !== 'object') throw new TypeError('invalid ZIP entry');
  positiveLimit(entry.size, 'entry size', { allowZero: true });
  positiveLimit(entry.compSize, 'compressed entry size', { allowZero: true });
  if (entry.size > limits.maxEntrySize) throw new Error(`ZIP: entry is too large: ${entry.name}`);
  if (entry.compSize > limits.maxCompressedSize) throw new Error('ZIP: compressed entry is too large');
  if (entry.method === 0 && entry.compSize !== entry.size) throw new Error('ZIP: invalid stored entry size');
  if (entry.method === 8 && entry.compSize > 0 && entry.size / entry.compSize > limits.maxCompressionRatio) {
    throw new Error(`ZIP: compression ratio limit exceeded: ${entry.name}`);
  }

  let st;
  try {
    st = fs.lstatSync(zipPath);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('ZIP: archive is not a regular file');
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw error;
  }
  const fd = fs.openSync(zipPath, 'r');
  try {
    const localHeader = Buffer.alloc(30);
    readExact(fd, localHeader, 0, 30, entry.localOff);
    if (localHeader.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP: bad local header for ${entry.name}`);
    const nameLen = localHeader.readUInt16LE(26);
    const extraLen = localHeader.readUInt16LE(28);
    const dataOff = entry.localOff + 30 + nameLen + extraLen;
    if (dataOff < 0 || dataOff + entry.compSize > st.size) throw new Error(`ZIP: truncated entry: ${entry.name}`);
    const compressed = Buffer.alloc(entry.compSize);
    readExact(fd, compressed, 0, entry.compSize, dataOff);
    let data;
    if (entry.method === 0) {
      data = compressed;
    } else if (entry.method === 8) {
      data = zlib.inflateRawSync(compressed, { maxOutputLength: limits.maxEntrySize });
    } else {
      throw new Error(`ZIP: unsupported method ${entry.method} for ${entry.name}`);
    }
    if (data.length !== entry.size) throw new Error(`ZIP: size mismatch for ${entry.name}`);
    if (crc32(data) !== entry.crc) throw new Error(`ZIP: CRC mismatch for ${entry.name}`);
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative)
  );
}

function assertSafeOutputPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isWithin(resolvedRoot, resolvedTarget)) throw new Error(`Zip slip detected: ${target}`);
  let current = resolvedRoot;
  try {
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('ZIP: extraction root is not a directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const parts = relative ? relative.split(path.sep) : [];
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) throw new Error(`ZIP: symlink output path is not allowed: ${target}`);
      if (current !== resolvedTarget && !st.isDirectory()) throw new Error('ZIP: output parent is not a directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function cleanupFile(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') { } }
}

function writeFileChecked(destination, data) {
  const part = `${destination}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.part`;
  try {
    fs.writeFileSync(part, data, { flag: 'wx' });
    try {
      fs.renameSync(part, destination);
    } catch (error) {
      let existing = null;
      try { existing = fs.lstatSync(destination); } catch (_) {}
      if (!existing || existing.isSymbolicLink() || existing.isDirectory()) throw error;
      fs.unlinkSync(destination);
      fs.renameSync(part, destination);
    }
  } catch (error) {
    cleanupFile(part);
    throw error;
  }
}

function destinationKey(file, flatten) {
  const key = path.resolve(file);
  return flatten || process.platform === 'win32' ? key.toLowerCase() : key;
}

function extractZip(zipPath, dir, options = {}) {
  const limits = normalizeLimits(options);
  const flatten = options.flatten === true;
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) throw new TypeError('invalid extraction directory');
  const entries = listEntries(zipPath, { limits });
  const root = path.resolve(dir);
  if (root === path.parse(root).root) throw new Error('ZIP: refusing to extract into a filesystem root');
  const selected = [];
  const seen = new Set();

  for (const entry of entries) {
    if (entry.isDirectory || entry.name.endsWith('/')) continue;
    if (options.filter && !options.filter(entry)) continue;
    const parsed = zipNameParts(entry.normalizedName || entry.name);
    const rel = flatten ? parsed.parts[parsed.parts.length - 1] : parsed.normalized;
    if (!rel || rel === '.' || rel === '..') throw new Error(`ZIP: empty destination for ${entry.name}`);
    const destination = path.resolve(root, ...rel.split('/'));
    if (!isWithin(root, destination)) throw new Error(`Zip slip detected: ${entry.name}`);
    if (options.rejectExisting) {
      try {
        const existing = fs.lstatSync(destination);
        if (existing.isSymbolicLink() || existing.isFile() || existing.isDirectory()) {
          throw new Error(`ZIP: duplicate/colliding destination: ${entry.name}`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const key = destinationKey(destination, flatten);
    if (seen.has(key)) throw new Error(`ZIP: duplicate destination: ${entry.name}`);
    seen.add(key);
    selected.push({ entry, destination, key, depth: key.split(path.sep).length });
  }

  selected.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
  const paths = new Set();
  for (const item of selected) {
    if (paths.has(item.key)) throw new Error(`ZIP: duplicate destination: ${item.entry.name}`);
    const parts = item.key.split(path.sep);
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(path.sep);
      if (paths.has(prefix)) throw new Error(`ZIP: file/directory collision: ${item.entry.name}`);
    }
    paths.add(item.key);
  }

  try {
    assertSafeOutputPath(path.parse(root).root, root);
    fs.mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new Error(`ZIP: cannot create extraction directory: ${error.message}`);
  }
  assertSafeOutputPath(root, root);

  let written = 0;
  const createdFiles = [];
  try {
    for (const item of selected) {
      assertSafeOutputPath(root, item.destination);
      fs.mkdirSync(path.dirname(item.destination), { recursive: true });
      assertSafeOutputPath(root, item.destination);
      let existed = true;
      try { fs.lstatSync(item.destination); } catch (error) { if (error.code === 'ENOENT') existed = false; else throw error; }
      const data = readEntryData(zipPath, item.entry, { limits });
      try {
        writeFileChecked(item.destination, data);
      } catch (error) {
        throw new Error(`ZIP: write failed for ${item.entry.name}: ${error.message}`);
      }
      if (!existed) createdFiles.push(item.destination);
      written++;
    }
    return written;
  } catch (error) {
    for (const file of createdFiles) cleanupFile(file);
    throw error;
  }
}

module.exports = {
  DEFAULT_ZIP_LIMITS,
  listEntries,
  readEntryData,
  extractZip,
};
