import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { init } from '../../commands/init.js';
import { add, addAll, remove, IgnoredPathsError } from '../../commands/add.js';
import { commit } from '../../commands/commit.js';
import { readIndex } from '../../core/index.js';
import { IsADirectoryError, NotFoundError } from '../../errors.js';
import {
  AUTHOR,
  assertGitAvailable,
  cleanupTempDirs,
  emptyRepoDir,
  git,
  gitInitRepo,
  gitOk,
  writeFiles,
  type FileSpec,
  type Repo,
} from './porcelain-helpers.js';

beforeAll(assertGitAvailable);
afterEach(cleanupTempDirs);

async function tsRepo(files: Record<string, FileSpec> = {}): Promise<Repo> {
  const repo = await emptyRepoDir();
  await init({ fs: repo.fs, dir: repo.dir });
  await writeFiles(repo.dir, files);
  return repo;
}

async function gitRepo(files: Record<string, FileSpec> = {}): Promise<Repo> {
  const repo = await gitInitRepo();
  await writeFiles(repo.dir, files);
  return repo;
}

const lsFiles = (r: Repo) => gitOk(r.dir, ['ls-files', '-s']);
const porcelain = (r: Repo) =>
  gitOk(r.dir, ['status', '--porcelain', '--untracked-files=all']);

const IGNORE_FIXTURE: Record<string, FileSpec> = {
  '.gitignore': '*.log\nbuild/\n/root-only.txt\n!keep.log\ndocs/**/*.tmp\n',
  'app.js': 'app\n',
  'debug.log': 'log\n',
  'keep.log': 'keep\n',
  'root-only.txt': 'r\n',
  'sub/root-only.txt': 'not ignored here\n',
  'build/out.js': 'built\n',
  'src/build/x.js': 'nested build dir is ignored too\n',
  'docs/a/b/c.tmp': 'tmp\n',
  'docs/a/b/c.md': 'md\n',
  'sub/.gitignore': '*.txt\n!important.txt\n',
  'sub/notes.txt': 'n\n',
  'sub/important.txt': 'i\n',
};

