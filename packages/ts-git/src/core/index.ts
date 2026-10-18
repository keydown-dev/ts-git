import { FSAdapter } from '../fs/types.js';
import { joinPaths, normalizeRepoRelativePath } from '../utils/path.js';
import {
  readUint32BE,
  writeUint32BE,
  readUint16BE,
  writeUint16BE,
  bufferToHex,
  hexToBuffer,
  concatBuffers,
} from '../utils/buffer.js';
import { sha1 } from './hash.js';
import { IndexParseError } from '../errors.js';

export interface IndexEntry {
  ctimeSeconds: number;
  ctimeNanoseconds: number;
  mtimeSeconds: number;
  mtimeNanoseconds: number;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  oid: string;
  flags: number;
  path: string;
}

export interface Index {
  version: number;
  entries: IndexEntry[];
}

const INDEX_SIGNATURE = 0x44495243;
const INDEX_VERSION_2 = 2;
const INDEX_VERSION_3 = 3;
const INDEX_VERSION_4 = 4;

/** Git index: CE_EXTENDED — extra uint16 (extended flags) appears before the path. */
export const CE_EXTENDED = 0x4000;

/** Stage bits in flags: 0 = merged, 1/2/3 = unmerged stages. */
export function indexEntryStage(flags: number): number {
  return (flags >> 12) & 3;
}

/** Group index entries by normalized path (multiple stages = unmerged). */
export function groupIndexEntriesByPath(
  entries: IndexEntry[],
): Map<string, IndexEntry[]> {
  const m = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const p = normalizeRepoRelativePath(e.path);
    const list = m.get(p) ?? [];
    list.push(e);
    m.set(p, list);
  }
  for (const list of m.values()) {
    list.sort((a, b) => indexEntryStage(a.flags) - indexEntryStage(b.flags));
  }
  return m;
}

/**
 * One entry per path for status/diff: merged (stage 0), else "ours" (stage 2), else last stage.
 */
export function pickRepresentativeIndexEntry(
  entries: IndexEntry[],
): IndexEntry | undefined {
  if (entries.length === 0) return undefined;
  const stage0 = entries.find((e) => indexEntryStage(e.flags) === 0);
  if (stage0) return stage0;
  const ours = entries.find((e) => indexEntryStage(e.flags) === 2);
  if (ours) return ours;
  return entries[entries.length - 1];
}

export function parseIndex(data: Uint8Array): Index {
  // Git index has 12-byte header + entries + 20-byte SHA-1 checksum
  if (data.length < 32) {
    throw new IndexParseError('Index file too small');
  }

  const signature = readUint32BE(data, 0);
  if (signature !== INDEX_SIGNATURE) {
    throw new IndexParseError(
      `Invalid index signature: ${signature.toString(16)}`,
    );
  }

  const version = readUint32BE(data, 4);
  if (version === INDEX_VERSION_4) {
    throw new IndexParseError(
      'Index version 4 is not supported. Rebuild the index with Git version 2 or 3 (e.g. `git config core.indexVersion 3` and `git read-tree HEAD` or `git add --all`).',
    );
  }
  if (version !== INDEX_VERSION_2 && version !== INDEX_VERSION_3) {
    throw new IndexParseError(`Unsupported index version: ${version}`);
  }

  const entryCount = readUint32BE(data, 8);
  const entries: IndexEntry[] = [];

  let offset = 12;

  // Git index ends with 20-byte SHA-1 checksum, don't parse it as entries
  const checksumEnd = data.length - 20;

  for (let i = 0; i < entryCount; i++) {
    if (offset >= checksumEnd) {
      throw new IndexParseError(`Unexpected end of index at entry ${i}`);
    }

    const { entry, byteLength } = parseIndexEntry(data, offset, version);
    entries.push(entry);
    offset += byteLength;
  }

  return { version, entries };
}

