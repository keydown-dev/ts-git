import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { init } from '../../commands/init.js';
import { add } from '../../commands/add.js';
import { commit } from '../../commands/commit.js';
import { setHeadDetached } from '../../core/refs.js';
import { EmptyCommitError, UnmergedPathsError } from '../../errors.js';
import { readIndex, writeIndex } from '../../core/index.js';
import type { Author } from '../../types.js';
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

/** ts-git: init + add . + commit. */
async function tsGitCommit(
  files: Record<string, FileSpec>,
  message: string,
  author: Required<Author> = AUTHOR,
  initArgs: { defaultBranch?: string } = {},
): Promise<{ repo: Repo; oid: string }> {
  const repo = await emptyRepoDir();
  await init({ fs: repo.fs, dir: repo.dir, ...initArgs });
  await writeFiles(repo.dir, files);
  await add({ fs: repo.fs, dir: repo.dir, filepath: '.' });
  const oid = await commit({ fs: repo.fs, dir: repo.dir, message, author });
  return { repo, oid };
}

/** canonical git: init + add . + commit -m. */
async function gitCommit(
  files: Record<string, FileSpec>,
  message: string,
  author: Required<Author> = AUTHOR,
): Promise<{ repo: Repo; oid: string }> {
  const repo = await gitInitRepo();
  await writeFiles(repo.dir, files);
  await gitOk(repo.dir, ['add', '.']);
  await gitOk(repo.dir, ['commit', '-q', '-m', message], { author });
  return { repo, oid: await gitOk(repo.dir, ['rev-parse', 'HEAD']) };
}

