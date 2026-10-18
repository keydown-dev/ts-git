import { zlibSync } from 'fflate';
import { FSAdapter } from '../fs/types.js';
import { joinPaths } from '../utils/path.js';
import { bufferToHex, hexToBuffer, stringToBuffer } from '../utils/buffer.js';
import { sha1 } from './hash.js';
import { GitObjectType, serializeObject } from './objects.js';
import { invalidatePackCache } from './packfile.js';
import { inflateZlib } from '../remote/inflate.js';

/**
 * Packfile creation and indexing (the moral equivalents of
 * `git pack-objects` and `git index-pack`).
 *
 * Format reference: Documentation/gitformat-pack.txt
 */

const TYPE_TO_NUM: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const NUM_TO_TYPE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32BE(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function encodeObjectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(byte);
  return new Uint8Array(bytes);
}

function concat(chunks: Uint8Array[], total?: number): Uint8Array {
  const length = total ?? chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface PackObjectInput {
  type: GitObjectType;
  content: Uint8Array;
}

/**
 * Build a version 2 packfile containing the given objects, each stored whole
 * (no deltas). Returns the pack bytes; the last 20 bytes are its SHA-1.
 */
export async function createPackfile(
  objects: PackObjectInput[],
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [
    stringToBuffer('PACK'),
    uint32BE(2),
    uint32BE(objects.length),
  ];
  for (const obj of objects) {
    chunks.push(encodeObjectHeader(TYPE_TO_NUM[obj.type], obj.content.length));
    chunks.push(zlibSync(obj.content));
  }
  const body = concat(chunks);
  const checksum = hexToBuffer((await sha1(body)).oid);
  return concat([body, checksum]);
}

export interface IndexedPackObject {
  oid: string;
  type: GitObjectType;
  offset: number;
  crc: number;
}

export interface IndexedPack {
  /** Hex SHA-1 trailer of the pack (also the pack's file name). */
  checksum: string;
  objects: IndexedPackObject[];
  /** Version 2 `.idx` file contents for the pack. */
  idx: Uint8Array;
}

export type ExternalObjectResolver = (
  oid: string,
) => Promise<{ type: GitObjectType; content: Uint8Array } | null>;

interface RawEntry {
  offset: number;
  typeNum: number;
  /** Decompressed payload (object content, or delta instructions). */
  data: Uint8Array;
  baseOffset?: number;
  baseOid?: string;
  crc: number;
}

function readVarint(delta: Uint8Array, pos: { p: number }): number {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = delta[pos.p++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return value;
}

/** Apply a git delta (gitformat-pack "Deltified representation"). */
export function applyGitDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const pos = { p: 0 };
  const baseSize = readVarint(delta, pos);
  const resultSize = readVarint(delta, pos);
  if (baseSize !== base.length) {
    throw new Error('delta: base size mismatch');
  }
  const out = new Uint8Array(resultSize);
  let o = 0;
  while (pos.p < delta.length) {
    const cmd = delta[pos.p++];
    if (cmd & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (cmd & 0x01) copyOffset |= delta[pos.p++];
      if (cmd & 0x02) copyOffset |= delta[pos.p++] << 8;
      if (cmd & 0x04) copyOffset |= delta[pos.p++] << 16;
      if (cmd & 0x08) copyOffset = (copyOffset | (delta[pos.p++] << 24)) >>> 0;
      if (cmd & 0x10) copySize |= delta[pos.p++];
      if (cmd & 0x20) copySize |= delta[pos.p++] << 8;
      if (cmd & 0x40) copySize |= delta[pos.p++] << 16;
      if (copySize === 0) copySize = 0x10000;
      out.set(base.subarray(copyOffset, copyOffset + copySize), o);
      o += copySize;
    } else if (cmd) {
      out.set(delta.subarray(pos.p, pos.p + cmd), o);
      o += cmd;
      pos.p += cmd;
    } else {
      throw new Error('delta: invalid opcode 0');
    }
  }
  if (o !== resultSize) throw new Error('delta: result size mismatch');
  return out;
}

/**
 * Parse a packfile, resolve all deltas, compute every object id and build
 * the matching version 2 `.idx`.
 *
 * REF_DELTA bases missing from the pack (thin packs) are looked up through
 * `resolveExternal`, typically the local object database.
 */
export async function indexPackfile(
  pack: Uint8Array,
  resolveExternal?: ExternalObjectResolver,
): Promise<IndexedPack> {
  if (pack.length < 32) throw new Error('index-pack: pack too short');
  const signature = new TextDecoder().decode(pack.subarray(0, 4));
  if (signature !== 'PACK') throw new Error('index-pack: bad pack signature');
  const version = (pack[4] << 24) | (pack[5] << 16) | (pack[6] << 8) | pack[7];
  if (version !== 2 && version !== 3) {
    throw new Error(`index-pack: unsupported pack version ${version}`);
  }
  const count =
    ((pack[8] << 24) | (pack[9] << 16) | (pack[10] << 8) | pack[11]) >>> 0;

  const trailerStart = pack.length - 20;
  const actualChecksum = (await sha1(pack.subarray(0, trailerStart))).oid;
  const checksum = bufferToHex(pack.subarray(trailerStart));
  if (actualChecksum !== checksum) {
    throw new Error('index-pack: pack checksum mismatch');
  }

  const entries: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const start = pos;
    let byte = pack[pos++];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }

    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeNum === OBJ_OFS_DELTA) {
      byte = pack[pos++];
      let rel = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++];
        rel = (rel + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = start - rel;
    } else if (typeNum === OBJ_REF_DELTA) {
      baseOid = bufferToHex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else if (!NUM_TO_TYPE[typeNum]) {
      throw new Error(`index-pack: invalid object type ${typeNum}`);
    }

    const inflated = inflateZlib(pack, pos, size);
    if (inflated.data.length !== size) {
      throw new Error('index-pack: object size mismatch');
    }
    pos = inflated.end;
    if (pos > trailerStart) throw new Error('index-pack: truncated pack');

    entries.push({
      offset: start,
      typeNum,
      data: inflated.data,
      baseOffset,
      baseOid,
      crc: crc32(pack.subarray(start, pos)),
    });
  }
  if (pos !== trailerStart) {
    throw new Error('index-pack: unexpected data after last object');
  }

  const byOffset = new Map<number, RawEntry>();
  for (const e of entries) byOffset.set(e.offset, e);

  const resolved = new Map<
    number,
    { type: GitObjectType; content: Uint8Array }
  >();
  const oidToOffset = new Map<string, number>();

  // Base objects first, then resolve delta chains iteratively.
  for (const e of entries) {
    if (e.typeNum !== OBJ_OFS_DELTA && e.typeNum !== OBJ_REF_DELTA) {
      const type = NUM_TO_TYPE[e.typeNum];
      resolved.set(e.offset, { type, content: e.data });
    }
  }

  const resolveEntry = (
    e: RawEntry,
    stack: Set<number>,
  ): { type: GitObjectType; content: Uint8Array } | null => {
    const done = resolved.get(e.offset);
    if (done) return done;
    if (stack.has(e.offset)) throw new Error('index-pack: delta cycle');
    stack.add(e.offset);

    let base: { type: GitObjectType; content: Uint8Array } | null = null;
    if (e.baseOffset !== undefined) {
      const baseEntry = byOffset.get(e.baseOffset);
      if (!baseEntry) throw new Error('index-pack: bad OFS_DELTA base');
      base = resolveEntry(baseEntry, stack);
    } else if (e.baseOid) {
      const baseOffset = oidToOffset.get(e.baseOid);
      if (baseOffset !== undefined) {
        base = resolveEntry(byOffset.get(baseOffset)!, stack);
      }
    }
    stack.delete(e.offset);
    if (!base) return null;

    const obj = {
      type: base.type,
      content: applyGitDelta(base.content, e.data),
    };
    resolved.set(e.offset, obj);
    return obj;
  };

  const oidOf = async (offset: number): Promise<string> => {
    const obj = resolved.get(offset)!;
    return (await sha1(serializeObject(obj.type, obj.content))).oid;
  };
  const registered = new Set<number>();
  const registerResolved = async (): Promise<void> => {
    for (const offset of [...resolved.keys()]) {
      if (registered.has(offset)) continue;
      registered.add(offset);
      oidToOffset.set(await oidOf(offset), offset);
    }
  };
  await registerResolved();

  // Resolve deltas in rounds: a REF_DELTA base may itself only become known
  // (by oid) once another chain has been resolved.
  let remaining = entries.filter((e) => !resolved.has(e.offset));
  while (remaining.length > 0) {
    let progressed = false;
    for (const e of remaining) {
      if (resolveEntry(e, new Set())) progressed = true;
    }
    await registerResolved();
    remaining = remaining.filter((e) => !resolved.has(e.offset));
    if (remaining.length === 0 || progressed) continue;

    // Thin pack: pull missing REF_DELTA bases from outside the pack.
    for (const e of remaining) {
      if (!e.baseOid || oidToOffset.has(e.baseOid)) continue;
      const external = resolveExternal
        ? await resolveExternal(e.baseOid)
        : null;
      if (!external) {
        throw new Error(`index-pack: missing delta base ${e.baseOid}`);
      }
      resolved.set(e.offset, {
        type: external.type,
        content: applyGitDelta(external.content, e.data),
      });
      progressed = true;
    }
    await registerResolved();
    remaining = remaining.filter((e) => !resolved.has(e.offset));
    if (!progressed) throw new Error('index-pack: unresolvable deltas');
  }

  const objects: IndexedPackObject[] = [];
  for (const [oid, offset] of oidToOffset) {
    objects.push({
      oid,
      type: resolved.get(offset)!.type,
      offset,
      crc: byOffset.get(offset)!.crc,
    });
  }
  if (objects.length !== count) {
    throw new Error('index-pack: duplicate objects in pack');
  }

  const idx = await createPackIndex(objects, checksum);
  return { checksum, objects, idx };
}