function parseIndexEntry(
  data: Uint8Array,
  offset: number,
  _version: number,
): { entry: IndexEntry; byteLength: number } {
  // Index stat fields are unsigned 32-bit; `>>> 0` undoes the sign extension
  // of the bitwise read so values >= 2^31 (inodes, nanoseconds) stay positive.
  const u32 = (at: number): number => readUint32BE(data, offset + at) >>> 0;
  const ctimeSeconds = u32(0);
  const ctimeNanoseconds = u32(4);
  const mtimeSeconds = u32(8);
  const mtimeNanoseconds = u32(12);
  const dev = u32(16);
  const ino = u32(20);
  const mode = u32(24);
  const uid = u32(28);
  const gid = u32(32);
  const size = u32(36);
  const oid = bufferToHex(data.slice(offset + 40, offset + 60));
  const flags = readUint16BE(data, offset + 60);

  let pathStart = offset + 62;
  if (flags & CE_EXTENDED) {
    pathStart += 2;
  }

  // The 12-bit length field saturates at 0xfff for long paths; the path is
  // always NUL-terminated, so find the terminator instead of trusting it.
  let pathLength = flags & 0xfff;
  if (pathLength === 0xfff) {
    const nul = data.indexOf(0, pathStart + 0xfff);
    pathLength = (nul === -1 ? data.length : nul) - pathStart;
  }

  const pathEnd = pathStart + pathLength;
  const pathData = data.slice(pathStart, pathEnd);
  const rawPath = new TextDecoder().decode(pathData);
  const path = normalizeRepoRelativePath(rawPath);

  const byteLength = (pathStart - offset + pathLength + 1 + 7) & ~7;

  const entry: IndexEntry = {
    ctimeSeconds,
    ctimeNanoseconds,
    mtimeSeconds,
    mtimeNanoseconds,
    dev,
    ino,
    mode,
    uid,
    gid,
    size,
    oid,
    flags,
    path,
  };

  return { entry, byteLength };
}

/**
 * Git orders index entries by the raw bytes of their path (memcmp), then by
 * stage. Locale-aware comparison would put e.g. "B" after "a" and break
 * `git ls-files` / binary searches in canonical git.
 */
export function compareIndexEntries(a: IndexEntry, b: IndexEntry): number {
  const c = comparePathBytes(a.path, b.path);
  if (c !== 0) return c;
  return indexEntryStage(a.flags) - indexEntryStage(b.flags);
}

const pathEncoder = new TextEncoder();

/** memcmp-style comparison of the UTF-8 encodings of two paths. */
export function comparePathBytes(a: string, b: string): number {
  if (a === b) return 0;
  const ab = pathEncoder.encode(a);
  const bb = pathEncoder.encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i];
  }
  return ab.length - bb.length;
}

export function sortIndexEntries(entries: IndexEntry[]): IndexEntry[] {
  return entries.sort(compareIndexEntries);
}

export async function serializeIndex(index: Index): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];

  const sortedEntries = [...index.entries].sort(compareIndexEntries);

  // Extended flags (CE_EXTENDED) are only legal in index version 3+.
  let version = index.version;
  if (
    version < INDEX_VERSION_3 &&
    sortedEntries.some((e) => (e.flags & CE_EXTENDED) !== 0)
  ) {
    version = INDEX_VERSION_3;
  }

  parts.push(writeUint32BE(INDEX_SIGNATURE));
  parts.push(writeUint32BE(version));
  parts.push(writeUint32BE(sortedEntries.length));

  for (const entry of sortedEntries) {
    parts.push(serializeIndexEntry(entry, version));
  }

  // Git index requires a 20-byte SHA-1 checksum of all preceding content
  const data = concatBuffers(...parts);
  const checksum = await sha1(data);
  const checksumBytes = hexToBuffer(checksum.oid);

  return concatBuffers(data, checksumBytes);
}

