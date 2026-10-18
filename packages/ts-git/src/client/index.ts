import {
  init,
  add,
  addAll,
  remove,
  commit,
  status,
  statusMatrix,
  log,
  branch,
  listBranchesCommand,
  deleteBranch,
  checkoutBranch,
  reset,
  diff,
  type ResetMode,
  type CheckoutTreeResult,
  addRemote,
  removeRemote,
  listRemotes,
  setRemoteUrl,
  setUpstream,
  fetch,
  push,
  pull,
  clone,
  merge,
  abortMerge,
  type RemoteInfo,
  type RemoteOptions,
  type FetchArgs,
  type FetchResult,
  type PushArgs,
  type PushResult,
  type PullArgs,
  type PullResult,
  type CloneArgs,
  type CloneResult,
  type MergeArgs,
  type MergeResult,
} from '../commands/index.js';
import {
  type StatusRow,
  type LogEntry,
  type Author,
  type DiffResult,
  type DiffSide,
  type LineDiffAlgorithm,
} from '../types.js';
import type { FSAdapter } from '../fs/types.js';
import { parseGitDir } from '../utils/path.js';

type RepoKeys = 'fs' | 'dir' | 'gitdir';

export interface GitClientOptions {
  fs: FSAdapter;
  /**
   * Defaults for every remote operation (fetch, push, pull, clone): HTTP
   * client, CORS proxy, credentials / onAuth callback, progress handler.
   * Per-call options override these.
   */
  remote?: RemoteOptions;
  dir?: string | null;
  gitdir?: string;
  defaultBranch?: string | null;
  /**
   * Default line diff algorithm for all diff operations.
   * Can be overridden per-call in GitClient.diff().
   * Install @keydown-app/ts-git-diff-myers for a standard implementation:
   *   npm install @keydown-app/ts-git-diff-myers
   */
  lineDiffAlgorithm?: LineDiffAlgorithm;
}

/**
 * Git operations wrapper using any FSAdapter implementation
 */
export class GitClient {
  private fs: FSAdapter;
  private dir: string | null;
  private gitdir: string | undefined;
  private defaultBranch: string;
  private lineDiffAlgorithm?: LineDiffAlgorithm;
  private remoteOptions: RemoteOptions;

  constructor(options: GitClientOptions) {
    this.remoteOptions = options.remote ?? {};
    this.fs = options.fs;
    this.dir = options.dir ?? null;
    this.gitdir = options.gitdir ?? undefined;
    this.defaultBranch = options.defaultBranch ?? 'master';
    this.lineDiffAlgorithm = options.lineDiffAlgorithm;
  }

  async init(options?: Partial<GitClientOptions>): Promise<void> {
    Object.assign(this, options);

    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    await init({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      defaultBranch: this.defaultBranch,
    });
  }

  // async open(dir: string, gitdir?: string): Promise<void> {
  //   if (!(await this.fs.exists(dir))) {
  //     throw new Error('Directory does not exist.');
  //   }

  //   this.dir = dir;
  //   this.gitdir = gitdir ?? undefined;
  // }

  // async close(): Promise<void> {
  //   this.dir = null;
  // }

  /** `git add [-f] <pathspec>...` (stages new, modified and deleted files). */
  async add(
    filepath: string | string[],
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    await add({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      filepath,
      force: options.force,
    });
  }

