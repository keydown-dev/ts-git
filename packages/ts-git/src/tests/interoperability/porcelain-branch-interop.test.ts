import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { init } from '../../commands/init.js';
import { add } from '../../commands/add.js';
import { commit } from '../../commands/commit.js';
import {
  branch,
  listBranchesCommand,
  deleteBranch,
  checkoutBranch,
} from '../../commands/branch.js';
import { checkoutTree } from '../../commands/checkout-helpers.js';
import {
  isValidRefName,
  isValidBranchName,
  getCurrentBranch,
  deleteRef,
  readRef,
} from '../../core/refs.js';
import {
  AlreadyExistsError,
  CheckoutConflictError,
  InvalidRefError,
} from '../../errors.js';
import {
  AUTHOR,
  assertGitAvailable,
  cleanupTempDirs,
  emptyRepoDir,
  git,
  gitInitRepo,
  gitOk,
  pathExists,
  snapshotWorktree,
  writeFiles,
  type FileSpec,
  type Repo,
} from './porcelain-helpers.js';

beforeAll(assertGitAvailable);
afterEach(cleanupTempDirs);

let tick = 0;
const nextAuthor = () => ({ ...AUTHOR, timestamp: AUTHOR.timestamp + ++tick });

/** Commit `files` (written on top of the worktree) with ts-git. */
async function tsCommit(
  repo: Repo,
  files: Record<string, FileSpec>,
  msg: string,
) {
  await writeFiles(repo.dir, files);
  await add({ fs: repo.fs, dir: repo.dir, filepath: '.' });
  return commit({
    fs: repo.fs,
    dir: repo.dir,
    message: msg,
    author: nextAuthor(),
  });
}

async function tsRepo(): Promise<Repo> {
  const repo = await emptyRepoDir();
  await init({ fs: repo.fs, dir: repo.dir });
  return repo;
}

describe('ref name validation matches git check-ref-format', () => {
  const names = [
    'main',
    'feature/foo',
    'feature/foo/bar',
    'a.b',
    'v1.0',
    'with-dash',
    '-leading-dash',
    'HEAD',
    '@',
    'a@b',
    'a@{b',
    'trailing.',
    'trailing/',
    '/leading',
    'double//slash',
    'dot/.hidden',
    '.hidden',
    'a..b',
    'x.lock',
    'dir.lock/x',
    'x.lockx',
    'sp ace',
    'tab\there',
    'tilde~',
    'caret^',
    'col:on',
    'ques?',
    'star*',
    'brack[et',
    'back\\slash',
    'ctrl\u0001',
    'del\u007f',
    'ünïcödé',
    'emoji🎉',
    'a/b.',
    'a./b',
    'refs/heads/x',
  ];

  for (const name of names) {
    it(`agrees on ${JSON.stringify(name)}`, async () => {
      const cwd = await emptyRepoDir();
      const full = await git(cwd.dir, [
        'check-ref-format',
        `refs/heads/${name}`,
      ]);
      expect(isValidRefName(`refs/heads/${name}`)).toBe(full.code === 0);
      const br = await git(cwd.dir, ['check-ref-format', '--branch', name]);
      // `--branch` also expands @{-N}; plain names behave like refs/heads/<name>.
      expect(isValidBranchName(name)).toBe(br.code === 0 && name !== 'HEAD');
    });
  }
});

