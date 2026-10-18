import { FSAdapter } from '../fs/types.js';
import { joinPaths } from '../utils/path.js';
import { bufferToHex } from '../utils/buffer.js';
import { unzlibSync } from 'fflate';
import { GitObjectType } from './objects.js';

const PACK_SIGNATURE = 0x5041434b; // "PACK"
const INDEX_V2_SIGNATURE = 0xff744f63; // "\377tOc"

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

/** Parsed `.idx` file (version 1 or 2): object names and their pack offsets. */
interface PackIndex {
  version: 1 | 2;
  oids: string[];
  offsets: number[];
}

interface PackLocation {
  packPath: string;
  offset: number;
}

type PackOffsetsMap = Map<string, PackLocation>;

interface ResolvedObject {
  type: GitObjectType;
  content: Uint8Array;
}

/** Per-repository cache: object locations, raw pack bytes and delta bases. */
interface RepoPackCache {
  /** Sorted list of `.idx` file names the offsets map was built from. */
  idxNames: string[];
  offsets: PackOffsetsMap;
  packData: Map<string, Uint8Array>;
  /** Small LRU of resolved objects keyed by `${packPath}:${offset}`. */
  resolved: Map<string, ResolvedObject>;
  resolvedBytes: number;
}

const MAX_RESOLVED_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_RESOLVED_CACHE_ENTRIES = 4096;

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset] << 24) |
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3]) >>>
    0
  );
}

function readUint64BE(buffer: Uint8Array, offset: number): number {
  const high = readUint32BE(buffer, offset);
  const low = readUint32BE(buffer, offset + 4);
  return high * 0x100000000 + low;
}

/**
 * Parse a pack index. Version 2 starts with a magic number; version 1 has no
 * header at all (it starts directly with the fan-out table).
 * Returns null for files that are not valid indexes.
 */
export function parsePackIndex(data: Uint8Array): PackIndex | null {
  if (data.length >= 8 && readUint32BE(data, 0) === INDEX_V2_SIGNATURE) {
    if (readUint32BE(data, 4) !== 2) return null;
    return parseIndexV2(data);
  }
  return parseIndexV1(data);
}

function parseIndexV2(data: Uint8Array): PackIndex | null {
  const fanoutStart = 8;
  if (data.length < fanoutStart + 256 * 4) return null;
  const objectCount = readUint32BE(data, fanoutStart + 255 * 4);

  const oidsStart = fanoutStart + 256 * 4;
  const crcStart = oidsStart + objectCount * 20;
  const offsetsStart = crcStart + objectCount * 4;
  const largeOffsetsStart = offsetsStart + objectCount * 4;
  // Large-offset table length is variable; trailer is two 20-byte checksums.
  if (data.length < largeOffsetsStart + 40) return null;

  const oids: string[] = new Array(objectCount);
  const offsets: number[] = new Array(objectCount);

  for (let i = 0; i < objectCount; i++) {
    const p = oidsStart + i * 20;
    oids[i] = bufferToHex(data.subarray(p, p + 20));

    const raw = readUint32BE(data, offsetsStart + i * 4);
    if (raw & 0x80000000) {
      // MSB set: the low 31 bits index the 64-bit offset table that follows
      // the 32-bit offset table in the .idx file.
      const largeIndex = raw & 0x7fffffff;
      const p64 = largeOffsetsStart + largeIndex * 8;
      if (p64 + 8 > data.length - 40) return null;
      offsets[i] = readUint64BE(data, p64);
    } else {
      offsets[i] = raw;
    }
  }

  return { version: 2, oids, offsets };
}

function parseIndexV1(data: Uint8Array): PackIndex | null {
  if (data.length < 256 * 4 + 40) return null;
  const objectCount = readUint32BE(data, 255 * 4);
  // Fan-out, then N x (4-byte offset + 20-byte name), then two checksums.
  if (data.length !== 256 * 4 + objectCount * 24 + 40) return null;

  // The fan-out table must be monotonic.
  let prev = 0;
  for (let i = 0; i < 256; i++) {
    const v = readUint32BE(data, i * 4);
    if (v < prev) return null;
    prev = v;
  }

  const oids: string[] = new Array(objectCount);
  const offsets: number[] = new Array(objectCount);
  let pos = 256 * 4;
  for (let i = 0; i < objectCount; i++) {
    offsets[i] = readUint32BE(data, pos);
    oids[i] = bufferToHex(data.subarray(pos + 4, pos + 24));
    pos += 24;
  }

  return { version: 1, oids, offsets };
}

