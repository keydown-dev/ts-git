/**
 * pkt-line framing (gitprotocol-common(5)).
 *
 * Each packet is a 4-hex-digit length (including the 4 length bytes) followed
 * by the payload. "0000" is a flush packet, "0001" a delimiter (protocol v2)
 * and "0002" a response-end packet.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Largest payload a single pkt-line may carry (65520 - 4). */
export const MAX_PKT_PAYLOAD = 65516;

export const FLUSH_PKT = encoder.encode('0000');
export const DELIM_PKT = encoder.encode('0001');

export type PktLine =
  | { type: 'data'; data: Uint8Array }
  | { type: 'flush' }
  | { type: 'delim' }
  | { type: 'response-end' };

export function encodePktLine(payload: string | Uint8Array): Uint8Array {
  const data = typeof payload === 'string' ? encoder.encode(payload) : payload;
  if (data.length > MAX_PKT_PAYLOAD) {
    throw new Error(`pkt-line payload too long (${data.length} bytes)`);
  }
  const out = new Uint8Array(data.length + 4);
  out.set(encoder.encode((data.length + 4).toString(16).padStart(4, '0')));
  out.set(data, 4);
  return out;
}

/** Incremental pkt-line reader over an in-memory buffer. */
export class PktLineReader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }

  seek(offset: number): void {
    this.pos = offset;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Remaining unread bytes (e.g. a raw packfile after the pkt-lines). */
  rest(): Uint8Array {
    return this.buf.subarray(this.pos);
  }

  peekIsPktLine(): boolean {
    if (this.pos + 4 > this.buf.length) return false;
    return /^[0-9a-f]{4}$/.test(
      decoder.decode(this.buf.subarray(this.pos, this.pos + 4)),
    );
  }

  read(): PktLine | null {
    if (this.pos >= this.buf.length) return null;
    if (this.pos + 4 > this.buf.length) {
      throw new Error('pkt-line: truncated length header');
    }
    const lenStr = decoder.decode(this.buf.subarray(this.pos, this.pos + 4));
    if (!/^[0-9a-f]{4}$/.test(lenStr)) {
      throw new Error(`pkt-line: invalid length header "${lenStr}"`);
    }
    const len = parseInt(lenStr, 16);
    if (len === 0 || len === 1 || len === 2) {
      this.pos += 4;
      return {
        type: len === 0 ? 'flush' : len === 1 ? 'delim' : 'response-end',
      };
    }
    if (len < 4) throw new Error(`pkt-line: invalid length ${len}`);
    if (this.pos + len > this.buf.length) {
      throw new Error('pkt-line: truncated packet');
    }
    const data = this.buf.subarray(this.pos + 4, this.pos + len);
    this.pos += len;
    return { type: 'data', data };
  }
}

/** Decode a data packet as text, dropping one trailing LF. */
export function pktText(data: Uint8Array): string {
  const text = decoder.decode(data);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