describe('branch: create / list / delete vs git', () => {
  it('creates branches git can see, from HEAD and from a revision', async () => {
    const repo = await tsRepo();
    const c1 = await tsCommit(repo, { 'a.txt': '1\n' }, 'one');
    const c2 = await tsCommit(repo, { 'a.txt': '2\n' }, 'two');

    await branch({ fs: repo.fs, dir: repo.dir, ref: 'feature/nested' });
    await branch({ fs: repo.fs, dir: repo.dir, ref: 'old', object: 'HEAD~1' });
    await branch({
      fs: repo.fs,
      dir: repo.dir,
      ref: 'abbrev',
      object: c1.slice(0, 7),
    });
    await branch({
      fs: repo.fs,
      dir: repo.dir,
      ref: 'from-branch',
      object: 'old',
    });

    expect(await gitOk(repo.dir, ['rev-parse', 'feature/nested'])).toBe(c2);
    expect(await gitOk(repo.dir, ['rev-parse', 'old'])).toBe(c1);
    expect(await gitOk(repo.dir, ['rev-parse', 'abbrev'])).toBe(c1);
    expect(await gitOk(repo.dir, ['rev-parse', 'from-branch'])).toBe(c1);
    expect(
      await gitOk(repo.dir, [
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
      ]),
    ).toBe(
      [
        'refs/heads/abbrev',
        'refs/heads/feature/nested',
        'refs/heads/from-branch',
        'refs/heads/master',
        'refs/heads/old',
      ].join('\n'),
    );
    await gitOk(repo.dir, ['fsck', '--strict', '--no-dangling']);
  });

  it('refuses existing names unless forced, and invalid names', async () => {
    const repo = await tsRepo();
    const c1 = await tsCommit(repo, { 'a.txt': '1\n' }, 'one');
    await branch({ fs: repo.fs, dir: repo.dir, ref: 'dup' });
    const c2 = await tsCommit(repo, { 'a.txt': '2\n' }, 'two');

    await expect(
      branch({ fs: repo.fs, dir: repo.dir, ref: 'dup' }),
    ).rejects.toThrow(AlreadyExistsError);
    expect((await git(repo.dir, ['branch', 'dup'])).code).not.toBe(0);

    await branch({ fs: repo.fs, dir: repo.dir, ref: 'dup', force: true });
    expect(await gitOk(repo.dir, ['rev-parse', 'dup'])).toBe(c2);
    expect(c1).not.toBe(c2);

    for (const bad of ['bad name', 'x..y', '-x', 'HEAD', 'a.lock', 'q?']) {
      await expect(
        branch({ fs: repo.fs, dir: repo.dir, ref: bad }),
      ).rejects.toThrow(InvalidRefError);
      expect((await git(repo.dir, ['branch', bad])).code).not.toBe(0);
    }
  });

  it('refuses to force-update the checked-out branch', async () => {
    const repo = await tsRepo();
    const c1 = await tsCommit(repo, { 'a.txt': '1\n' }, 'one');
    await tsCommit(repo, { 'a.txt': '2\n' }, 'two');
    await expect(
      branch({
        fs: repo.fs,
        dir: repo.dir,
        ref: 'master',
        object: c1,
        force: true,
      }),
    ).rejects.toThrow(InvalidRefError);
    expect((await git(repo.dir, ['branch', '-f', 'master', c1])).code).not.toBe(
      0,
    );
  });

  it('refuses directory/file ref conflicts like git', async () => {
    const repo = await tsRepo();
    await tsCommit(repo, { 'a.txt': '1\n' }, 'one');
    await branch({ fs: repo.fs, dir: repo.dir, ref: 'foo' });
    await expect(
      branch({ fs: repo.fs, dir: repo.dir, ref: 'foo/bar' }),
    ).rejects.toThrow(InvalidRefError);
    expect((await git(repo.dir, ['branch', 'foo/bar'])).code).not.toBe(0);
  });

  it('errors on an unborn HEAD like git', async () => {
    const repo = await tsRepo();
    await expect(
      branch({ fs: repo.fs, dir: repo.dir, ref: 'x' }),
    ).rejects.toThrow(/not a valid object name: 'master'/);
    const r = await git(repo.dir, ['branch', 'x']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("not a valid object name: 'master'");
  });

  it('lists loose and packed branches, and the full current branch name', async () => {
    const repo = await gitInitRepo();
    await writeFiles(repo.dir, { 'a.txt': 'a\n' });
    await gitOk(repo.dir, ['add', '.']);
    await gitOk(repo.dir, ['commit', '-q', '-m', 'one']);
    await gitOk(repo.dir, ['branch', 'packed/one']);
    await gitOk(repo.dir, ['branch', 'zeta']);
    await gitOk(repo.dir, ['pack-refs', '--all']);
    await gitOk(repo.dir, ['branch', 'loose/two']);
    await gitOk(repo.dir, ['checkout', '-q', '-b', 'feature/deep/name']);

    const result = await listBranchesCommand({ fs: repo.fs, dir: repo.dir });
    const gitList = (
      await gitOk(repo.dir, ['branch', '--format=%(refname:short)'])
    ).split('\n');
    expect(result.branches).toEqual(gitList);
    expect(result.current).toBe('feature/deep/name');
    expect(await getCurrentBranch(repo.fs, repo.gitdir)).toBe(
      await gitOk(repo.dir, ['branch', '--show-current']),
    );
  });

  it('deletes branches that exist only in packed-refs', async () => {
    const repo = await gitInitRepo();
    await writeFiles(repo.dir, { 'a.txt': 'a\n' });
    await gitOk(repo.dir, ['add', '.']);
    await gitOk(repo.dir, ['commit', '-q', '-m', 'one']);
    await gitOk(repo.dir, ['tag', '-a', '-m', 'annotated', 'v1']);
    await gitOk(repo.dir, ['branch', 'packed']);
    await gitOk(repo.dir, ['branch', 'other']);
    await gitOk(repo.dir, ['pack-refs', '--all']);
    expect(await pathExists(repo.dir, '.git/refs/heads/packed')).toBe(false);

    await deleteBranch({ fs: repo.fs, dir: repo.dir, ref: 'packed' });

    expect(
      (await git(repo.dir, ['rev-parse', '--verify', '-q', 'packed'])).code,
    ).not.toBe(0);
    // Other packed refs (and the tag's peeled line) survive intact.
    expect(await gitOk(repo.dir, ['rev-parse', 'other'])).toBe(
      await gitOk(repo.dir, ['rev-parse', 'master']),
    );
    expect(await gitOk(repo.dir, ['rev-parse', 'v1^{commit}'])).toBe(
      await gitOk(repo.dir, ['rev-parse', 'master']),
    );
    await gitOk(repo.dir, ['fsck', '--strict', '--no-dangling']);
  });

  it('deletes a ref that is both loose and packed', async () => {
    const repo = await gitInitRepo();
    await writeFiles(repo.dir, { 'a.txt': 'a\n' });
    await gitOk(repo.dir, ['add', '.']);
    await gitOk(repo.dir, ['commit', '-q', '-m', 'one']);
    await gitOk(repo.dir, ['branch', 'both']);
    await gitOk(repo.dir, ['pack-refs', '--all']);
    await writeFiles(repo.dir, { 'a.txt': 'b\n' });
    await gitOk(repo.dir, ['commit', '-q', '-am', 'two']);
    await gitOk(repo.dir, ['branch', '-f', 'both']); // loose copy now

    await deleteRef(repo.fs, repo.gitdir, 'refs/heads/both');
    expect(await readRef(repo.fs, repo.gitdir, 'refs/heads/both')).toBeNull();
    expect(
      (await git(repo.dir, ['rev-parse', '--verify', '-q', 'both'])).code,
    ).not.toBe(0);
  });

  it('applies git branch -d merged rules (HEAD, upstream, unborn)', async () => {
    const repo = await tsRepo();
    await tsCommit(repo, { 'a.txt': '1\n' }, 'one');
    await branch({ fs: repo.fs, dir: repo.dir, ref: 'topic', checkout: true });
    const topic = await tsCommit(repo, { 'b.txt': 'b\n' }, 'topic work');
    await checkoutBranch({ fs: repo.fs, dir: repo.dir, ref: 'master' });

    // Not merged into HEAD: both refuse.
    await expect(
      deleteBranch({ fs: repo.fs, dir: repo.dir, ref: 'topic' }),
    ).rejects.toThrow(/not fully merged/);
    expect((await git(repo.dir, ['branch', '-d', 'topic'])).code).not.toBe(0);

    // Merged into its upstream (a local upstream via remote "."): allowed,
    // even though it is not merged into HEAD.
    await branch({
      fs: repo.fs,
      dir: repo.dir,
      ref: 'upstream',
      object: topic,
    });
    await gitOk(repo.dir, ['config', 'branch.topic.remote', '.']);
    await gitOk(repo.dir, [
      'config',
      'branch.topic.merge',
      'refs/heads/upstream',
    ]);
    await deleteBranch({ fs: repo.fs, dir: repo.dir, ref: 'topic' });
    expect(
      (await git(repo.dir, ['rev-parse', '--verify', '-q', 'topic'])).code,
    ).not.toBe(0);
    expect(
      (await git(repo.dir, ['config', '--get-regexp', '^branch\\.topic\\.']))
        .code,
    ).not.toBe(0);

    // Cannot delete the current branch.
    await expect(
      deleteBranch({ fs: repo.fs, dir: repo.dir, ref: 'master' }),
    ).rejects.toThrow(InvalidRefError);

    // Force deletes unmerged branches.
    await deleteBranch({
      fs: repo.fs,
      dir: repo.dir,
      ref: 'upstream',
      force: true,
    });
    expect(
      (await git(repo.dir, ['rev-parse', '--verify', '-q', 'upstream'])).code,
    ).not.toBe(0);
  });
});

/** Run the same scenario through git and ts-git and compare the results. */
async function twinRepos(
  setup: (r: Repo, run: 'git' | 'ts') => Promise<void>,
): Promise<{ ts: Repo; ref: Repo }> {
  const ts = await gitInitRepo();
  const ref = await gitInitRepo();
  await setup(ts, 'ts');
  await setup(ref, 'git');
  return { ts, ref };
}

async function gitSetupBranches(r: Repo) {
  // master: a.txt, dir/b.txt, run.sh(+x), link -> a.txt, old.txt
  await writeFiles(r.dir, {
    'a.txt': 'a1\n',
    'dir/b.txt': 'b1\n',
    'run.sh': { content: 'echo 1\n', mode: 0o755 },
    link: { symlink: 'a.txt' },
    'old.txt': 'old\n',
    'shared.txt': 'shared\n',
  });
  await gitOk(r.dir, ['add', '.']);
  await gitOk(r.dir, ['commit', '-q', '-m', 'base'], { author: AUTHOR });
  // other: modifies a.txt, removes old.txt, adds new/deep/c.txt, run.sh -x,
  // link -> dir/b.txt, dir/b.txt unchanged
  await gitOk(r.dir, ['checkout', '-q', '-b', 'other']);
  await writeFiles(r.dir, {
    'a.txt': 'a2\n',
    'new/deep/c.txt': 'c\n',
    'run.sh': { content: 'echo 1\n', mode: 0o644 },
    link: { symlink: 'dir/b.txt' },
  });
  await fsp.rm(path.join(r.dir, 'old.txt'));
  await gitOk(r.dir, ['add', '-A']);
  await gitOk(r.dir, ['commit', '-q', '-m', 'other'], { author: AUTHOR });
  await gitOk(r.dir, ['checkout', '-q', 'master']);
}

describe('checkoutBranch: updates index and worktree like git switch', () => {
  async function compare(ts: Repo, ref: Repo) {
    expect(await snapshotWorktree(ts.dir)).toEqual(
      await snapshotWorktree(ref.dir),
    );
    expect(await gitOk(ts.dir, ['ls-files', '-s'])).toBe(
      await gitOk(ref.dir, ['ls-files', '-s']),
    );
    expect(await gitOk(ts.dir, ['status', '--porcelain'])).toBe(
      await gitOk(ref.dir, ['status', '--porcelain']),
    );
    expect(
      await gitOk(ts.dir, ['symbolic-ref', '-q', 'HEAD']).catch(
        () => 'detached',
      ),
    ).toBe(
      await gitOk(ref.dir, ['symbolic-ref', '-q', 'HEAD']).catch(
        () => 'detached',
      ),
    );
  }

  it('switches back and forth, writing/removing files and modes', async () => {
    const { ts, ref } = await twinRepos(async (r) => gitSetupBranches(r));

    await checkoutBranch({ fs: ts.fs, dir: ts.dir, ref: 'other' });
    await gitOk(ref.dir, ['checkout', '-q', 'other']);
    await compare(ts, ref);
    // Stat data in the index is fresh: git sees nothing to refresh.
    expect(await gitOk(ts.dir, ['diff-files', '--name-only'])).toBe('');

    await checkoutBranch({ fs: ts.fs, dir: ts.dir, ref: 'master' });
    await gitOk(ref.dir, ['checkout', '-q', 'master']);
    await compare(ts, ref);
    expect(await pathExists(ts.dir, 'new')).toBe(false); // empty dirs pruned
  });

  it('keeps unrelated local modifications and staged changes', async () => {
    const { ts, ref } = await twinRepos(async (r) => {
      await gitSetupBranches(r);
      await writeFiles(r.dir, {
        'shared.txt': 'local edit\n',
        'dir/b.txt': 'staged edit\n',
        'untracked.txt': 'u\n',
      });
      await gitOk(r.dir, ['add', 'dir/b.txt']);
    });

    await checkoutBranch({ fs: ts.fs, dir: ts.dir, ref: 'other' });
    await gitOk(ref.dir, ['checkout', '-q', 'other']);
    await compare(ts, ref);
  });

  it('refuses when local changes would be overwritten (and changes nothing)', async () => {
    const { ts, ref } = await twinRepos(async (r) => {
      await gitSetupBranches(r);
      await writeFiles(r.dir, { 'a.txt': 'conflicting local edit\n' });
    });
    const before = await snapshotWorktree(ts.dir);

    const err = await checkoutBranch({
      fs: ts.fs,
      dir: ts.dir,
      ref: 'other',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutConflictError);
    expect(err.paths).toEqual(['a.txt']);
    const r = await git(ref.dir, ['checkout', 'other']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('a.txt');

    expect(await snapshotWorktree(ts.dir)).toEqual(before);
    await compare(ts, ref);
  });

  it('refuses when a staged change conflicts, and when a deleted-in-target file is modified', async () => {
    const { ts, ref } = await twinRepos(async (r) => {
      await gitSetupBranches(r);
      await writeFiles(r.dir, { 'old.txt': 'edited\n' });
    });
    const err = await checkoutBranch({
      fs: ts.fs,
      dir: ts.dir,
      ref: 'other',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutConflictError);
    expect(err.paths).toEqual(['old.txt']);
    expect((await git(ref.dir, ['checkout', 'other'])).code).not.toBe(0);
    await compare(ts, ref);
  });

  it('refuses to overwrite untracked files, but overwrites ignored ones', async () => {
    const { ts, ref } = await twinRepos(async (r) => {
      await gitSetupBranches(r);
      await writeFiles(r.dir, { 'new/deep/c.txt': 'untracked in the way\n' });
    });
    const err = await checkoutBranch({
      fs: ts.fs,
      dir: ts.dir,
      ref: 'other',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutConflictError);
    expect(err.untracked).toEqual(['new/deep/c.txt']);
    expect((await git(ref.dir, ['checkout', 'other'])).code).not.toBe(0);

    for (const r of [ts, ref]) {
      await fsp.appendFile(path.join(r.gitdir, 'info', 'exclude'), 'new/\n');
    }
    await checkoutBranch({ fs: ts.fs, dir: ts.dir, ref: 'other' });
    await gitOk(ref.dir, ['checkout', '-q', 'other']);
    await compare(ts, ref);
  });

  it('force discards local changes like git checkout -f', async () => {
    const { ts, ref } = await twinRepos(async (r) => {
      await gitSetupBranches(r);
      await writeFiles(r.dir, {
        'a.txt': 'conflicting local edit\n',
        'shared.txt': 'unrelated edit\n',
        'new/deep/c.txt': 'untracked in the way\n',
        'untracked.txt': 'stays\n',
      });
    });
    await checkoutBranch({ fs: ts.fs, dir: ts.dir, ref: 'other', force: true });
    await gitOk(ref.dir, ['checkout', '-q', '-f', 'other']);
    await compare(ts, ref);
  });

  it('handles file <-> directory transitions', async () => {
    const { ts, ref } = await twinRepos(async (r) => {
      await writeFiles(r.dir, { thing: 'file\n', 'keep.txt': 'k\n' });
      await gitOk(r.dir, ['add', '.']);
      await gitOk(r.dir, ['commit', '-q', '-m', 'file'], { author: AUTHOR });
      await gitOk(r.dir, ['checkout', '-q', '-b', 'dir']);
      await fsp.rm(path.join(r.dir, 'thing'));
      await writeFiles(r.dir, { 'thing/inner.txt': 'dir\n' });
      await gitOk(r.dir, ['add', '-A']);
      await gitOk(r.dir, ['commit', '-q', '-m', 'dir'], { author: AUTHOR });
      await gitOk(r.dir, ['checkout', '-q', 'master']);
    });
    await checkoutBranch({ fs: ts.fs, dir: ts.dir, ref: 'dir' });
    await gitOk(ref.dir, ['checkout', '-q', 'dir']);
    await compare(ts, ref);
    await checkoutBranch({ fs: ts.fs, dir: ts.dir, ref: 'master' });
    await gitOk(ref.dir, ['checkout', '-q', 'master']);
    await compare(ts, ref);
  });

  it('branch({checkout: true, object}) behaves like git checkout -b <new> <start>', async () => {
    const { ts, ref } = await twinRepos(async (r) => gitSetupBranches(r));
    await branch({
      fs: ts.fs,
      dir: ts.dir,
      ref: 'from-other',
      object: 'other',
      checkout: true,
    });
    await gitOk(ref.dir, ['checkout', '-q', '-b', 'from-other', 'other']);
    await compare(ts, ref);
  });

  it('detaches HEAD at a revision', async () => {
    const { ts, ref } = await twinRepos(async (r) => gitSetupBranches(r));
    await checkoutBranch({
      fs: ts.fs,
      dir: ts.dir,
      ref: 'other~0',
      detach: true,
    });
    await gitOk(ref.dir, ['checkout', '-q', '--detach', 'other']);
    await compare(ts, ref);
    expect(await gitOk(ts.dir, ['rev-parse', 'HEAD'])).toBe(
      await gitOk(ts.dir, ['rev-parse', 'other']),
    );
  });

  it('checkoutTree supports fast-forwarding to a descendant commit', async () => {
    const repo = await tsRepo();
    await tsCommit(repo, { 'a.txt': '1\n', 'b.txt': 'b\n' }, 'one');
    const one = await gitOk(repo.dir, ['rev-parse', 'HEAD']);
    await tsCommit(repo, { 'a.txt': '2\n', 'c/d.txt': 'd\n' }, 'two');
    const two = await gitOk(repo.dir, ['rev-parse', 'HEAD']);
    // Simulate a branch that is behind: reset master to one with git.
    await gitOk(repo.dir, ['reset', '-q', '--hard', one]);
    await writeFiles(repo.dir, { 'b.txt': 'local change survives\n' });

    const result = await checkoutTree({ fs: repo.fs, dir: repo.dir, to: two });
    await gitOk(repo.dir, ['update-ref', 'refs/heads/master', two]);

    expect(result.updated.sort()).toEqual(['a.txt', 'c/d.txt']);
    expect(await gitOk(repo.dir, ['status', '--porcelain'])).toBe(' M b.txt');
  });
});