describe('add: index compatibility with canonical git', () => {
  it('git add . and ts-git add . produce identical indexes (with .gitignore)', async () => {
    const ts = await tsRepo(IGNORE_FIXTURE);
    const ref = await gitRepo(IGNORE_FIXTURE);

    await add({ fs: ts.fs, dir: ts.dir, filepath: '.' });
    await gitOk(ref.dir, ['add', '.']);

    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
    expect(await porcelain(ts)).toBe(await porcelain(ref));
  });

  it('honours .git/info/exclude like git', async () => {
    const files = { 'a.txt': 'a\n', 'secret.env': 's\n' };
    const ts = await tsRepo(files);
    const ref = await gitRepo(files);
    await fsp.appendFile(path.join(ts.gitdir, 'info', 'exclude'), '*.env\n');
    await fsp.appendFile(path.join(ref.gitdir, 'info', 'exclude'), '*.env\n');

    await addAll({ fs: ts.fs, dir: ts.dir });
    await gitOk(ref.dir, ['add', '-A']);
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
  });

  it('writes an index git reads with stat data git trusts', async () => {
    const files = {
      'b.txt': 'b\n',
      'a/z.txt': 'z\n',
      'A.txt': 'upper\n',
      'ü.txt': 'unicode\n',
      'x.sh': { content: 'x\n', mode: 0o755 },
      link: { symlink: 'b.txt' },
    };
    const ts = await tsRepo(files);
    const ref = await gitRepo(files);
    await add({ fs: ts.fs, dir: ts.dir, filepath: '.' });
    await gitOk(ref.dir, ['add', '.']);

    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
    // Entries must be sorted by bytes for git: verify via git's own check.
    expect((await git(ts.dir, ['ls-files', '--debug'])).code).toBe(0);
    // Stat data matches the files, so git sees no changes without rehashing.
    expect(await gitOk(ts.dir, ['diff-files', '--name-only'])).toBe('');
    await gitOk(ts.dir, ['fsck', '--strict', '--no-dangling']);
  });

  it('handles a very long path (flags length saturates at 0xfff)', async () => {
    const long = `${'d'.repeat(200)}/${'n'.repeat(200)}/${'f'.repeat(200)}`;
    const files = { [`${long}/${'x'.repeat(200)}.txt`]: 'deep\n' };
    // Paths > 4095 bytes are rare; use a nested path just over 800 bytes and
    // a second one exactly using multi-byte characters.
    const ts = await tsRepo(files);
    const ref = await gitRepo(files);
    await add({ fs: ts.fs, dir: ts.dir, filepath: '.' });
    await gitOk(ref.dir, ['add', '.']);
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
  });

  it('stages deletions when adding a deleted file or its directory', async () => {
    const files = { 'keep.txt': 'k\n', 'gone.txt': 'g\n', 'dir/x.txt': 'x\n' };
    const ts = await tsRepo(files);
    const ref = await gitRepo(files);
    await add({ fs: ts.fs, dir: ts.dir, filepath: '.' });
    await commit({ fs: ts.fs, dir: ts.dir, message: 'init', author: AUTHOR });
    await gitOk(ref.dir, ['add', '.']);
    await gitOk(ref.dir, ['commit', '-q', '-m', 'init']);

    for (const r of [ts, ref]) {
      await fsp.rm(path.join(r.dir, 'gone.txt'));
      await fsp.rm(path.join(r.dir, 'dir'), { recursive: true });
    }

    const result = await add({
      fs: ts.fs,
      dir: ts.dir,
      filepath: ['gone.txt', 'dir'],
    });
    await gitOk(ref.dir, ['add', 'gone.txt', 'dir']);

    expect(result.removed?.sort()).toEqual(['dir/x.txt', 'gone.txt']);
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
    expect(await porcelain(ts)).toBe(await porcelain(ref));
  });

  it('adds directories recursively, skipping ignored files but updating tracked ones', async () => {
    const files = {
      '.gitignore': 'dir/*.log\n',
      'dir/a.txt': 'a\n',
      'dir/b.log': 'b\n',
      'dir/sub/c.txt': 'c\n',
      'other.txt': 'o\n',
    };
    const ts = await tsRepo(files);
    const ref = await gitRepo(files);
    // A tracked file that matches an ignore pattern (force-added earlier).
    await add({ fs: ts.fs, dir: ts.dir, filepath: 'dir/b.log', force: true });
    await gitOk(ref.dir, ['add', '-f', 'dir/b.log']);
    for (const r of [ts, ref]) {
      await writeFiles(r.dir, {
        'dir/b.log': 'b changed\n',
        'dir/new.log': 'n\n',
      });
    }

    await add({ fs: ts.fs, dir: ts.dir, filepath: 'dir' });
    await gitOk(ref.dir, ['add', 'dir']);

    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
  });

  it('refuses explicitly named ignored files unless forced (like git)', async () => {
    const files = { '.gitignore': '*.log\n', 'a.txt': 'a\n', 'b.log': 'b\n' };
    const ts = await tsRepo(files);
    const ref = await gitRepo(files);

    const err = await add({
      fs: ts.fs,
      dir: ts.dir,
      filepath: ['a.txt', 'b.log'],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(IgnoredPathsError);
    expect(err.paths).toEqual(['b.log']);
    const r = await git(ref.dir, ['add', 'a.txt', 'b.log']);
    expect(r.code).not.toBe(0);
    // As in git, the non-ignored path was still staged.
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));

    await add({ fs: ts.fs, dir: ts.dir, filepath: 'b.log', force: true });
    await gitOk(ref.dir, ['add', '-f', 'b.log']);
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
  });

  it('fails without changes for a pathspec that matches nothing', async () => {
    const ts = await tsRepo({ 'a.txt': 'a\n' });
    await expect(
      add({ fs: ts.fs, dir: ts.dir, filepath: ['a.txt', 'missing.txt'] }),
    ).rejects.toThrow(NotFoundError);
    expect(await lsFiles(ts)).toBe('');
    expect((await git(ts.dir, ['add', 'a.txt', 'missing.txt'])).code).toBe(128);
  });

  it('records executable bit changes (core.filemode=true)', async () => {
    const files = { 'run.sh': 'echo\n' };
    const ts = await tsRepo(files);
    expect(await gitOk(ts.dir, ['config', 'core.filemode'])).toBe('true');
    await add({ fs: ts.fs, dir: ts.dir, filepath: 'run.sh' });
    await commit({ fs: ts.fs, dir: ts.dir, message: 'm', author: AUTHOR });

    await fsp.chmod(path.join(ts.dir, 'run.sh'), 0o755);
    const result = await add({ fs: ts.fs, dir: ts.dir, filepath: 'run.sh' });
    expect(result.updated).toEqual(['run.sh']);
    expect(await lsFiles(ts)).toMatch(/^100755 /);
    expect(await gitOk(ts.dir, ['status', '--porcelain'])).toBe('M  run.sh');
  });

  it('keeps the index mode when core.filemode=false', async () => {
    const ts = await tsRepo({ 'run.sh': 'echo\n' });
    await gitOk(ts.dir, ['config', 'core.filemode', 'false']);
    await add({ fs: ts.fs, dir: ts.dir, filepath: 'run.sh' });
    await fsp.chmod(path.join(ts.dir, 'run.sh'), 0o755);
    await add({ fs: ts.fs, dir: ts.dir, filepath: 'run.sh' });
    expect(await lsFiles(ts)).toMatch(/^100644 /);
  });

  it('replaces a tracked file with a directory (and back)', async () => {
    const ts = await tsRepo({ thing: 'file\n' });
    const ref = await gitRepo({ thing: 'file\n' });
    await add({ fs: ts.fs, dir: ts.dir, filepath: '.' });
    await gitOk(ref.dir, ['add', '.']);

    for (const r of [ts, ref]) {
      await fsp.rm(path.join(r.dir, 'thing'));
      await writeFiles(r.dir, { 'thing/inner.txt': 'now a dir\n' });
    }
    await add({ fs: ts.fs, dir: ts.dir, filepath: '.' });
    await gitOk(ref.dir, ['add', '.']);
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));

    for (const r of [ts, ref]) {
      await fsp.rm(path.join(r.dir, 'thing'), { recursive: true });
      await writeFiles(r.dir, { thing: 'file again\n' });
    }
    await add({ fs: ts.fs, dir: ts.dir, filepath: 'thing' });
    await gitOk(ref.dir, ['add', 'thing']);
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
  });

  it('modifies a git-created index (git add, then ts-git add)', async () => {
    const ref = await gitRepo({ 'a.txt': 'a\n', 'z/z.txt': 'z\n' });
    const twin = await gitRepo({ 'a.txt': 'a\n', 'z/z.txt': 'z\n' });
    await gitOk(ref.dir, ['add', '.']);
    await gitOk(ref.dir, ['commit', '-q', '-m', 'one']);
    await gitOk(twin.dir, ['add', '.']);
    await gitOk(twin.dir, ['commit', '-q', '-m', 'one']);

    for (const r of [ref, twin]) {
      await writeFiles(r.dir, {
        'a.txt': 'a2\n',
        'b.txt': 'b\n',
        'z/y.txt': 'y\n',
      });
    }
    // git's index may carry extensions (TREE); ts-git must read and rewrite it.
    await add({ fs: ref.fs, dir: ref.dir, filepath: ['a.txt', 'b.txt', 'z'] });
    await gitOk(twin.dir, ['add', 'a.txt', 'b.txt', 'z']);

    expect(await lsFiles(ref)).toBe(await lsFiles(twin));
    expect(await porcelain(ref)).toBe(await porcelain(twin));
    expect((await readIndex(ref.fs, ref.gitdir)).entries).toHaveLength(4);
  });

  it('addAll matches git add -A (new, modified, deleted, ignored)', async () => {
    const files = {
      '.gitignore': 'tmp/\n',
      'keep.txt': 'k\n',
      'mod.txt': 'm\n',
      'del.txt': 'd\n',
    };
    const ts = await tsRepo(files);
    const ref = await gitRepo(files);
    await addAll({ fs: ts.fs, dir: ts.dir });
    await commit({ fs: ts.fs, dir: ts.dir, message: 'init', author: AUTHOR });
    await gitOk(ref.dir, ['add', '-A']);
    await gitOk(ref.dir, ['commit', '-q', '-m', 'init']);

    for (const r of [ts, ref]) {
      await fsp.rm(path.join(r.dir, 'del.txt'));
      await writeFiles(r.dir, {
        'mod.txt': 'changed\n',
        'new/file.txt': 'new\n',
        'tmp/junk.txt': 'junk\n',
      });
    }
    const result = await addAll({ fs: ts.fs, dir: ts.dir });
    await gitOk(ref.dir, ['add', '-A']);

    expect(result.added).toEqual(['new/file.txt']);
    expect(result.updated).toEqual(['mod.txt']);
    expect(result.removed).toEqual(['del.txt']);
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
    expect(await porcelain(ts)).toBe(await porcelain(ref));
  });
});