/** Serialize a version 2 pack index for the given objects. */
export async function createPackIndex(
  objects: Array<{ oid: string; offset: number; crc: number }>,
  packChecksum: string,
): Promise<Uint8Array> {
  const sorted = [...objects].sort((a, b) =>
    a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0,
  );
  const n = sorted.length;

  const fanout = new Uint8Array(256 * 4);
  const counts = new Uint32Array(256);
  for (const o of sorted) counts[parseInt(o.oid.slice(0, 2), 16)]++;
  let running = 0;
  for (let i = 0; i < 256; i++) {
    running += counts[i];
    fanout.set(uint32BE(running), i * 4);
  }

  const names = new Uint8Array(n * 20);
  const crcs = new Uint8Array(n * 4);
  const offsets = new Uint8Array(n * 4);
  const large: number[] = [];
  sorted.forEach((o, i) => {
    names.set(hexToBuffer(o.oid), i * 20);
    crcs.set(uint32BE(o.crc), i * 4);
    if (o.offset >= 0x80000000) {
      offsets.set(uint32BE((0x80000000 | large.length) >>> 0), i * 4);
      large.push(o.offset);
    } else {
      offsets.set(uint32BE(o.offset), i * 4);
    }
  });
  const largeTable = new Uint8Array(large.length * 8);
  large.forEach((offset, i) => {
    largeTable.set(uint32BE(Math.floor(offset / 2 ** 32)), i * 8);
    largeTable.set(uint32BE(offset >>> 0), i * 8 + 4);
  });

  const body = concat([
    new Uint8Array([0xff, 0x74, 0x4f, 0x63]),
    uint32BE(2),
    fanout,
    names,
    crcs,
    offsets,
    largeTable,
    hexToBuffer(packChecksum),
  ]);
  const idxChecksum = hexToBuffer((await sha1(body)).oid);
  return concat([body, idxChecksum]);
}

/**
 * Index `pack` and store it as `objects/pack/pack-<sha>.{pack,idx}` in
 * `gitdir`, making its objects visible to readObject().
 */
export async function storePackfile(
  fs: FSAdapter,
  gitdir: string,
  pack: Uint8Array,
  resolveExternal?: ExternalObjectResolver,
): Promise<IndexedPack> {
  const indexed = await indexPackfile(pack, resolveExternal);
  const packDir = joinPaths(gitdir, 'objects', 'pack');
  if (!(await fs.exists(packDir))) {
    await fs.mkdir(packDir, { recursive: true });
  }
  const base = joinPaths(packDir, `pack-${indexed.checksum}`);
  // Write the pack before its index so readers never see a dangling .idx.
  await fs.writeFile(`${base}.pack`, pack);
  await fs.writeFile(`${base}.idx`, indexed.idx);
  invalidatePackCache(fs);
  return indexed;
}
