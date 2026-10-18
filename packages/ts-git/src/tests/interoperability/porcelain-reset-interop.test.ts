import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { reset } from '../../commands/reset.js';
import {
  AUTHOR,
  assertGitAvailable,
  cleanupTempDirs,
  git,
  gitInitRepo,
  gitOk,
  snapshotWorktree,
  writeFiles,
  type Repo,
} from './porcelain-helpers.js';

beforeAll(assertGitAvailable);
afterEach(cleanupTempDirs);

/** Two identical git-built repositories: one for ts-git, one for git. */
async function twins(setup: (r: Repo) => Promise<void>) {
  const ts = await gitInitRepo();
  const ref = await gitInitRepo();
  await setup(ts);
  await setup(ref);
  return { ts, ref };
}

async function compare(ts: Repo, ref: Repo) {
  expect(await gitOk(ts.dir, ['ls-files', '-s'])).toBe(
    await gitOk(ref.dir, ['ls-files', '-s']),
  );
  expect(
    await gitOk(ts.dir, ['status', '--porcelain', '--untracked-files=all']),
  ).toBe(
    await gitOk(ref.dir, ['status', '--porcelain', '--untracked-files=all']),
  );
  expect(await snapshotWorktree(ts.dir)).toEqual(
    await snapshotWorktree(ref.dir),
  );
  const head = async (r: Repo) =>
    (await git(r.dir, ['rev-parse', '-q', '--verify', 'HEAD'])).stdout.trim();
  expect(await head(ts)).toBe(await head(ref));
}

/** History: c1 (a, dir/b, dir/sub/c) -> c2 (a changed, d added, dir/sub/c removed). */
async function history(r: Repo) {
  await writeFiles(r.dir, {
    'a.txt': 'a1\n',
    'dir/b.txt': 'b1\n',
    'dir/sub/c.txt': 'c1\n',
  });
  await gitOk(r.dir, ['add', '.']);
  await gitOk(r.dir, ['commit', '-q', '-m', 'c1'], { author: AUTHOR });
  await writeFiles(r.dir, { 'a.txt': 'a2\n', 'd.txt': 'd\n' });
  await fsp.rm(path.join(r.dir, 'dir/sub'), { recursive: true });
  await gitOk(r.dir, ['add', '-A']);
  await gitOk(r.dir, ['commit', '-q', '-m', 'c2'], {
    author: { ...AUTHOR, timestamp: AUTHOR.timestamp + 10 },
  });
}

/** Local state on top of history: staged + unstaged + untracked changes. */
async function dirty(r: Repo) {
  await writeFiles(r.dir, {
    'a.txt': 'a staged\n',
    'dir/b.txt': 'b staged\n',
    'new.txt': 'staged new\n',
    'dir/new2.txt': 'staged new in dir\n',
    'untracked.txt': 'u\n',
  });
  await gitOk(r.dir, ['add', 'a.txt', 'dir/b.txt', 'new.txt', 'dir/new2.txt']);
  await writeFiles(r.dir, { 'd.txt': 'unstaged edit\n' });
  await fsp.rm(path.join(r.dir, 'dir/b.txt'));
}