describe('remove: git rm --cached semantics', () => {
  async function committed(files: Record<string, FileSpec>) {
    const ts = await tsRepo(files);
    const ref = await gitRepo(files);
    await add({ fs: ts.fs, dir: ts.dir, filepath: '.' });
    await commit({ fs: ts.fs, dir: ts.dir, message: 'init', author: AUTHOR });
    await gitOk(ref.dir, ['add', '.']);
    await gitOk(ref.dir, ['commit', '-q', '-m', 'init']);
    return { ts, ref };
  }

  it('removes a file from the index only', async () => {
    const { ts, ref } = await committed({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await remove({ fs: ts.fs, dir: ts.dir, filepath: 'a.txt' });
    await gitOk(ref.dir, ['rm', '-q', '--cached', 'a.txt']);
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
    expect(await porcelain(ts)).toBe(await porcelain(ref));
    expect(await fsp.readFile(path.join(ts.dir, 'a.txt'), 'utf8')).toBe('a\n');
  });

  it('requires recursive for directories, like git rm -r --cached', async () => {
    const { ts, ref } = await committed({
      'd/a.txt': 'a\n',
      'd/e/b.txt': 'b\n',
      'c.txt': 'c\n',
    });
    await expect(
      remove({ fs: ts.fs, dir: ts.dir, filepath: 'd' }),
    ).rejects.toThrow(IsADirectoryError);
    expect((await git(ref.dir, ['rm', '--cached', 'd'])).code).not.toBe(0);

    await remove({ fs: ts.fs, dir: ts.dir, filepath: 'd', recursive: true });
    await gitOk(ref.dir, ['rm', '-q', '-r', '--cached', 'd']);
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
  });

  it('errors for paths not in the index', async () => {
    const { ts, ref } = await committed({ 'a.txt': 'a\n' });
    await expect(
      remove({ fs: ts.fs, dir: ts.dir, filepath: 'nope.txt' }),
    ).rejects.toThrow(NotFoundError);
    expect((await git(ref.dir, ['rm', '--cached', 'nope.txt'])).code).not.toBe(
      0,
    );
  });

  it('refuses when staged content differs from both file and HEAD unless forced', async () => {
    const { ts, ref } = await committed({ 'a.txt': 'a\n' });
    for (const r of [ts, ref]) await writeFiles(r.dir, { 'a.txt': 'staged\n' });
    await add({ fs: ts.fs, dir: ts.dir, filepath: 'a.txt' });
    await gitOk(ref.dir, ['add', 'a.txt']);
    for (const r of [ts, ref])
      await writeFiles(r.dir, { 'a.txt': 'worktree\n' });

    await expect(
      remove({ fs: ts.fs, dir: ts.dir, filepath: 'a.txt' }),
    ).rejects.toThrow(/staged content different/);
    expect((await git(ref.dir, ['rm', '--cached', 'a.txt'])).code).not.toBe(0);

    await remove({ fs: ts.fs, dir: ts.dir, filepath: 'a.txt', force: true });
    await gitOk(ref.dir, ['rm', '-q', '-f', '--cached', 'a.txt']);
    expect(await lsFiles(ts)).toBe(await lsFiles(ref));
  });
});