async function readPackIndex(
  fs: FSAdapter,
  idxPath: string,
): Promise<PackIndex | null> {
  if (!(await fs.exists(idxPath))) {
    return null;
  }
  return parsePackIndex(await fs.readFile(idxPath));
}

function packDirOf(gitdir: string): string {
  return joinPaths(gitdir, 'objects', 'pack');
}

async function listIdxNames(fs: FSAdapter, gitdir: string): Promise<string[]> {
  const packDir = packDirOf(gitdir);
  if (!(await fs.exists(packDir))) {
    return [];
  }
  const entries = await fs.readdir(packDir);
  return entries
    .map((e) => e.name)
    .filter((name) => name.endsWith('.idx') && !name.startsWith('.'))
    .sort();
}

async function buildOffsets(
  fs: FSAdapter,
  gitdir: string,
  idxNames: string[],
): Promise<PackOffsetsMap> {
  const packDir = packDirOf(gitdir);
  const offsets: PackOffsetsMap = new Map();

  for (const idxName of idxNames) {
    const idxPath = joinPaths(packDir, idxName);
    const packPath = joinPaths(packDir, idxName.replace(/\.idx$/, '.pack'));
    if (!(await fs.exists(packPath))) continue;

    const idx = await readPackIndex(fs, idxPath);
    if (!idx) continue;

    for (let i = 0; i < idx.oids.length; i++) {
      // First pack wins, like git (duplicates are identical objects).
      if (!offsets.has(idx.oids[i])) {
        offsets.set(idx.oids[i], { packPath, offset: idx.offsets[i] });
      }
    }
  }

  return offsets;
}

const packCache = new WeakMap<FSAdapter, Map<string, RepoPackCache>>();

async function loadRepoCache(
  fs: FSAdapter,
  gitdir: string,
  idxNames?: string[],
): Promise<RepoPackCache> {
  const names = idxNames ?? (await listIdxNames(fs, gitdir));
  const repoCache: RepoPackCache = {
    idxNames: names,
    offsets: await buildOffsets(fs, gitdir, names),
    packData: new Map(),
    resolved: new Map(),
    resolvedBytes: 0,
  };
  let perFs = packCache.get(fs);
  if (!perFs) {
    perFs = new Map();
    packCache.set(fs, perFs);
  }
  perFs.set(gitdir, repoCache);
  return repoCache;
}

async function getRepoCache(
  fs: FSAdapter,
  gitdir: string,
): Promise<RepoPackCache> {
  const cached = packCache.get(fs)?.get(gitdir);
  if (cached) return cached;
  return loadRepoCache(fs, gitdir);
}

/**
 * Look up an object's pack location. On a miss the pack directory is
 * re-listed and, if packs were added or removed since the cache was built
 * (e.g. by a fetch or `git gc`), the cache is rebuilt — the same strategy git
 * uses (reprepare_packed_git).
 */
