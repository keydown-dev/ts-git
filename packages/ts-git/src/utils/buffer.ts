export function toUint8Array(
  data: ArrayLike<number> | Buffer | Uint8Array,
): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

export function bufferToString(buffer: Uint8Array): string {
  return new TextDecoder().decode(buffer);
}

export function stringToBuffer(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function concatBuffers(
  ...buffers: (Uint8Array | ArrayBuffer)[]
): Uint8Array {
  const totalLength = buffers.reduce(
    (acc, buf) =>
      acc + (buf instanceof Uint8Array ? buf.byteLength : buf.byteLength),
    0,
  );
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const buf of buffers) {
    const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    result.set(arr, offset);
    offset += arr.length;
  }

  return result;
}

export function compareBuffers(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
}

export function sliceBuffer(
  buffer: Uint8Array,
  start: number,
  end?: number,
): Uint8Array {
  return buffer.slice(start, end);
}

export function hexToBuffer(hex: string): Uint8Array {
  const cleanHex = hex.replace(/\s/g, '');
  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const array = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    array[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
  }
  return array;
}

export function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function padStart(
  str: string,
  length: number,
  char: string = ' ',
): string {
  if (str.length >= length) return str;
  return char.repeat(length - str.length) + str;
}

export function padEnd(
  str: string,
  length: number,
  char: string = ' ',
): string {
  if (str.length >= length) return str;
  return str + char.repeat(length - str.length);
}

export function readUint32BE(buffer: Uint8Array, offset: number): number {
  // `>>> 0` keeps values >= 2^31 (inode numbers, sizes, ...) unsigned.
  return (
    ((buffer[offset] << 24) |
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3]) >>>
    0
  );
}

export function writeUint32BE(value: number): Uint8Array {
  const buffer = new Uint8Array(4);
  buffer[0] = (value >> 24) & 0xff;
  buffer[1] = (value >> 16) & 0xff;
  buffer[2] = (value >> 8) & 0xff;
  buffer[3] = value & 0xff;
  return buffer;
}

export function readUint16BE(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] << 8) | buffer[offset + 1];
}

export function writeUint16BE(value: number): Uint8Array {
  const buffer = new Uint8Array(2);
  buffer[0] = (value >> 8) & 0xff;
  buffer[1] = value & 0xff;
  return buffer;
}