describe('commit: byte-for-byte compatibility with canonical git', () => {
  const cases: Record<string, Record<string, FileSpec>> = {
    'single file': { 'README.md': '# hello\n' },
    'nested directories': {
      'a.txt': 'a\n',
      'src/index.ts': 'export {};\n',
      'src/lib/deep/x.js': 'x\n',
      'docs/guide/intro.md': 'intro\n',
    },
    'empty file': { 'empty.txt': '', 'dir/also-empty': '' },
    'executable file': {
      'run.sh': { content: '#!/bin/sh\necho hi\n', mode: 0o755 },
      'plain.txt': 'plain\n',
    },
    'unicode names': {
      'héllo.txt': 'accent\n',
      '日本語/ファイル.md': 'japanese\n',
      'emoji-🎉.txt': 'party\n',
    },
    // Trees sort by bytes, comparing a directory as if it had a trailing
    // '/': "a.b" < "a/" < "a0" and "a-b" < "a.b"; uppercase before lowercase.
    'tree entry sort order': {
      'a.b': '1\n',
      'a/inner': '2\n',
      a0: '3\n',
      'a-b': '4\n',
      A: '5\n',
      'foo.txt': '6\n',
      'foo/bar.txt': '7\n',
      'foo-bar/x': '8\n',
    },
    symlink: {
      'target.txt': 'target\n',
      link: { symlink: 'target.txt' },
      'dir/rel-link': { symlink: '../target.txt' },
    },
  };

  for (const [name, files] of Object.entries(cases)) {
    it(`produces the same commit, tree and index as git: ${name}`, async () => {
      const ts = await tsGitCommit(files, 'Initial commit');
      const ref = await gitCommit(files, 'Initial commit');

      expect(ts.oid).toBe(ref.oid);
      expect(await gitOk(ts.repo.dir, ['cat-file', '-p', 'HEAD^{tree}'])).toBe(
        await gitOk(ref.repo.dir, ['cat-file', '-p', 'HEAD^{tree}']),
      );
      expect(await gitOk(ts.repo.dir, ['ls-files', '-s'])).toBe(
        await gitOk(ref.repo.dir, ['ls-files', '-s']),
      );
      // git agrees the repo is consistent and the worktree is clean.
      await gitOk(ts.repo.dir, ['fsck', '--strict', '--no-dangling']);
      expect(await gitOk(ts.repo.dir, ['status', '--porcelain'])).toBe('');
    });
  }

  it('applies git commit -m message cleanup (whitespace mode)', async () => {
    const messages = [
      'no trailing newline',
      'with trailing newline\n',
      '\n\n  leading blank lines and indented first line',
      'trailing spaces   \nsecond line\t\n',
      'subject\n\n\n\nbody after many blank lines\n\n\n',
      '# not a comment with -m\nbody',
      'unicode: ünïcödé ✓',
    ];
    for (const message of messages) {
      const ts = await tsGitCommit({ 'f.txt': 'x\n' }, message);
      const ref = await gitCommit({ 'f.txt': 'x\n' }, message);
      expect(ts.oid, JSON.stringify(message)).toBe(ref.oid);
    }
  });

  it('verbatim cleanup matches git commit-tree', async () => {
    const repo = await emptyRepoDir();
    await init({ fs: repo.fs, dir: repo.dir });
    await writeFiles(repo.dir, { 'f.txt': 'x\n' });
    await add({ fs: repo.fs, dir: repo.dir, filepath: 'f.txt' });
    const message = 'raw message without newline  ';
    const oid = await commit({
      fs: repo.fs,
      dir: repo.dir,
      message,
      author: AUTHOR,
      cleanup: 'verbatim',
    });
    const tree = await gitOk(repo.dir, ['write-tree']);
    const expected = await gitOk(repo.dir, ['commit-tree', tree], {
      input: message,
    });
    expect(oid).toBe(expected);
  });

  it('refuses an empty message like git', async () => {
    const repo = await emptyRepoDir();
    await init({ fs: repo.fs, dir: repo.dir });
    await writeFiles(repo.dir, { 'f.txt': 'x\n' });
    await add({ fs: repo.fs, dir: repo.dir, filepath: 'f.txt' });
    await expect(
      commit({ fs: repo.fs, dir: repo.dir, message: ' \n\n', author: AUTHOR }),
    ).rejects.toThrow(/empty commit message/);
    expect((await git(repo.dir, ['commit', '-m', ' \n\n'])).code).not.toBe(0);
  });

  it('formats timezones like git', async () => {
    const zones = [0, -330, 480, -60, 210, 720, -840];
    for (const timezoneOffset of zones) {
      const author = { ...AUTHOR, timezoneOffset };
      const ts = await tsGitCommit({ 'f.txt': 'tz\n' }, 'tz', author);
      const ref = await gitCommit({ 'f.txt': 'tz\n' }, 'tz', author);
      expect(ts.oid, `offset ${timezoneOffset}`).toBe(ref.oid);
    }
  });

  it('strips identity crud like git', async () => {
    const author = {
      ...AUTHOR,
      name: '  "Crud Name;"  ',
      email: '<crud@example.com>',
    };
    const ts = await tsGitCommit({ 'f.txt': 'x\n' }, 'msg', author);
    const ref = await gitCommit({ 'f.txt': 'x\n' }, 'msg', author);
    expect(ts.oid).toBe(ref.oid);
  });

  it('builds second commits with the right parent (identical to git)', async () => {
    const ts = await tsGitCommit({ 'a.txt': '1\n' }, 'one');
    const ref = await gitCommit({ 'a.txt': '1\n' }, 'one');

    const later = { ...AUTHOR, timestamp: AUTHOR.timestamp + 60 };
    await writeFiles(ts.repo.dir, { 'a.txt': '2\n', 'b/c.txt': 'c\n' });
    await add({ fs: ts.repo.fs, dir: ts.repo.dir, filepath: '.' });
    const tsOid = await commit({
      fs: ts.repo.fs,
      dir: ts.repo.dir,
      message: 'two',
      author: later,
    });

    await writeFiles(ref.repo.dir, { 'a.txt': '2\n', 'b/c.txt': 'c\n' });
    await gitOk(ref.repo.dir, ['add', '.']);
    await gitOk(ref.repo.dir, ['commit', '-q', '-m', 'two'], { author: later });

    expect(tsOid).toBe(await gitOk(ref.repo.dir, ['rev-parse', 'HEAD']));
    expect(await gitOk(ts.repo.dir, ['rev-list', '--count', 'HEAD'])).toBe('2');
  });

  it('commits on an unborn branch with a nested non-default name', async () => {
    const repo = await emptyRepoDir();
    await init({ fs: repo.fs, dir: repo.dir, defaultBranch: 'feature/x' });
    await writeFiles(repo.dir, { 'f.txt': 'x\n' });
    await add({ fs: repo.fs, dir: repo.dir, filepath: 'f.txt' });
    const oid = await commit({
      fs: repo.fs,
      dir: repo.dir,
      message: 'first',
      author: AUTHOR,
    });

    expect(await gitOk(repo.dir, ['symbolic-ref', 'HEAD'])).toBe(
      'refs/heads/feature/x',
    );
    expect(await gitOk(repo.dir, ['rev-parse', 'refs/heads/feature/x'])).toBe(
      oid,
    );
    expect(
      (await git(repo.dir, ['rev-parse', '--verify', 'refs/heads/x'])).code,
    ).not.toBe(0);
  });

  it('commits on a detached HEAD without touching branches', async () => {
    const ts = await tsGitCommit({ 'a.txt': '1\n' }, 'one');
    await setHeadDetached(ts.repo.fs, ts.repo.gitdir, ts.oid);
    await writeFiles(ts.repo.dir, { 'a.txt': '2\n' });
    await add({ fs: ts.repo.fs, dir: ts.repo.dir, filepath: 'a.txt' });
    const oid = await commit({
      fs: ts.repo.fs,
      dir: ts.repo.dir,
      message: 'detached',
      author: AUTHOR,
    });

    const sym = await git(ts.repo.dir, ['symbolic-ref', '-q', 'HEAD']);
    expect(sym.code).not.toBe(0); // still detached
    expect(await gitOk(ts.repo.dir, ['rev-parse', 'HEAD'])).toBe(oid);
    expect(await gitOk(ts.repo.dir, ['rev-parse', 'master'])).toBe(ts.oid);
    expect(await gitOk(ts.repo.dir, ['rev-parse', 'HEAD^'])).toBe(ts.oid);
  });

  it('refuses "nothing to commit" like git, unless allowEmpty', async () => {
    const ts = await tsGitCommit({ 'a.txt': '1\n' }, 'one');
    const ref = await gitCommit({ 'a.txt': '1\n' }, 'one');

    await expect(
      commit({
        fs: ts.repo.fs,
        dir: ts.repo.dir,
        message: 'again',
        author: AUTHOR,
      }),
    ).rejects.toThrow(EmptyCommitError);
    expect((await git(ref.repo.dir, ['commit', '-m', 'again'])).code).not.toBe(
      0,
    );

    const later = { ...AUTHOR, timestamp: AUTHOR.timestamp + 1 };
    const oid = await commit({
      fs: ts.repo.fs,
      dir: ts.repo.dir,
      message: 'empty',
      author: later,
      allowEmpty: true,
    });
    await gitOk(
      ref.repo.dir,
      ['commit', '-q', '--allow-empty', '-m', 'empty'],
      {
        author: later,
      },
    );
    expect(oid).toBe(await gitOk(ref.repo.dir, ['rev-parse', 'HEAD']));
  });

  it('refuses an initial commit with an empty index like git', async () => {
    const repo = await emptyRepoDir();
    await init({ fs: repo.fs, dir: repo.dir });
    await expect(
      commit({ fs: repo.fs, dir: repo.dir, message: 'x', author: AUTHOR }),
    ).rejects.toThrow(EmptyCommitError);
    expect((await git(repo.dir, ['commit', '-m', 'x'])).code).not.toBe(0);

    // --allow-empty on an unborn branch creates an empty-tree commit.
    const oid = await commit({
      fs: repo.fs,
      dir: repo.dir,
      message: 'root',
      author: AUTHOR,
      allowEmpty: true,
    });
    const ref = await gitInitRepo();
    await gitOk(ref.dir, ['commit', '-q', '--allow-empty', '-m', 'root']);
    expect(oid).toBe(await gitOk(ref.dir, ['rev-parse', 'HEAD']));
  });

  it('refuses to commit with unmerged index entries', async () => {
    const ts = await tsGitCommit({ 'a.txt': '1\n' }, 'one');
    const index = await readIndex(ts.repo.fs, ts.repo.gitdir);
    const base = index.entries[0];
    index.entries = [1, 2, 3].map((stage) => ({
      ...base,
      flags: (stage << 12) | base.path.length,
    }));
    await writeIndex(ts.repo.fs, ts.repo.gitdir, index);
    expect(await gitOk(ts.repo.dir, ['ls-files', '-u'])).toContain('a.txt');
    await expect(
      commit({
        fs: ts.repo.fs,
        dir: ts.repo.dir,
        message: 'm',
        author: AUTHOR,
      }),
    ).rejects.toThrow(UnmergedPathsError);
  });

  it('commits on top of a git-created history', async () => {
    const ref = await gitCommit(
      { 'a.txt': '1\n', 'dir/b.txt': 'b\n' },
      'git one',
    );
    const twin = await gitCommit(
      { 'a.txt': '1\n', 'dir/b.txt': 'b\n' },
      'git one',
    );
    const later = { ...AUTHOR, timestamp: AUTHOR.timestamp + 100 };

    await writeFiles(ref.repo.dir, { 'dir/b.txt': 'changed\n' });
    await add({ fs: ref.repo.fs, dir: ref.repo.dir, filepath: 'dir' });
    const oid = await commit({
      fs: ref.repo.fs,
      dir: ref.repo.dir,
      message: 'ts two',
      author: later,
    });

    await writeFiles(twin.repo.dir, { 'dir/b.txt': 'changed\n' });
    await gitOk(twin.repo.dir, ['add', 'dir']);
    await gitOk(twin.repo.dir, ['commit', '-q', '-m', 'ts two'], {
      author: later,
    });

    expect(oid).toBe(await gitOk(twin.repo.dir, ['rev-parse', 'HEAD']));
    await gitOk(ref.repo.dir, ['fsck', '--strict', '--no-dangling']);
    expect(await gitOk(ref.repo.dir, ['status', '--porcelain'])).toBe('');
  });
});