async function findPackLocation(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<{ repo: RepoPackCache; location: PackLocation } | null> {
  let repo = await getRepoCache(fs, gitdir);
  let location = repo.offsets.get(oid);
  if (location) return { repo, location };

  const names = await listIdxNames(fs, gitdir);
  if (
    names.length !== repo.idxNames.length ||
    names.some((n, i) => n !== repo.idxNames[i])
  ) {
    repo = await loadRepoCache(fs, gitdir, names);
    location = repo.offsets.get(oid);
    if (location) return { repo, location };
  }
  return null;
}

/**
 * Drop every cached pack index, pack file and resolved object for this
 * filesystem. Call after writing or deleting pack files.
 */
export function invalidatePackCache(fs: FSAdapter): void {
  packCache.delete(fs);
}

async function getPackData(
  fs: FSAdapter,
  repo: RepoPackCache,
  packPath: string,
): Promise<Uint8Array> {
  const cached = repo.packData.get(packPath);
  if (cached) return cached;

  const data = await fs.readFile(packPath);
  if (data.length < 12 || readUint32BE(data, 0) !== PACK_SIGNATURE) {
    throw new Error(`Invalid pack file signature: ${packPath}`);
  }
  const version = readUint32BE(data, 4);
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported pack version: ${version}`);
  }
  repo.packData.set(packPath, data);
  return data;
}

function rememberResolved(
  repo: RepoPackCache,
  key: string,
  obj: ResolvedObject,
): void {
  if (obj.content.length > MAX_RESOLVED_CACHE_BYTES / 4) return;
  repo.resolved.set(key, obj);
  repo.resolvedBytes += obj.content.length;
  while (
    repo.resolved.size > MAX_RESOLVED_CACHE_ENTRIES ||
    repo.resolvedBytes > MAX_RESOLVED_CACHE_BYTES
  ) {
    const oldestKey = repo.resolved.keys().next().value as string;
    const oldest = repo.resolved.get(oldestKey)!;
    repo.resolved.delete(oldestKey);
    repo.resolvedBytes -= oldest.content.length;
  }
}

const OBJECT_TYPES: Record<number, GitObjectType> = {
  [OBJ_COMMIT]: 'commit',
  [OBJ_TREE]: 'tree',
  [OBJ_BLOB]: 'blob',
  [OBJ_TAG]: 'tag',
};

/** Inflate the zlib stream starting at `offset` whose output is `size` bytes. */
function inflateAt(data: Uint8Array, offset: number, size: number): Uint8Array {
  const out = unzlibSync(data.subarray(offset), { out: new Uint8Array(size) });
  if (out.length !== size) {
    throw new Error(
      `Pack object size mismatch at offset ${offset}: expected ${size}, got ${out.length}`,
    );
  }
  return out;
}

async function readPackObject(
  fs: FSAdapter,
  gitdir: string,
  repo: RepoPackCache,
  packPath: string,
  offset: number,
  depth: number = 0,
): Promise<ResolvedObject> {
  const key = `${packPath}:${offset}`;
  const hit = repo.resolved.get(key);
  if (hit) {
    // Refresh LRU position.
    repo.resolved.delete(key);
    repo.resolved.set(key, hit);
    return hit;
  }

  if (depth > 10000) {
    throw new Error('Delta chain too deep (corrupt pack?)');
  }

  const packData = await getPackData(fs, repo, packPath);

  let pos = offset;
  let byte = packData[pos++];
  const typeNum = (byte >> 4) & 0x07;
  // Object size: 4 bits in the first byte, then 7 bits per continuation byte.
  let size = byte & 0x0f;
  let multiplier = 16;
  while (byte & 0x80) {
    byte = packData[pos++];
    size += (byte & 0x7f) * multiplier;
    multiplier *= 128;
  }

  let result: ResolvedObject;

  if (typeNum === OBJ_OFS_DELTA) {
    const { baseOffset, consumedBytes } = readOfsDeltaOffset(packData, pos);
    pos += consumedBytes;
    const delta = inflateAt(packData, pos, size);
    const base = await readPackObject(
      fs,
      gitdir,
      repo,
      packPath,
      offset - baseOffset,
      depth + 1,
    );
    result = { type: base.type, content: applyDelta(delta, base.content) };
  } else if (typeNum === OBJ_REF_DELTA) {
    const baseOid = bufferToHex(packData.subarray(pos, pos + 20));
    pos += 20;
    const delta = inflateAt(packData, pos, size);
    const base = await readBaseByOid(fs, gitdir, baseOid, depth + 1);
    result = { type: base.type, content: applyDelta(delta, base.content) };
  } else if (OBJECT_TYPES[typeNum]) {
    result = {
      type: OBJECT_TYPES[typeNum],
      content: inflateAt(packData, pos, size),
    };
  } else {
    throw new Error(`Invalid pack object type ${typeNum} at offset ${offset}`);
  }

  rememberResolved(repo, key, result);
  return result;
}

/** Resolve a REF_DELTA base: any pack in the repository, else a loose object. */
async function readBaseByOid(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
  depth: number,
): Promise<ResolvedObject> {
  const found = await findPackLocation(fs, gitdir, oid);
  if (found) {
    return readPackObject(
      fs,
      gitdir,
      found.repo,
      found.location.packPath,
      found.location.offset,
      depth,
    );
  }

  const loosePath = joinPaths(gitdir, 'objects', oid.slice(0, 2), oid.slice(2));
  if (!(await fs.exists(loosePath))) {
    throw new Error(`Delta base ${oid} not found`);
  }
  const decompressed = unzlibSync(await fs.readFile(loosePath));
  const nullIndex = decompressed.indexOf(0);
  const header = new TextDecoder().decode(decompressed.subarray(0, nullIndex));
  const [typeStr] = header.split(' ');
  return {
    type: typeStr as GitObjectType,
    content: decompressed.slice(nullIndex + 1),
  };
}

/**
 * OFS_DELTA base offset: big-endian base-128 where each continuation adds 1
 * before shifting (so there is exactly one encoding per value).
 */
function readOfsDeltaOffset(
  data: Uint8Array,
  offset: number,
): { baseOffset: number; consumedBytes: number } {
  let pos = offset;
  let byte = data[pos++];
  let baseOffset = byte & 0x7f;
  while (byte & 0x80) {
    byte = data[pos++];
    baseOffset = (baseOffset + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset, consumedBytes: pos - offset };
}

export function applyDelta(delta: Uint8Array, base: Uint8Array): Uint8Array {
  let pos = 0;

  const readVarInt = (): number => {
    let value = 0;
    let multiplier = 1;
    let byte: number;
    do {
      byte = delta[pos++];
      value += (byte & 0x7f) * multiplier;
      multiplier *= 128;
    } while (byte & 0x80);
    return value;
  };

  const baseSize = readVarInt();
  const resultSize = readVarInt();

  if (baseSize !== base.length) {
    throw new Error('Base size mismatch in delta');
  }

  const result = new Uint8Array(resultSize);
  let resultPos = 0;

  while (pos < delta.length) {
    const cmd = delta[pos++];

    if (cmd & 0x80) {
      // Copy from base
      let copyOffset = 0;
      let copySize = 0;

      if (cmd & 0x01) copyOffset |= delta[pos++];
      if (cmd & 0x02) copyOffset |= delta[pos++] << 8;
      if (cmd & 0x04) copyOffset |= delta[pos++] << 16;
      if (cmd & 0x08)
        copyOffset = (copyOffset >>> 0) + delta[pos++] * 0x1000000;

      if (cmd & 0x10) copySize |= delta[pos++];
      if (cmd & 0x20) copySize |= delta[pos++] << 8;
      if (cmd & 0x40) copySize |= delta[pos++] << 16;
      if (copySize === 0) copySize = 0x10000;

      if (
        copyOffset + copySize > base.length ||
        resultPos + copySize > resultSize
      ) {
        throw new Error('Delta copy out of bounds');
      }
      result.set(base.subarray(copyOffset, copyOffset + copySize), resultPos);
      resultPos += copySize;
    } else if (cmd) {
      // Insert literal data
      if (resultPos + cmd > resultSize || pos + cmd > delta.length) {
        throw new Error('Delta insert out of bounds');
      }
      result.set(delta.subarray(pos, pos + cmd), resultPos);
      resultPos += cmd;
      pos += cmd;
    } else {
      throw new Error('Invalid delta command: 0');
    }
  }

  if (resultPos !== resultSize) {
    throw new Error('Result size mismatch in delta');
  }

  return result;
}

export async function readObjectFromPackfile(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<{ type: GitObjectType; content: Uint8Array } | null> {
  const found = await findPackLocation(fs, gitdir, oid.toLowerCase());
  if (!found) {
    return null;
  }
  const obj = await readPackObject(
    fs,
    gitdir,
    found.repo,
    found.location.packPath,
    found.location.offset,
  );
  return { type: obj.type, content: obj.content };
}

export async function hasObjectInPackfile(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<boolean> {
  return (await findPackLocation(fs, gitdir, oid.toLowerCase())) !== null;
}

/** All object IDs stored in packs (used for abbreviated OID lookup). */
export async function listPackedOids(
  fs: FSAdapter,
  gitdir: string,
): Promise<string[]> {
  // Always re-check the pack directory so new packs are seen.
  const names = await listIdxNames(fs, gitdir);
  let repo = await getRepoCache(fs, gitdir);
  if (
    names.length !== repo.idxNames.length ||
    names.some((n, i) => n !== repo.idxNames[i])
  ) {
    repo = await loadRepoCache(fs, gitdir, names);
  }
  return Array.from(repo.offsets.keys());
}
