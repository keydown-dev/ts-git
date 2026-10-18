import { FSAdapter } from '../fs/types.js';
import { parseGitDir, joinPaths } from '../utils/path.js';
import { resolveHeadCommitOid } from '../core/refs.js';
import { readObject, deserializeCommit } from '../core/objects.js';
import { NotAGitRepoError } from '../errors.js';
import { resolveRevision, peelTo } from './resolve-revision.js';
import type { LogArgs, LogEntry } from '../types.js';

export interface LogOptions extends LogArgs {
  /** --first-parent: follow only the first parent of merge commits. */
  firstParent?: boolean;
}

async function readShallow(
  fs: FSAdapter,
  gitdir: string,
): Promise<Set<string>> {
  const path = joinPaths(gitdir, 'shallow');
  if (!(await fs.exists(path))) return new Set();
  const content = await fs.readFileString(path);
  return new Set(
    content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * `git log` commit walk.
 *
 * Starts at `ref` (any revision; default HEAD) and walks every parent the
 * way git's default revision walk does: commits are kept in a list ordered
 * by committer date (newest first; on equal dates, earlier-queued commits
 * first) and each popped commit's parents are inserted in parent order.
 * The result is the same sequence `git log --format=%H` prints, including
 * for merges and clock skew. `depth` limits the number of commits
 * (`git log -n`). Commits listed in `.git/shallow` are treated as roots.
 */
export async function log(args: LogOptions): Promise<LogEntry[]> {
  const { fs, dir, gitdir: providedGitdir, depth, ref, firstParent } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);

  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  let start: string | null;
  if (ref === undefined || ref === 'HEAD') {
    // An unborn branch has no commits.
    start = await resolveHeadCommitOid(fs, gitdir);
  } else {
    start = await peelTo(
      fs,
      gitdir,
      await resolveRevision(fs, gitdir, ref),
      'commit',
    );
  }
  if (!start) {
    return [];
  }

  const maxCount = depth ?? Infinity;
  const shallow = await readShallow(fs, gitdir);
  const commits: LogEntry[] = [];
  const seen = new Set<string>([start]);

  interface Queued {
    oid: string;
    entry: LogEntry;
  }
  const queue: Queued[] = [];

  const load = async (oid: string): Promise<Queued> => {
    const { type, content } = await readObject(fs, gitdir, oid);
    if (type !== 'commit') {
      throw new Error(`object ${oid} is a ${type}, not a commit`);
    }
    return { oid, entry: { oid, commit: deserializeCommit(content) } };
  };

  // commit_list_insert_by_date(): insert after every entry whose date is
  // greater than or equal to the new commit's date.
  const insertByDate = (item: Queued) => {
    const date = item.entry.commit.committer.timestamp;
    let i = 0;
    while (
      i < queue.length &&
      queue[i].entry.commit.committer.timestamp >= date
    ) {
      i++;
    }
    queue.splice(i, 0, item);
  };

  queue.push(await load(start));

  while (queue.length > 0 && commits.length < maxCount) {
    const item = queue.shift()!;
    commits.push(item.entry);

    if (shallow.has(item.oid)) continue;
    const parents = firstParent
      ? item.entry.commit.parent.slice(0, 1)
      : item.entry.commit.parent;
    for (const parent of parents) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      insertByDate(await load(parent));
    }
  }

  return commits;
}

export async function readCommit(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  oid: string;
}): Promise<LogEntry> {
  const { fs, dir, gitdir: providedGitdir, oid } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);

  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  const commitOid = await peelTo(
    fs,
    gitdir,
    await resolveRevision(fs, gitdir, oid),
    'commit',
  );
  const { content } = await readObject(fs, gitdir, commitOid);
  const commitObj = deserializeCommit(content);

  return {
    oid: commitOid,
    commit: commitObj,
  };
}
