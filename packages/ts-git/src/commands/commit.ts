import { FSAdapter } from '../fs/types.js';
import { parseGitDir } from '../utils/path.js';
import {
  normalizeTimestamp,
  normalizeTimezoneOffset,
  Author,
} from '../types.js';
import { writeObject, serializeCommit } from '../core/objects.js';
import { readIndex } from '../core/index.js';
import {
  resolveHead,
  writeRef,
  readRef,
  setHeadDetached,
  setHead,
} from '../core/refs.js';
import { EmptyCommitError, NotAGitRepoError, TsGitError } from '../errors.js';
import {
  writeTreeFromIndex,
  readCommitTree,
  EMPTY_TREE_OID,
} from './tree-helpers.js';

/**
 * How to clean up the commit message, mirroring `git commit --cleanup`:
 * - `whitespace` (default, what `git commit -m` does): strip trailing
 *   whitespace from every line, drop leading/trailing blank lines, collapse
 *   runs of blank lines and terminate the message with a newline
 * - `strip`: like `whitespace`, and also remove `#` comment lines
 * - `verbatim`: store the message exactly as given (like `git commit-tree`)
 */
export type CommitCleanupMode = 'whitespace' | 'strip' | 'verbatim';

export async function commit(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  message: string;
  author: Author;
  committer?: Author;
  ref?: string;
  parent?: string[];
  dryRun?: boolean;
  noUpdateBranch?: boolean;
  /** Allow a commit whose tree equals its parent's (`git commit --allow-empty`). */
  allowEmpty?: boolean;
  /** Allow an empty message after cleanup (`--allow-empty-message`). */
  allowEmptyMessage?: boolean;
  /** Message cleanup mode; defaults to `whitespace` like `git commit -m`. */
  cleanup?: CommitCleanupMode;
}): Promise<string> {
  const {
    fs,
    dir,
    gitdir: providedGitdir,
    message: rawMessage,
    author,
    committer,
    ref,
    parent: explicitParent,
    dryRun = false,
    noUpdateBranch = false,
    allowEmpty = false,
    allowEmptyMessage = false,
    cleanup = 'whitespace',
  } = args;

  const { gitdir } = parseGitDir(dir, providedGitdir);

  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  const message = cleanupMessage(rawMessage, cleanup);
  if (message === '' && !allowEmptyMessage) {
    throw new TsGitError('Aborting commit due to empty commit message.');
  }

  const index = await readIndex(fs, gitdir);

  // Build tree from index (refuses unmerged entries, like git write-tree)
  const treeOid = await writeTreeFromIndex(fs, gitdir, index.entries);

  // Determine parents
  let parent: string[] = explicitParent ?? [];
  const headInfo = await resolveHead(fs, gitdir);

  if (!explicitParent && headInfo) {
    if (headInfo.type === 'commit') {
      parent = [headInfo.oid];
    } else {
      const oid = await readRef(fs, gitdir, headInfo.ref);
      if (oid) {
        parent = [oid];
      }
    }
  }

  // git refuses "nothing to commit" unless --allow-empty: for a normal commit
  // that means the tree equals the parent's tree; for the initial commit, an
  // empty tree. (Explicit parents behave like `git commit-tree`: no check.)
  if (!allowEmpty && !explicitParent) {
    if (parent.length === 1) {
      let parentTree: string | null = null;
      try {
        parentTree = await readCommitTree(fs, gitdir, parent[0]);
      } catch {
        parentTree = null;
      }
      if (parentTree === treeOid) {
        throw new EmptyCommitError('nothing to commit, working tree clean');
      }
    } else if (parent.length === 0 && treeOid === EMPTY_TREE_OID) {
      throw new EmptyCommitError('nothing to commit');
    }
  }

  const authorIdent = sanitizeIdent(author);
  const committerIdent = sanitizeIdent(committer ?? author);

  const commitObj = {
    tree: treeOid,
    parent,
    author: {
      ...authorIdent,
      timestamp: normalizeTimestamp(author.timestamp),
      timezoneOffset: normalizeTimezoneOffset(author.timezoneOffset),
    },
    committer: {
      ...committerIdent,
      timestamp: normalizeTimestamp((committer ?? author).timestamp),
      timezoneOffset: normalizeTimezoneOffset(
        (committer ?? author).timezoneOffset,
      ),
    },
    message,
  };

  const commitContent = serializeCommit(commitObj);
  const commitOid = await writeObject(fs, gitdir, 'commit', commitContent);

  if (dryRun) {
    return commitOid;
  }

  if (!noUpdateBranch) {
    if (ref) {
      const refPath = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
      await writeRef(fs, gitdir, refPath, commitOid, true);
    } else if (headInfo?.type === 'commit') {
      // Detached HEAD: move HEAD itself
      await setHeadDetached(fs, gitdir, commitOid);
    } else if (headInfo?.type === 'symbolic') {
      // Update the full ref HEAD points to (also for an unborn branch with a
      // nested name such as refs/heads/feature/x).
      await writeRef(fs, gitdir, headInfo.ref, commitOid, true);
    } else {
      // No HEAD at all - create master and point HEAD to it
      await writeRef(fs, gitdir, 'refs/heads/master', commitOid, true);
      await setHead(fs, gitdir, 'refs/heads/master');
    }
  }

  return commitOid;
}

/**
 * Clean up a commit message like git's `strbuf_stripspace()`.
 */
export function cleanupMessage(
  message: string,
  mode: CommitCleanupMode = 'whitespace',
): string {
  if (mode === 'verbatim') {
    return message;
  }

  const out: string[] = [];
  let pendingBlank = false;
  for (const rawLine of message.split('\n')) {
    if (mode === 'strip' && rawLine.startsWith('#')) {
      continue;
    }
    const line = rawLine.replace(/[ \t\n\v\f\r]+$/, '');
    if (line === '') {
      pendingBlank = out.length > 0;
      continue;
    }
    if (pendingBlank) {
      out.push('');
      pendingBlank = false;
    }
    out.push(line);
  }

  return out.length === 0 ? '' : out.join('\n') + '\n';
}

function isCrud(c: string): boolean {
  return c.charCodeAt(0) <= 32 || ',:;<>"\\\''.includes(c);
}

/**
 * git's `strbuf_addstr_without_crud()`: trim "crud" from both ends and drop
 * the delimiter characters `\n`, `<` and `>` from name and email.
 */
function withoutCrud(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isCrud(value[start])) start++;
  while (end > start && isCrud(value[end - 1])) end--;
  return value.slice(start, end).replace(/[\n<>]/g, '');
}

function sanitizeIdent(ident: Author): { name: string; email: string } {
  const name = withoutCrud(ident.name ?? '');
  const email = withoutCrud(ident.email ?? '');
  if (name === '') {
    throw new TsGitError(`empty ident name (for <${email}>) not allowed`);
  }
  return { name, email };
}
