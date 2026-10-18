import { FSAdapter } from '../fs/types.js';
import {
  readObject,
  deserializeCommit,
  deserializeTag,
  type GitIdentity,
  type RawObjectHeader,
} from '../core/objects.js';
import { joinPaths } from '../utils/path.js';
import { ObjectNotFoundError } from '../errors.js';
import { resolveRevision } from './resolve-revision.js';
import { lsTree, formatLsTree } from './ls-tree.js';

export interface ReadBlobResult {
  oid: string;
  type: 'blob';
  blob: Uint8Array;
}

export interface ReadTreeResult {
  oid: string;
  type: 'tree';
  entries: { mode: string; path: string; oid: string; type: string }[];
}

export interface ReadCommitResult {
  oid: string;
  type: 'commit';
  tree: string;
  parent: string[];
  author: GitIdentity;
  committer: GitIdentity;
  message: string;
  gpgsig?: string;
  extraHeaders?: RawObjectHeader[];
}

export interface ReadTagResult {
  oid: string;
  type: 'tag';
  object: string;
  objectType: string;
  tag: string;
  tagger?: GitIdentity;
  message: string;
  gpgsig?: string;
}

export type ReadObjectResult =
  | ReadBlobResult
  | ReadTreeResult
  | ReadCommitResult
  | ReadTagResult;

export interface CatFileArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /** Object name: full/abbreviated OID or revision (HEAD, v1^{tree}, HEAD:path...). */
  oid: string;
  /** -t: return the object type. */
  typeOnly?: boolean;
  /** -s: return the object size (as a decimal string, like git prints it). */
  sizeOnly?: boolean;
  /** -p: return git's pretty-printed output (exact stdout). */
  pretty?: boolean;
  /** -e: return 'true'/'false' instead of throwing for missing objects. */
  exists?: boolean;
}

/**
 * `git cat-file`.
 *
 * - `typeOnly` (-t): `'blob' | 'tree' | 'commit' | 'tag'`
 * - `sizeOnly` (-s): size in bytes as a decimal string
 * - `pretty` (-p): exactly what git writes to stdout (blob content, raw
 *   commit/tag content, or `ls-tree` formatted lines for trees)
 * - `exists` (-e): `'true'` or `'false'`
 * - otherwise: the parsed object
 */
export async function catFile(
  args: CatFileArgs,
): Promise<string | ReadObjectResult> {
  const {
    fs,
    dir,
    gitdir = joinPaths(dir, '.git'),
    typeOnly = false,
    sizeOnly = false,
    pretty = false,
    exists = false,
  } = args;

  let oid: string;
  try {
    oid = await resolveRevision(fs, gitdir, args.oid);
  } catch (e) {
    if (exists) return 'false';
    throw e;
  }

  let result: Awaited<ReturnType<typeof readObject>>;
  try {
    result = await readObject(fs, gitdir, oid);
  } catch (e) {
    if (exists) return 'false';
    if (e instanceof ObjectNotFoundError) throw e;
    throw new Error(`Failed to read object ${args.oid}: ${e}`);
  }
  if (exists) return 'true';

  const { type, content } = result;

  if (typeOnly) return type;
  if (sizeOnly) return String(content.length);

  if (pretty) {
    if (type === 'tree') {
      return formatLsTree(await lsTree({ fs, dir, gitdir, tree: oid }));
    }
    // Blobs, commits and tags are printed verbatim.
    return new TextDecoder().decode(content);
  }

  switch (type) {
    case 'blob':
      return { oid, type: 'blob', blob: content };
    case 'tree': {
      const { entries } = await lsTree({ fs, dir, gitdir, tree: oid });
      return {
        oid,
        type: 'tree',
        entries: entries.map(({ mode, path, oid: entryOid, type: t }) => ({
          mode,
          path,
          oid: entryOid,
          type: t,
        })),
      };
    }
    case 'commit':
      return { oid, type: 'commit', ...deserializeCommit(content) };
    case 'tag': {
      const tag = deserializeTag(content);
      const r: ReadTagResult = {
        oid,
        type: 'tag',
        object: tag.object,
        objectType: tag.type,
        tag: tag.tag,
        message: tag.message,
      };
      if (tag.tagger) r.tagger = tag.tagger;
      if (tag.gpgsig) r.gpgsig = tag.gpgsig;
      return r;
    }
  }
}

/** Raw content bytes of an object (`git cat-file <type> <object>`). */
export async function catFileRaw(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  oid: string;
}): Promise<{ oid: string; type: string; content: Uint8Array }> {
  const { fs, dir, gitdir = joinPaths(dir, '.git') } = args;
  const oid = await resolveRevision(fs, gitdir, args.oid);
  const { type, content } = await readObject(fs, gitdir, oid);
  return { oid, type, content };
}