function serializeIndexEntry(entry: IndexEntry, _version: number): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(writeUint32BE(entry.ctimeSeconds));
  parts.push(writeUint32BE(entry.ctimeNanoseconds));
  parts.push(writeUint32BE(entry.mtimeSeconds));
  parts.push(writeUint32BE(entry.mtimeNanoseconds));
  parts.push(writeUint32BE(entry.dev));
  parts.push(writeUint32BE(entry.ino));
  parts.push(writeUint32BE(entry.mode));
  parts.push(writeUint32BE(entry.uid));
  parts.push(writeUint32BE(entry.gid));
  parts.push(writeUint32BE(entry.size));
  parts.push(hexToBuffer(entry.oid));

  const pathBytes = stringToBuffer(entry.path);
  // The low 12 bits hold the path length in *bytes* (saturating at 0xfff);
  // keep the caller's assume-valid / extended / stage bits.
  const flags = (entry.flags & 0xf000) | Math.min(pathBytes.length, 0xfff);
  parts.push(writeUint16BE(flags));

  if (flags & CE_EXTENDED) {
    parts.push(writeUint16BE(0));
  }

  parts.push(pathBytes);
  parts.push(new Uint8Array([0]));

  const base = 62 + ((flags & CE_EXTENDED) !== 0 ? 2 : 0);
  const entryLength = (base + pathBytes.length + 1 + 7) & ~7;
  const padding = entryLength - base - pathBytes.length - 1;
  if (padding > 0) {
    parts.push(new Uint8Array(padding));
  }

  return concatBuffers(...parts);
}

function stringToBuffer(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export async function readIndex(fs: FSAdapter, gitdir: string): Promise<Index> {
  const indexPath = joinPaths(gitdir, 'index');

  if (!(await fs.exists(indexPath))) {
    return { version: INDEX_VERSION_2, entries: [] };
  }

  const data = await fs.readFile(indexPath);
  return parseIndex(data);
}

export async function writeIndex(
  fs: FSAdapter,
  gitdir: string,
  index: Index,
): Promise<void> {
  const indexPath = joinPaths(gitdir, 'index');
  const data = await serializeIndex(index);
  await fs.writeFile(indexPath, data);
}

export function createIndexEntry(options: {
  path: string;
  oid: string;
  mode: number;
  mtimeMs: number;
  size: number;
}): IndexEntry {
  const now = Math.floor(Date.now() / 1000);
  const mtimeSeconds = Math.floor(options.mtimeMs / 1000);
  const mtimeNanoseconds = Math.floor((options.mtimeMs % 1000) * 1000000);

  return {
    ctimeSeconds: now,
    ctimeNanoseconds: 0,
    mtimeSeconds,
    mtimeNanoseconds,
    dev: 0,
    ino: 0,
    mode: options.mode,
    uid: 0,
    gid: 0,
    size: options.size,
    oid: options.oid,
    flags: createFlags(options.path),
    path: normalizeRepoRelativePath(options.path),
  };
}

/** Index entry flags for a stage-0 entry: the path's UTF-8 byte length, capped at 0xfff. */
export function createFlags(path: string, stage: number = 0): number {
  const pathLength = Math.min(pathEncoder.encode(path).length, 0xfff);
  return ((stage & 3) << 12) | pathLength;
}

export function updateIndexEntry(index: Index, entry: IndexEntry): Index {
  const normalizedPath = normalizeRepoRelativePath(entry.path);
  const existingIndex = index.entries.findIndex(
    (e) => normalizeRepoRelativePath(e.path) === normalizedPath,
  );

  if (existingIndex >= 0) {
    index.entries[existingIndex] = entry;
  } else {
    index.entries.push(entry);
  }

  return index;
}

export function removeIndexEntry(index: Index, path: string): Index {
  const np = normalizeRepoRelativePath(path);
  index.entries = index.entries.filter(
    (e) => normalizeRepoRelativePath(e.path) !== np,
  );
  return index;
}

export function findIndexEntry(
  index: Index,
  path: string,
): IndexEntry | undefined {
  const np = normalizeRepoRelativePath(path);
  return index.entries.find((e) => normalizeRepoRelativePath(e.path) === np);
}
