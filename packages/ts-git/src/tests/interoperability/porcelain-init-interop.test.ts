import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { init } from '../../commands/init.js';
import { add } from '../../commands/add.js';
import { commit } from '../../commands/commit.js';
import { InvalidRefError } from '../../errors.js';
import {
  AUTHOR,
  assertGitAvailable,
  cleanupTempDirs,
  emptyRepoDir,
  git,
  gitOk,
  writeFiles,
} from './porcelain-helpers.js';

beforeAll(assertGitAvailable);
afterEach(cleanupTempDirs);

describe('init: repositories canonical git accepts', () => {
  it('creates a repository git can use (status, fsck, commit)', async () => {
    const repo = await emptyRepoDir();
    await init({ fs: repo.fs, dir: repo.dir });

    expect(await gitOk(repo.dir, ['rev-parse', '--git-dir'])).toBe('.git');
    expect(await gitOk(repo.dir, ['rev-parse', '--is-bare-repository'])).toBe(
      'false',
    );
    expect(await gitOk(repo.dir, ['symbolic-ref', 'HEAD'])).toBe(
      'refs/heads/master',
    );
    expect(await gitOk(repo.dir, ['status', '--porcelain'])).toBe('');
    await gitOk(repo.dir, ['fsck', '--strict']);
    expect(
      await gitOk(repo.dir, ['config', 'core.repositoryformatversion']),
    ).toBe('0');
    expect(await gitOk(repo.dir, ['config', 'core.filemode'])).toBe('true');
    for (const p of [
      'objects/info',
      'objects/pack',
      'refs/heads',
      'refs/tags',
      'info/exclude',
      'description',
    ]) {
      await fsp.access(path.join(repo.gitdir, p));
    }

    // git can commit into it, and ts-git can read the result.
    await writeFiles(repo.dir, { 'a.txt': 'a\n' });
    await gitOk(repo.dir, ['add', 'a.txt']);
    await gitOk(repo.dir, ['commit', '-q', '-m', 'from git']);
    await gitOk(repo.dir, ['fsck', '--strict', '--no-dangling']);
  });

  it('honours defaultBranch (including nested names) and rejects invalid ones', async () => {
    const repo = await emptyRepoDir();
    await init({ fs: repo.fs, dir: repo.dir, defaultBranch: 'team/main' });
    expect(await gitOk(repo.dir, ['symbolic-ref', 'HEAD'])).toBe(
      'refs/heads/team/main',
    );
    expect(await gitOk(repo.dir, ['branch', '--show-current'])).toBe(
      'team/main',
    );

    const bad = await emptyRepoDir();
    await expect(
      init({ fs: bad.fs, dir: bad.dir, defaultBranch: 'bad..name' }),
    ).rejects.toThrow(InvalidRefError);
    expect(
      (await git(bad.dir, ['init', '-q', '--initial-branch=bad..name'])).code,
    ).not.toBe(0);
  });

  it('re-initialising keeps HEAD, config, index and history', async () => {
    const repo = await emptyRepoDir();
    await init({ fs: repo.fs, dir: repo.dir, defaultBranch: 'main' });
    await writeFiles(repo.dir, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await add({ fs: repo.fs, dir: repo.dir, filepath: 'a.txt' });
    await commit({
      fs: repo.fs,
      dir: repo.dir,
      message: 'one',
      author: AUTHOR,
    });
    await add({ fs: repo.fs, dir: repo.dir, filepath: 'b.txt' });
    await gitOk(repo.dir, ['config', 'user.custom', 'kept']);
    const statusBefore = await gitOk(repo.dir, ['status', '--porcelain']);

    await init({ fs: repo.fs, dir: repo.dir, defaultBranch: 'other' });

    expect(await gitOk(repo.dir, ['symbolic-ref', 'HEAD'])).toBe(
      'refs/heads/main',
    );
    expect(await gitOk(repo.dir, ['config', 'user.custom'])).toBe('kept');
    expect(await gitOk(repo.dir, ['status', '--porcelain'])).toBe(statusBefore);
    expect(statusBefore).toBe('A  b.txt');
  });

  it('creates bare repositories', async () => {
    const repo = await emptyRepoDir();
    await init({ fs: repo.fs, dir: repo.dir, bare: true });
    expect(await gitOk(repo.dir, ['rev-parse', '--is-bare-repository'])).toBe(
      'true',
    );
    expect(await gitOk(repo.dir, ['config', 'core.bare'])).toBe('true');
    await gitOk(repo.dir, ['fsck', '--strict']);

    // A clone can push into it.
    const work = await emptyRepoDir();
    await gitOk(work.dir, ['init', '-q']);
    await writeFiles(work.dir, { 'f.txt': 'f\n' });
    await gitOk(work.dir, ['add', '.']);
    await gitOk(work.dir, ['commit', '-q', '-m', 'one']);
    await gitOk(work.dir, ['push', '-q', repo.dir, 'master']);
    expect(await gitOk(repo.dir, ['rev-parse', 'master'])).toBe(
      await gitOk(work.dir, ['rev-parse', 'HEAD']),
    );
  });

  it('supports a custom gitdir', async () => {
    const repo = await emptyRepoDir();
    const gitdir = path.join(repo.dir, 'custom.git');
    await init({ fs: repo.fs, dir: repo.dir, gitdir });
    await writeFiles(repo.dir, { 'a.txt': 'a\n' });
    await add({ fs: repo.fs, dir: repo.dir, gitdir, filepath: '.' });
    await commit({
      fs: repo.fs,
      dir: repo.dir,
      gitdir,
      message: 'm',
      author: AUTHOR,
    });
    const env = ['--git-dir', gitdir, '--work-tree', repo.dir];
    expect(await gitOk(repo.dir, [...env, 'ls-files'])).toBe('a.txt');
    await gitOk(repo.dir, [...env, 'fsck', '--strict', '--no-dangling']);
  });
});
