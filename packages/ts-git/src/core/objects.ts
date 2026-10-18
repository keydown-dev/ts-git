import { zlibSync, unzlibSync } from 'fflate';
import { FSAdapter } from '../fs/types.js';
import { joinPaths, dirname } from '../utils/path.js';
import { bufferToHex, stringToBuffer, concatBuffers } from '../utils/buffer.js';
import { sha1 } from './hash.js';
import { ObjectNotFoundError, InvalidObjectTypeError } from '../errors.js';
import { readObjectFromPackfile, hasObjectInPackfile } from './packfile.js';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface ObjectHeader {
  type: GitObjectType;
  size: number;
}

export function parseObjectHeader(data: Uint8Array): ObjectHeader | null {
  const nullIndex = data.indexOf(0);
  if (nullIndex === -1) return null;

  const headerStr = new TextDecoder().decode(data.slice(0, nullIndex));
  const match = headerStr.match(/^(\w+) (\d+)$/);

  if (!match) return null;

  return {
    type: match[1] as GitObjectType,
    size: parseInt(match[2], 10),
  };
}

export function serializeObject(
  type: GitObjectType,
  content: Uint8Array,
): Uint8Array {
  const headerStr = `${type} ${content.length}\0`;
  const header = stringToBuffer(headerStr);
  return concatBuffers(header, content);
}

export function deserializeObject(data: Uint8Array): {
  type: GitObjectType;
  content: Uint8Array;
} {
  const header = parseObjectHeader(data);
  if (!header) {
    throw new InvalidObjectTypeError('Invalid object format: missing header');
  }

  const nullIndex = data.indexOf(0);
  const content = data.slice(nullIndex + 1);

  return {
    type: header.type,
    content,
  };
}

export function objectToRaw(
  type: GitObjectType,
  content: Uint8Array,
): Uint8Array {
  const serialized = serializeObject(type, content);
  const compressed = zlibSync(serialized); // Use zlib format (RFC 1950) for Git compatibility
  return compressed;
}

export function rawToObject(data: Uint8Array): {
  type: GitObjectType;
  content: Uint8Array;
} {
  const decompressed = unzlibSync(data); // Use zlib format (RFC 1950) for Git compatibility
  return deserializeObject(decompressed);
}

export async function computeOid(
  type: GitObjectType,
  content: Uint8Array,
): Promise<string> {
  const serialized = serializeObject(type, content);
  return (await sha1(serialized)).oid;
}

export function objectPath(oid: string, gitdir: string): string {
  return joinPaths(gitdir, 'objects', oid.slice(0, 2), oid.slice(2));
}

