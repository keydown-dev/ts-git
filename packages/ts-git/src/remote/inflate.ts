/**
 * Minimal zlib / DEFLATE (RFC 1950 / RFC 1951) decoder that reports how many
 * input bytes were consumed.
 *
 * Packfiles store objects as back-to-back zlib streams with no length prefix
 * for the compressed data, so walking a pack requires knowing exactly where
 * each stream ends. General-purpose inflaters (fflate, DecompressionStream)
 * don't expose that, hence this small dedicated implementation.
 */

const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
]);
const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
]);
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
]);
const CODE_LENGTH_ORDER = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);

/**
 * Huffman decoding table indexed by the next `maxLen` input bits (LSB-first,
 * i.e. bit-reversed codes). Each entry packs `symbol << 4 | codeLength`.
 */
interface Huffman {
  table: Uint32Array;
  maxLen: number;
}

function buildHuffman(lengths: Uint8Array, count: number): Huffman {
  let maxLen = 0;
  const counts = new Uint16Array(16);
  for (let i = 0; i < count; i++) {
    counts[lengths[i]]++;
    if (lengths[i] > maxLen) maxLen = lengths[i];
  }
  counts[0] = 0;
  if (maxLen === 0) maxLen = 1;

  const nextCode = new Uint16Array(16);
  let code = 0;
  for (let len = 1; len < 16; len++) {
    code = (code + counts[len - 1]) << 1;
    nextCode[len] = code;
  }

  const size = 1 << maxLen;
  const table = new Uint32Array(size);
  for (let sym = 0; sym < count; sym++) {
    const len = lengths[sym];
    if (len === 0) continue;
    let c = nextCode[len]++;
    let rev = 0;
    for (let i = 0; i < len; i++) {
      rev = (rev << 1) | (c & 1);
      c >>= 1;
    }
    const entry = (sym << 4) | len;
    for (let i = rev; i < size; i += 1 << len) table[i] = entry;
  }
  return { table, maxLen };
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): [Huffman, Huffman] {
  if (!fixedLit || !fixedDist) {
    const lengths = new Uint8Array(288);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    fixedLit = buildHuffman(lengths, 288);
    const dist = new Uint8Array(30).fill(5);
    fixedDist = buildHuffman(dist, 30);
  }
  return [fixedLit, fixedDist];
}

class OutputBuffer {
  buf: Uint8Array;
  len = 0;

  constructor(sizeHint: number) {
    this.buf = new Uint8Array(Math.max(sizeHint, 64));
  }

  ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  push(byte: number): void {
    if (this.len === this.buf.length) this.ensure(1);
    this.buf[this.len++] = byte;
  }

  result(): Uint8Array {
    return this.buf.length === this.len
      ? this.buf
      : this.buf.slice(0, this.len);
  }
}

class BitReader {
  pos: number;
  bitBuf = 0;
  bitCount = 0;

  constructor(
    private data: Uint8Array,
    start: number,
  ) {
    this.pos = start;
  }

  /**
   * Make sure at least `n` bits are buffered. Past the end of input, zero
   * bytes are fed in; they are never counted as consumed (see bytePos), and
   * actually consuming them is caught by checkBounds().
   */
  private fill(n: number): void {
    while (this.bitCount < n) {
      const byte = this.pos < this.data.length ? this.data[this.pos] : 0;
      this.pos++;
      this.bitBuf |= byte << this.bitCount;
      this.bitCount += 8;
    }
  }

  checkBounds(): void {
    if (this.bytePos > this.data.length) {
      throw new Error('inflate: unexpected end of input');
    }
  }

  bits(n: number): number {
    if (n === 0) return 0;
    this.fill(n);
    const value = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return value;
  }

  decode(h: Huffman): number {
    this.fill(h.maxLen);
    const entry = h.table[this.bitBuf & ((1 << h.maxLen) - 1)];
    const len = entry & 15;
    if (len === 0) throw new Error('inflate: invalid Huffman code');
    this.bitBuf >>>= len;
    this.bitCount -= len;
    return entry >>> 4;
  }

