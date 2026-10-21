import { FSAdapter } from '../fs/types.js';
import {
  writeObject,
  computeOid,
  parseObjectHeaders,
  type GitObjectType,
} from '../core/objects.js';
import { joinPaths } from '../utils/path.js';

export interface HashObjectArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /** Object content. If omitted, `filepath` is read instead. */
  object?: Uint8Array;
  /** File to hash (relative to `dir` or absolute) when `object` is omitted. */
  filepath?: string;
  /** -t: object type (default `blob`). */
  type?: GitObjectType;
  /** -w: write the object into the object database. */
  write?: boolean;
  /** --literally: skip the format checks for non-blob types. */
  literally?: boolean;
}

export interface HashObjectResult {
  oid: string;
  written: boolean;
}

const OID_RE = /^[0-9a-f]{40}$/;
const IDENT_RE = /^[^<>\n]*<[^<>\n]*> \d+ [+-]\d{4}$/;

/**
 * Basic version of the fsck checks `git hash-object -t <type>` runs on
 * non-blob objects, so obviously malformed objects are rejected.
 */
export function validateObject(type: GitObjectType, content: Uint8Array): void {
  if (type === 'blob') return;

  if (type === 'tree') {
    let pos = 0;
    while (pos < content.length) {
      const space = content.indexOf(0x20, pos);
      const nul = space === -1 ? -1 : content.indexOf(0, space);
      if (space === -1 || nul === -1 || nul + 21 > content.length) {
        throw new Error('corrupt tree object');
      }
      const mode = new TextDecoder().decode(content.subarray(pos, space));
      if (!/^[0-7]+$/.test(mode) || nul === space + 1) {
        throw new Error('corrupt tree object');
      }
      pos = nul + 21;
    }
    return;
  }

  const { headers } = parseObjectHeaders(new TextDecoder().decode(content));
  const keys = headers.map((h) => h.key);
  const get = (k: string) => headers.find((h) => h.key === k)?.value;

  if (type === 'commit') {
    if (keys[0] !== 'tree' || !OID_RE.test(get('tree') ?? '')) {
      throw new Error("invalid format - expected 'tree' line");
    }
    let i = 1;
    while (keys[i] === 'parent') {
      if (!OID_RE.test(headers[i].value)) throw new Error('invalid parent');
      i++;
    }
    if (keys[i] !== 'author' || !IDENT_RE.test(headers[i].value)) {
      throw new Error("invalid format - expected 'author' line");
    }
    if (keys[i + 1] !== 'committer' || !IDENT_RE.test(headers[i + 1].value)) {
      throw new Error("invalid format - expected 'committer' line");
    }
    return;
  }

  if (type === 'tag') {
    if (keys[0] !== 'object' || !OID_RE.test(headers[0].value)) {
      throw new Error("invalid format - expected 'object' line");
    }
    if (
      keys[1] !== 'type' ||
      !['blob', 'tree', 'commit', 'tag'].includes(headers[1].value)
    ) {
      throw new Error("invalid format - expected 'type' line");
    }
    if (keys[2] !== 'tag' || headers[2].value === '') {
      throw new Error("invalid format - expected 'tag' line");
    }
    if (keys[3] !== 'tagger' || !IDENT_RE.test(headers[3].value)) {
      throw new Error("invalid format - expected 'tagger' line");
    }
    return;
  }

  throw new Error(`invalid object type "${type}"`);
}

/**
 * `git hash-object [-t <type>] [-w] [--literally] (<file> | --stdin)`.
 * Never touches the index (use updateIndex for that).
 */
export async function hashObject(
  args: HashObjectArgs,
): Promise<HashObjectResult> {
  const {
    fs,
    dir,
    gitdir = joinPaths(dir, '.git'),
    filepath,
    type = 'blob',
    write = false,
    literally = false,
  } = args;

  let content = args.object;
  if (!content) {
    if (!filepath) throw new Error('hashObject: object or filepath required');
    const full = filepath.startsWith('/') ? filepath : joinPaths(dir, filepath);
    content = await fs.readFile(full);
  }

  if (!literally) validateObject(type, content);

  if (write) {
    const oid = await writeObject(fs, gitdir, type, content);
    return { oid, written: true };
  }
  return { oid: await computeOid(type, content), written: false };
}

export async function hashObjectString(
  args: Omit<HashObjectArgs, 'object'> & { content: string },
): Promise<HashObjectResult> {
  const encoder = new TextEncoder();
  return hashObject({ ...args, object: encoder.encode(args.content) });
}
