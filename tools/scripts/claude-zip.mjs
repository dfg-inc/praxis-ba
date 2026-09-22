#!/usr/bin/env node
/**
 * Deterministic ZIP writer + central-directory inspector for Claude plugin archives.
 * Conservative path policy: ASCII [A-Za-z0-9._/-] only.
 */
import { inflateRawSync } from "node:zlib";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const SAFE_ENTRY_RE = /^[A-Za-z0-9._/-]+$/;
export const CLAUDE_ZIP_EPOCH = { year: 2001, month: 1, day: 1, hours: 0, minutes: 0, seconds: 0 };

const UNIX_IFMT = 0o170000;
const UNIX_IFDIR = 0o040000;
const UNIX_IFREG = 0o100000;
const UNIX_IFLNK = 0o120000;
const DOS_DIR = 0x10;

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(buf) {
  let c = 0xffffffff;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function compareZipPath(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function isControlChar(ch) {
  const code = ch.charCodeAt(0);
  return code < 32 || code === 127;
}

function appleMetadataReason(parts) {
  for (const p of parts) {
    if (p === "__MACOSX") return "Apple __MACOSX";
    if (p === ".DS_Store") return "Apple .DS_Store";
    if (p.startsWith("._")) return "Apple AppleDouble";
  }
  return null;
}

/**
 * @param {string} name archive entry name (directories may end with /)
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkSafeArchivePath(name) {
  if (name == null || name === "") {
    return { ok: false, reason: "empty name" };
  }
  if (name.includes("\0")) {
    return { ok: false, reason: "NUL" };
  }
  if (name.startsWith("/") || name.startsWith("\\")) {
    return { ok: false, reason: "absolute path" };
  }
  if (name.includes("\\")) {
    return { ok: false, reason: "backslash" };
  }
  for (const ch of name) {
    if (isControlChar(ch)) {
      return { ok: false, reason: "control character" };
    }
  }
  const stripped = name.replace(/\/+$/, "");
  if (stripped === "") {
    return { ok: false, reason: "empty name" };
  }
  const parts = stripped.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    return { ok: false, reason: "empty or traversal segment" };
  }
  const apple = appleMetadataReason(parts);
  if (apple) return { ok: false, reason: apple };
  if (!SAFE_ENTRY_RE.test(stripped)) {
    const bad = [...new Set([...stripped].filter((c) => !/[A-Za-z0-9._/-]/.test(c)))].join("");
    return { ok: false, reason: `unsupported chars ${JSON.stringify(bad)}` };
  }
  return { ok: true };
}

export function normalizeArchivePath(name) {
  return String(name ?? "").replace(/\\/g, "/");
}

export function invalidPathError(name, reason) {
  return `CLAUDE_PLUGIN_INVALID_PATH: ${name}${reason ? `\n  ${reason}` : ""}`;
}

function dosDateTime() {
  const { year, month, day, hours, minutes, seconds } = CLAUDE_ZIP_EPOCH;
  const dosTime = (hours << 11) | (minutes << 5) | (seconds >> 1);
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

function unixModeFor(entry) {
  if (entry.fileType === "symlink") return UNIX_IFLNK | 0o777;
  if (entry.isDir || entry.fileType === "dir") return UNIX_IFDIR | (entry.mode ?? 0o755);
  return UNIX_IFREG | (entry.mode ?? 0o644);
}

/**
 * @param {Array<{ name: string, data?: Buffer, isDir?: boolean, mode?: number, fileType?: string }>} entries
 * @param {{ enforcePolicy?: boolean }} [opts]
 */
export function writeZip(entries, opts = {}) {
  const enforcePolicy = opts.enforcePolicy !== false;
  const prepared = entries.map((e) => {
    const name = e.isDir || e.fileType === "dir" ? e.name.replace(/\/?$/, "/") : e.name;
    return { ...e, name };
  });
  prepared.sort((a, b) => compareZipPath(a.name, b.name));

  const seenNorm = new Map();
  const seenLower = new Map();
  const { dosTime, dosDate } = dosDateTime();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const e of prepared) {
    const name = e.name;
    if (enforcePolicy) {
      const check = checkSafeArchivePath(name);
      if (!check.ok) {
        throw new Error(invalidPathError(name, check.reason));
      }
    }
    const norm = normalizeArchivePath(name);
    if (seenNorm.has(norm)) {
      throw new Error(`CLAUDE_PLUGIN_DUPLICATE_PATH: ${name}`);
    }
    seenNorm.set(norm, true);
    const lower = norm.toLowerCase();
    const prev = seenLower.get(lower);
    if (prev && prev !== norm) {
      throw new Error(`CLAUDE_PLUGIN_CASE_COLLISION: ${name} vs ${prev}`);
    }
    seenLower.set(lower, norm);

    const isDir = Boolean(e.isDir || e.fileType === "dir" || name.endsWith("/"));
    const data = isDir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    // Store uncompressed so archives are byte-identical across Node/zlib versions.
    const method = 0;
    const compressed = data;
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const unixMode = unixModeFor({ ...e, isDir });
    const ext = ((unixMode << 16) | (isDir ? DOS_DIR : 0)) >>> 0;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(ext, 38);
    cd.writeUInt32LE(offset, 42);

    localChunks.push(local, nameBuf, compressed);
    centralChunks.push(cd, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function unixFileType(externalAttr) {
  return (externalAttr >>> 16) & UNIX_IFMT;
}

function unixPerm(externalAttr) {
  return (externalAttr >>> 16) & 0o777;
}

/**
 * Parse ZIP central directory. Does not rely on `unzip`.
 * @param {Buffer} buffer
 */
export function parseZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("invalid zip: EOCD not found");
  const entriesCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < entriesCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`invalid zip: central directory at ${p}`);
    }
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const versionNeeded = buf.readUInt16LE(p + 6);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttr = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const ftype = unixFileType(externalAttr);
    const isDir = name.endsWith("/") || ftype === UNIX_IFDIR;
    const isSymlink = ftype === UNIX_IFLNK;
    entries.push({
      name,
      compression: method,
      flags,
      versionMadeBy,
      versionNeeded,
      externalAttr,
      localOffset,
      mode: unixPerm(externalAttr),
      fileType: isSymlink ? "symlink" : isDir ? "dir" : ftype && ftype !== UNIX_IFREG ? "special" : "file",
      isDir,
      isSymlink,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== cdOffset + cdSize && cdSize !== 0) {
    // tolerate comment-only mismatch only if we read the declared count
  }
  return { entries, eocdOffset: eocd };
}

export function inspectZipEntries(buffer) {
  const { entries } = parseZip(buffer);
  const issues = [];
  const seenNorm = new Map();
  const seenLower = new Map();
  for (const e of entries) {
    const check = checkSafeArchivePath(e.name);
    if (!check.ok) {
      issues.push(invalidPathError(e.name, check.reason));
    }
    const norm = normalizeArchivePath(e.name);
    if (seenNorm.has(norm)) {
      issues.push(`CLAUDE_PLUGIN_DUPLICATE_PATH: ${e.name}`);
    }
    seenNorm.set(norm, true);
    const lower = norm.toLowerCase();
    const prev = seenLower.get(lower);
    if (prev && prev !== norm) {
      issues.push(`CLAUDE_PLUGIN_CASE_COLLISION: ${e.name} vs ${prev}`);
    }
    seenLower.set(lower, norm);
    if (e.isSymlink || e.fileType === "symlink") {
      issues.push(`CLAUDE_PLUGIN_SYMLINK: ${e.name}`);
    }
    if (e.fileType === "special") {
      issues.push(`CLAUDE_PLUGIN_SPECIAL_FILE: ${e.name}`);
    }
    if (e.compression !== 0 && e.compression !== 8) {
      issues.push(`CLAUDE_PLUGIN_UNSUPPORTED_COMPRESSION: ${e.name} method=${e.compression}`);
    }
    if (e.name.includes("node_modules")) {
      issues.push(`CLAUDE_PLUGIN_NODE_MODULES: ${e.name}`);
    }
    if (/\.tgz$/i.test(e.name) && !e.name.endsWith("/")) {
      issues.push(`CLAUDE_PLUGIN_TGZ: ${e.name}`);
    }
  }
  return { entries, issues };
}

function readLocalFile(buffer, entry) {
  const p = entry.localOffset;
  if (buffer.readUInt32LE(p) !== 0x04034b50) {
    throw new Error(`invalid local header: ${entry.name}`);
  }
  const method = buffer.readUInt16LE(p + 8);
  const compSize = buffer.readUInt32LE(p + 18);
  const uncompSize = buffer.readUInt32LE(p + 22);
  const nameLen = buffer.readUInt16LE(p + 26);
  const extraLen = buffer.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const compressed = buffer.subarray(dataStart, dataStart + compSize);
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) {
    const out = inflateRawSync(compressed);
    if (uncompSize && out.length !== uncompSize) {
      throw new Error(`inflate size mismatch: ${entry.name}`);
    }
    return out;
  }
  throw new Error(`unsupported compression ${method}: ${entry.name}`);
}

/**
 * Extract a validated ZIP to dest. Refuses unsafe/symlink/special entries.
 */
export function extractZip(buffer, dest) {
  const { entries, issues } = inspectZipEntries(buffer);
  if (issues.length) {
    throw new Error(issues.join("\n"));
  }
  mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    const abs = join(dest, e.name);
    if (e.isDir) {
      mkdirSync(abs, { recursive: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    const data = readLocalFile(buffer, e);
    writeFileSync(abs, data);
    const mode = e.name === "bin/praxis" ? 0o755 : e.mode && e.mode & 0o111 ? e.mode : 0o644;
    try {
      chmodSync(abs, mode);
    } catch {
      /* ignore on platforms without chmod */
    }
  }
  return entries;
}

export function directoryEntriesFor(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split("/");
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      dirs.add(`${acc}/`);
    }
  }
  return [...dirs].sort(compareZipPath);
}