describe('reset vs git reset', () => {
  it('git reset (mixed, no args)', async () => {
    const { ts, ref } = await twins(async (r) => {
      await history(r);
      await dirty(r);
    });
    const result = await reset({ fs: ts.fs, dir: ts.dir });
    await gitOk(ref.dir, ['reset', '-q']);
    await compare(ts, ref);
    expect(result.unstaged).toEqual([
      'a.txt',
      'dir/b.txt',
      'dir/new2.txt',
      'new.txt',
    ]);
  });

  it('git reset -- <paths> with directory and glob pathspecs', async () => {
    for (const specs of [
      ['dir'],
      ['dir/'],
      ['*.txt'],
      ['.'],
      ['a.txt', 'new.txt'],
    ]) {
      const { ts, ref } = await twins(async (r) => {
        await history(r);
        await dirty(r);
      });
      await reset({ fs: ts.fs, dir: ts.dir, filepath: specs });
      await gitOk(ref.dir, ['reset', '-q', '--', ...specs]);
      await compare(ts, ref);
    }
  });

  it('git reset <commit> -- <path> restores an old version into the index', async () => {
    const { ts, ref } = await twins(history);
    await reset({
      fs: ts.fs,
      dir: ts.dir,
      ref: 'HEAD~1',
      filepath: ['a.txt', 'dir'],
    });
    await gitOk(ref.dir, ['reset', '-q', 'HEAD~1', '--', 'a.txt', 'dir']);
    await compare(ts, ref);
  });

  it('git reset on an unborn branch removes entries', async () => {
    const { ts, ref } = await twins(async (r) => {
      await writeFiles(r.dir, {
        'a.txt': 'a\n',
        'dir/b.txt': 'b\n',
        'c.txt': 'c\n',
      });
      await gitOk(r.dir, ['add', '.']);
    });
    await reset({ fs: ts.fs, dir: ts.dir, filepath: 'dir' });
    await gitOk(ref.dir, ['reset', '-q', '--', 'dir']);
    await compare(ts, ref);

    await reset({ fs: ts.fs, dir: ts.dir });
    await gitOk(ref.dir, ['reset', '-q']);
    await compare(ts, ref);
    expect(await gitOk(ts.dir, ['ls-files'])).toBe('');
  });

  it('git reset --soft HEAD~1', async () => {
    const { ts, ref } = await twins(async (r) => {
      await history(r);
      await dirty(r);
    });
    await reset({ fs: ts.fs, dir: ts.dir, ref: 'HEAD~1', mode: 'soft' });
    await gitOk(ref.dir, ['reset', '-q', '--soft', 'HEAD~1']);
    await compare(ts, ref);
    expect(await gitOk(ts.dir, ['rev-parse', 'ORIG_HEAD'])).toBe(
      await gitOk(ref.dir, ['rev-parse', 'ORIG_HEAD']),
    );
  });

  it('git reset --mixed HEAD~1', async () => {
    const { ts, ref } = await twins(async (r) => {
      await history(r);
      await dirty(r);
    });
    await reset({ fs: ts.fs, dir: ts.dir, ref: 'HEAD~1' });
    await gitOk(ref.dir, ['reset', '-q', 'HEAD~1']);
    await compare(ts, ref);
  });

  it('git reset --hard (HEAD and HEAD~1), keeping untracked files', async () => {
    for (const target of ['HEAD', 'HEAD~1']) {
      const { ts, ref } = await twins(async (r) => {
        await history(r);
        await dirty(r);
      });
      await reset({ fs: ts.fs, dir: ts.dir, ref: target, mode: 'hard' });
      await gitOk(ref.dir, ['reset', '-q', '--hard', target]);
      await compare(ts, ref);
      expect(await gitOk(ts.dir, ['diff-files', '--name-only'])).toBe('');
    }
  });

  it('git reset --hard on a detached HEAD moves HEAD only', async () => {
    const { ts, ref } = await twins(async (r) => {
      await history(r);
      await gitOk(r.dir, ['checkout', '-q', '--detach', 'HEAD']);
    });
    await reset({ fs: ts.fs, dir: ts.dir, ref: 'HEAD~1', mode: 'hard' });
    await gitOk(ref.dir, ['reset', '-q', '--hard', 'HEAD~1']);
    await compare(ts, ref);
    expect(await gitOk(ts.dir, ['rev-parse', 'master'])).toBe(
      await gitOk(ref.dir, ['rev-parse', 'master']),
    );
    expect((await git(ts.dir, ['symbolic-ref', '-q', 'HEAD'])).code).not.toBe(
      0,
    );
  });

  it('refuses hard/soft resets with paths, like git', async () => {
    const { ts, ref } = await twins(history);
    await expect(
      reset({ fs: ts.fs, dir: ts.dir, filepath: 'a.txt', mode: 'hard' }),
    ).rejects.toThrow(/hard reset with paths/);
    expect(
      (await git(ref.dir, ['reset', '--hard', '--', 'a.txt'])).code,
    ).not.toBe(0);
  });
});