export async function readObject(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<{ type: GitObjectType; content: Uint8Array; oid: string }> {
  const path = objectPath(oid, gitdir);

  // Check if loose object exists first
  if (await fs.exists(path)) {
    const compressed = await fs.readFile(path);
    const { type, content } = rawToObject(compressed);
    return { type, content, oid };
  }

  // No loose object - try packfile
  const packObject = await readObjectFromPackfile(fs, gitdir, oid);
  if (packObject) {
    return { type: packObject.type, content: packObject.content, oid };
  }

  throw new ObjectNotFoundError(`Object ${oid} not found`, oid);
}

export async function writeObject(
  fs: FSAdapter,
  gitdir: string,
  type: GitObjectType,
  content: Uint8Array,
): Promise<string> {
  const oid = await computeOid(type, content);
  const path = objectPath(oid, gitdir);

  const dir = dirname(path);
  if (!(await fs.exists(dir))) {
    await fs.mkdir(dir, { recursive: true });
  }

  const raw = objectToRaw(type, content);
  await fs.writeFile(path, raw);

  return oid;
}

export async function hasObject(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<boolean> {
  const path = objectPath(oid, gitdir);
  if (await fs.exists(path)) {
    return true;
  }
  return hasObjectInPackfile(fs, gitdir, oid);
}

export function serializeBlob(content: Uint8Array): Uint8Array {
  return content;
}

export function deserializeBlob(content: Uint8Array): Uint8Array {
  return content;
}

export interface TreeEntryRaw {
  mode: string;
  path: string;
  oid: string;
}

export function serializeTree(entries: TreeEntryRaw[]): Uint8Array {
  const parts: Uint8Array[] = [];

  for (const entry of entries) {
    const modeBuffer = stringToBuffer(entry.mode + ' ');
    const pathBuffer = stringToBuffer(entry.path);
    const oidBuffer = hexToBuffer(entry.oid);
    const nullByte = new Uint8Array([0]);

    parts.push(modeBuffer, pathBuffer, nullByte, oidBuffer);
  }

  return concatBuffers(...parts);
}

function hexToBuffer(hex: string): Uint8Array {
  const array = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    array[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return array;
}

export function deserializeTree(content: Uint8Array): TreeEntryRaw[] {
  const entries: TreeEntryRaw[] = [];
  let offset = 0;

  while (offset < content.length) {
    const spaceIndex = content.indexOf(0x20, offset);
    if (spaceIndex === -1) break;

    const mode = new TextDecoder().decode(content.slice(offset, spaceIndex));
    const nullIndex = content.indexOf(0, spaceIndex);
    if (nullIndex === -1) break;

    const path = new TextDecoder().decode(
      content.slice(spaceIndex + 1, nullIndex),
    );
    const oid = bufferToHex(content.slice(nullIndex + 1, nullIndex + 21));

    entries.push({ mode, path, oid });
    offset = nullIndex + 21;
  }

  return entries;
}

export interface GitIdentity {
  name: string;
  email: string;
  timestamp: number;
  /**
   * Minutes *behind* UTC, matching `Date.prototype.getTimezoneOffset()`
   * (so `+0200` is `-120`). `-0` encodes git's special `-0000` zone.
   */
  timezoneOffset: number;
}

/** A raw (possibly multi-line) header from a commit or tag object. */
export interface RawObjectHeader {
  key: string;
  value: string;
}

export interface CommitData {
  tree: string;
  parent: string[];
  author: GitIdentity;
  committer: GitIdentity;
  message: string;
  gpgsig?: string;
  /**
   * Headers other than tree/parent/author/committer/gpgsig (for example
   * `encoding`, `mergetag`, `gpgsig-sha256` or unknown headers), in object
   * order. They are written after `committer` and before `gpgsig`, which is
   * where git puts them, so re-serializing a parsed commit yields
   * byte-identical content (and therefore the same OID).
   */
  extraHeaders?: RawObjectHeader[];
}

/**
 * Append a header line. Multi-line values are written the way git writes
 * them: every line after the first is prefixed with a single space.
 */
function pushHeader(lines: string[], key: string, value: string): void {
  lines.push(`${key} ${value.split('\n').join('\n ')}`);
}

/**
 * Split the header block of a commit/tag object into (key, value) pairs,
 * folding continuation lines (lines starting with a space) back into the
 * previous value, and return the message: everything after the first blank
 * line, verbatim.
 */
export function parseObjectHeaders(str: string): {
  headers: RawObjectHeader[];
  message: string;
} {
  const headers: RawObjectHeader[] = [];
  let pos = 0;
  let message = '';

  while (pos < str.length) {
    let end = str.indexOf('\n', pos);
    if (end === -1) end = str.length;
    const line = str.slice(pos, end);
    pos = end + 1;

    if (line === '') {
      message = str.slice(pos);
      break;
    }

    if (line.startsWith(' ') && headers.length > 0) {
      headers[headers.length - 1].value += '\n' + line.slice(1);
      continue;
    }

    const spaceIndex = line.indexOf(' ');
    if (spaceIndex === -1) {
      headers.push({ key: line, value: '' });
    } else {
      headers.push({
        key: line.slice(0, spaceIndex),
        value: line.slice(spaceIndex + 1),
      });
    }
  }

  return { headers, message };
}

export function formatIdentity(identity: GitIdentity): string {
  return `${identity.name} <${identity.email}> ${identity.timestamp} ${formatTimezone(identity.timezoneOffset)}`;
}

export function serializeCommit(commit: CommitData): Uint8Array {
  const lines: string[] = [];

  lines.push(`tree ${commit.tree}`);

  for (const parent of commit.parent) {
    lines.push(`parent ${parent}`);
  }

  lines.push(`author ${formatIdentity(commit.author)}`);
  lines.push(`committer ${formatIdentity(commit.committer)}`);

  for (const header of commit.extraHeaders ?? []) {
    pushHeader(lines, header.key, header.value);
  }

  // Git appends the signature after every other header.
  if (commit.gpgsig !== undefined) {
    pushHeader(lines, 'gpgsig', commit.gpgsig);
  }

  return stringToBuffer(lines.join('\n') + '\n\n' + commit.message);
}

export function formatTimezone(offset: number): string {
  // offset is minutes behind UTC; -0 is git's "-0000" (unknown zone).
  const negative = offset > 0 || Object.is(offset, -0);
  const sign = negative ? '-' : '+';
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  return `${sign}${hours.toString().padStart(2, '0')}${minutes.toString().padStart(2, '0')}`;
}

export function deserializeCommit(content: Uint8Array): CommitData {
  const str = new TextDecoder().decode(content);
  const { headers, message } = parseObjectHeaders(str);

  let tree: string | undefined;
  const parent: string[] = [];
  let author: GitIdentity | undefined;
  let committer: GitIdentity | undefined;
  let gpgsig: string | undefined;
  const extraHeaders: RawObjectHeader[] = [];

  for (const { key, value } of headers) {
    if (key === 'tree' && tree === undefined) {
      tree = value;
    } else if (key === 'parent' && !author) {
      parent.push(value);
    } else if (key === 'author' && !author) {
      author = parseIdentity(value);
    } else if (key === 'committer' && !committer) {
      committer = parseIdentity(value);
    } else if (key === 'gpgsig' && gpgsig === undefined) {
      gpgsig = value;
    } else {
      extraHeaders.push({ key, value });
    }
  }

  const result: CommitData = {
    tree: tree ?? '',
    parent,
    author: author ?? emptyIdentity(),
    committer: committer ?? emptyIdentity(),
    message,
  };
  if (gpgsig !== undefined) result.gpgsig = gpgsig;
  if (extraHeaders.length > 0) result.extraHeaders = extraHeaders;
  return result;
}

export interface TagData {
  object: string;
  type: GitObjectType;
  tag: string;
  /** Absent on some very old tags. */
  tagger?: GitIdentity;
  /** Message including any trailing signature, verbatim. */
  message: string;
  /** Signature block found at the end of the message, if any (read-only). */
  gpgsig?: string;
  extraHeaders?: RawObjectHeader[];
}

export function serializeTag(tag: TagData): Uint8Array {
  const lines: string[] = [];
  lines.push(`object ${tag.object}`);
  lines.push(`type ${tag.type}`);
  lines.push(`tag ${tag.tag}`);
  if (tag.tagger) {
    lines.push(`tagger ${formatIdentity(tag.tagger)}`);
  }
  for (const header of tag.extraHeaders ?? []) {
    pushHeader(lines, header.key, header.value);
  }
  return stringToBuffer(lines.join('\n') + '\n\n' + tag.message);
}

export function deserializeTag(content: Uint8Array): TagData {
  const str = new TextDecoder().decode(content);
  const { headers, message } = parseObjectHeaders(str);

  let object: string | undefined;
  let type: GitObjectType | undefined;
  let tag: string | undefined;
  let tagger: GitIdentity | undefined;
  const extraHeaders: RawObjectHeader[] = [];

  for (const { key, value } of headers) {
    if (key === 'object' && object === undefined) {
      object = value;
    } else if (key === 'type' && type === undefined) {
      type = value as GitObjectType;
    } else if (key === 'tag' && tag === undefined) {
      tag = value;
    } else if (key === 'tagger' && tagger === undefined) {
      tagger = parseIdentity(value);
    } else {
      extraHeaders.push({ key, value });
    }
  }

  const result: TagData = {
    object: object ?? '',
    type: type ?? 'commit',
    tag: tag ?? '',
    message,
  };
  if (tagger) result.tagger = tagger;
  if (extraHeaders.length > 0) result.extraHeaders = extraHeaders;

  const sigStart = findSignatureStart(message);
  if (sigStart !== -1) {
    result.gpgsig = message.slice(sigStart);
  }
  return result;
}

const SIGNATURE_MARKERS = [
  '-----BEGIN PGP SIGNATURE-----',
  '-----BEGIN PGP MESSAGE-----',
  '-----BEGIN SSH SIGNATURE-----',
  '-----BEGIN SIGNED MESSAGE-----',
];

/** Offset of a signature block that starts at the beginning of a line. */
function findSignatureStart(message: string): number {
  for (const marker of SIGNATURE_MARKERS) {
    if (message.startsWith(marker)) return 0;
    const idx = message.indexOf('\n' + marker);
    if (idx !== -1) return idx + 1;
  }
  return -1;
}

function emptyIdentity(): GitIdentity {
  return { name: '', email: '', timestamp: 0, timezoneOffset: 0 };
}

/**
 * Parse `Name <email> timestamp tz` the way git's split_ident_line does:
 * the email is delimited by the first `<` and the following `>`; the name is
 * whatever precedes `<` with surrounding whitespace removed (it may be empty).
 */
export function parseIdentity(value: string): GitIdentity {
  const lt = value.indexOf('<');
  const gt = lt === -1 ? -1 : value.indexOf('>', lt + 1);
  if (lt === -1 || gt === -1) {
    return emptyIdentity();
  }

  const name = value.slice(0, lt).trim();
  const email = value.slice(lt + 1, gt);
  const rest = value.slice(gt + 1).trim();
  const match = rest.match(/^(\d+)\s+([+-]\d{4})$/);
  if (!match) {
    return { name, email, timestamp: 0, timezoneOffset: 0 };
  }

  return {
    name,
    email,
    timestamp: parseInt(match[1], 10),
    timezoneOffset: parseTimezone(match[2]),
  };
}

/** Parse `+HHMM` / `-HHMM` into minutes behind UTC (`-0000` becomes -0). */
export function parseTimezone(tz: string): number {
  const match = tz.match(/([+-])(\d{2})(\d{2})/);
  if (!match) return 0;

  const [, sign, hours, minutes] = match;
  const offset = parseInt(hours, 10) * 60 + parseInt(minutes, 10);
  if (offset === 0) {
    return sign === '-' ? -0 : 0;
  }
  return sign === '+' ? -offset : offset;
}