  /** `git add -A`: stage all changes, including deletions. */
  async addAll(): Promise<void> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    await addAll({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
    });
  }

  /** `git rm --cached [-r] [-f] <pathspec>...` (index only). */
  async remove(
    filepath: string | string[],
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<void> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    await remove({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      filepath,
      recursive: options.recursive,
      force: options.force,
    });
  }

  async commit(
    message: string,
    author: Author,
    options: {
      committer?: Author;
      allowEmpty?: boolean;
      allowEmptyMessage?: boolean;
      cleanup?: 'whitespace' | 'strip' | 'verbatim';
    } = {},
  ): Promise<string> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    return await commit({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      message,
      author,
      ...options,
    });
  }

  async status(filepath: string): Promise<string> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    return await status({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      filepath,
    });
  }

  async statusMatrix(): Promise<StatusRow[]> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    return await statusMatrix({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
    });
  }

  async log(depth?: number): Promise<LogEntry[]> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    return await log({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      depth,
    });
  }

  /**
   * Create a branch at HEAD (or `options.object`), optionally switching to it
   * (`git checkout -b`).
   */
  async branch(
    ref: string,
    checkout: boolean = false,
    options: { object?: string; force?: boolean } = {},
  ): Promise<void> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    await branch({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      ref,
      checkout,
      object: options.object,
      force: options.force,
    });
  }

  async listBranches(): Promise<{
    branches: string[];
    current: string | null;
  }> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    return await listBranchesCommand({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
    });
  }

  async deleteBranch(ref: string, force: boolean = false): Promise<void> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    await deleteBranch({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      ref,
      force,
    });
  }

  /**
   * Switch to a branch (`git switch` / `git checkout <branch>`): updates the
   * index and working tree, refusing to overwrite local changes unless
   * `force` is set.
   */
  async checkoutBranch(
    ref: string,
    options: { force?: boolean; detach?: boolean } = {},
  ): Promise<CheckoutTreeResult> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    return await checkoutBranch({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      ref,
      force: options.force,
      detach: options.detach,
    });
  }

  /**
   * `git reset [--soft|--mixed|--hard] [<ref>] [-- <paths>]`. Returns the
   * paths whose index entries changed.
   */
  async reset(
    filepath?: string | string[],
    options: { ref?: string; mode?: ResetMode } = {},
  ): Promise<string[]> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    const result = await reset({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      filepath,
      ref: options.ref,
      mode: options.mode,
    });

    return result.unstaged;
  }

  /** True when a workspace directory is bound (folder open). False before the host sets `dir`. */
  isWorkspaceReady(): boolean {
    return this.dir != null;
  }

  /**
   * Repository root and optional `.git` path (for CLI / callers that need explicit paths).
   */
  requireRepository(): { dir: string; gitdir?: string } {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }
    return { dir: this.dir, gitdir: this.gitdir };
  }

  /**
   * Generate a diff comparing two sides (worktree, index, commits, or trees).
   * Returns structured deltas; format with `formatDiff` from `@keydown-app/ts-git` in the CLI layer.
   *
   * @param options - Diff options including the required lineDiffAlgorithm
   * @throws Error if lineDiffAlgorithm is not provided
   */
  async diff(
    options: {
      left?: DiffSide;
      right?: DiffSide;
      cached?: boolean;
      paths?: string[];
      contextLines?: number;
      lineDiffAlgorithm?: LineDiffAlgorithm;
    } = {},
  ): Promise<DiffResult> {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }

    // Use provided algorithm, or fall back to the one set in constructor
    const algorithm = options?.lineDiffAlgorithm ?? this.lineDiffAlgorithm;

    if (!algorithm) {
      throw new Error(
        'No diff algorithm provided. ' +
          'Please either:\n' +
          '1. Set it when creating GitClient:\n' +
          '   new GitClient({ ..., lineDiffAlgorithm: myersLineDiff })\n' +
          '2. Or pass it per-call:\n' +
          '   git.diff({ ..., lineDiffAlgorithm: myersLineDiff })\n\n' +
          'Install the Myers algorithm:\n' +
          '   npm install @keydown-app/ts-git-diff-myers',
      );
    }

    return await diff({
      fs: this.fs,
      dir: this.dir,
      gitdir: this.gitdir,
      left: options?.left,
      right: options?.right,
      cached: options?.cached,
      paths: options?.paths,
      contextLines: options?.contextLines,
      lineDiffAlgorithm: algorithm,
    });
  }

  /**
   * Check if the current directory is a git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      if (!this.dir) {
        throw new Error('Directory not set.');
      }

      const { gitdir } = parseGitDir(this.dir, this.gitdir);

      return await this.fs.exists(gitdir);
    } catch {
      return false;
    }
  }

  private repo(): { fs: FSAdapter; dir: string; gitdir?: string } {
    if (!this.dir) {
      throw new Error('Directory not set.');
    }
    return { fs: this.fs, dir: this.dir, gitdir: this.gitdir };
  }

  // --- Remotes -----------------------------------------------------------

  /** Remote defaults given to the constructor (HTTP client, auth, CORS proxy…). */
  getRemoteOptions(): RemoteOptions {
    return { ...this.remoteOptions };
  }

  /** `git remote add <name> <url>` */
  async addRemote(
    name: string,
    url: string,
    fetchRefspecs?: string[],
  ): Promise<RemoteInfo> {
    return addRemote({ ...this.repo(), name, url, fetch: fetchRefspecs });
  }

  /** `git remote remove <name>` */
  async removeRemote(name: string): Promise<void> {
    await removeRemote({ ...this.repo(), name });
  }

  /** `git remote -v` */
  async listRemotes(): Promise<RemoteInfo[]> {
    return listRemotes(this.repo());
  }

  /** `git remote set-url [--push] <name> <url>` */
  async setRemoteUrl(name: string, url: string, push = false): Promise<void> {
    await setRemoteUrl({ ...this.repo(), name, url, push });
  }

  /** `git branch --set-upstream-to=<remote>/<merge> <branch>` */
  async setUpstream(
    branch: string,
    remote: string,
    merge: string,
  ): Promise<void> {
    await setUpstream({ ...this.repo(), branch, remote, merge });
  }

  /** Clone `url` into this client's directory (`git clone <url> <dir>`). */
  async clone(
    url: string,
    options: Omit<CloneArgs, RepoKeys | 'url'> = {},
  ): Promise<CloneResult> {
    return clone({ ...this.remoteOptions, ...options, ...this.repo(), url });
  }

  /** `git fetch [<remote>] [<refspec>...]` */
  async fetch(options: Omit<FetchArgs, RepoKeys> = {}): Promise<FetchResult> {
    return fetch({ ...this.remoteOptions, ...options, ...this.repo() });
  }

  /** `git push [<remote>] [<refspec>...]` */
  async push(options: Omit<PushArgs, RepoKeys> = {}): Promise<PushResult> {
    return push({ ...this.remoteOptions, ...options, ...this.repo() });
  }

  /** `git pull [<remote>] [<branch>]` (merge mode) */
  async pull(options: Omit<PullArgs, RepoKeys> = {}): Promise<PullResult> {
    return pull({ ...this.remoteOptions, ...options, ...this.repo() });
  }

  /** `git merge <commit>` */
  async merge(
    theirs: string,
    options: Omit<MergeArgs, RepoKeys | 'theirs'> = {},
  ): Promise<MergeResult> {
    return merge({ ...options, ...this.repo(), theirs });
  }

  /** `git merge --abort` */
  async abortMerge(): Promise<void> {
    await abortMerge(this.repo());
  }
}