  alignToByte(): void {
    const drop = this.bitCount & 7;
    this.bitBuf >>>= drop;
    this.bitCount -= drop;
    // Return whole buffered bytes to the input.
    this.pos -= this.bitCount >> 3;
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  /** Byte position of the first input byte not (even partially) consumed. */
  get bytePos(): number {
    return this.pos - (this.bitCount >> 3);
  }
}

function inflateBlock(
  r: BitReader,
  out: OutputBuffer,
  lit: Huffman,
  dist: Huffman,
): void {
  for (;;) {
    const sym = r.decode(lit);
    if (sym < 256) {
      out.push(sym);
    } else if (sym === 256) {
      r.checkBounds();
      return;
    } else {
      const li = sym - 257;
      if (li >= 29) throw new Error('inflate: invalid length symbol');
      const length = LENGTH_BASE[li] + r.bits(LENGTH_EXTRA[li]);
      const di = r.decode(dist);
      if (di >= 30) throw new Error('inflate: invalid distance symbol');
      const distance = DIST_BASE[di] + r.bits(DIST_EXTRA[di]);
      if (distance > out.len) throw new Error('inflate: distance too far back');
      out.ensure(length);
      const buf = out.buf;
      let from = out.len - distance;
      for (let i = 0; i < length; i++) buf[out.len++] = buf[from++];
    }
  }
}

function readDynamicTables(r: BitReader): [Huffman, Huffman] {
  const hlit = r.bits(5) + 257;
  const hdist = r.bits(5) + 1;
  const hclen = r.bits(4) + 4;

  const clLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i]] = r.bits(3);
  const clHuffman = buildHuffman(clLengths, 19);

  const lengths = new Uint8Array(hlit + hdist);
  let i = 0;
  while (i < hlit + hdist) {
    const sym = r.decode(clHuffman);
    if (sym < 16) {
      lengths[i++] = sym;
    } else {
      let repeat: number;
      let value = 0;
      if (sym === 16) {
        if (i === 0) throw new Error('inflate: repeat with no previous length');
        value = lengths[i - 1];
        repeat = 3 + r.bits(2);
      } else if (sym === 17) {
        repeat = 3 + r.bits(3);
      } else {
        repeat = 11 + r.bits(7);
      }
      if (i + repeat > hlit + hdist) {
        throw new Error('inflate: too many code lengths');
      }
      lengths.fill(value, i, i + repeat);
      i += repeat;
    }
  }

  return [
    buildHuffman(lengths.subarray(0, hlit), hlit),
    buildHuffman(lengths.subarray(hlit), hdist),
  ];
}

/**
 * Inflate a raw DEFLATE stream starting at `offset`.
 * Returns the decompressed bytes and the offset just past the stream.
 */
export function inflateRaw(
  data: Uint8Array,
  offset = 0,
  sizeHint = 1024,
): { data: Uint8Array; end: number } {
  const r = new BitReader(data, offset);
  const out = new OutputBuffer(sizeHint);
  let final = 0;

  while (!final) {
    final = r.bits(1);
    const type = r.bits(2);
    if (type === 0) {
      r.alignToByte();
      r.checkBounds();
      const p = r.pos;
      if (p + 4 > data.length) throw new Error('inflate: truncated block');
      const len = data[p] | (data[p + 1] << 8);
      const nlen = data[p + 2] | (data[p + 3] << 8);
      if ((len ^ 0xffff) !== nlen) {
        throw new Error('inflate: stored block length mismatch');
      }
      if (p + 4 + len > data.length)
        throw new Error('inflate: truncated block');
      out.ensure(len);
      out.buf.set(data.subarray(p + 4, p + 4 + len), out.len);
      out.len += len;
      r.pos = p + 4 + len;
    } else if (type === 1) {
      const [lit, dist] = fixedTables();
      inflateBlock(r, out, lit, dist);
    } else if (type === 2) {
      const [lit, dist] = readDynamicTables(r);
      inflateBlock(r, out, lit, dist);
    } else {
      throw new Error('inflate: invalid block type');
    }
  }

  r.checkBounds();
  return { data: out.result(), end: r.bytePos };
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const len = data.length;
  for (let i = 0; i < len; ) {
    const n = Math.min(len - i, 3800);
    for (let j = 0; j < n; j++, i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate a zlib stream (2-byte header, DEFLATE body, Adler-32 trailer)
 * starting at `offset`. Returns the data and the offset just past the trailer.
 */
export function inflateZlib(
  data: Uint8Array,
  offset = 0,
  sizeHint = 1024,
): { data: Uint8Array; end: number } {
  const cmf = data[offset];
  const flg = data[offset + 1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) {
    throw new Error('inflate: invalid zlib header');
  }
  if (flg & 0x20) throw new Error('inflate: preset dictionary not supported');

  const result = inflateRaw(data, offset + 2, sizeHint);
  const p = result.end;
  if (p + 4 > data.length) throw new Error('inflate: missing adler32 trailer');
  const expected =
    ((data[p] << 24) |
      (data[p + 1] << 16) |
      (data[p + 2] << 8) |
      data[p + 3]) >>>
    0;
  if (adler32(result.data) !== expected) {
    throw new Error('inflate: adler32 checksum mismatch');
  }
  return { data: result.data, end: p + 4 };
}
