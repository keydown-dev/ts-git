import { describe, it, expect, afterEach } from 'vitest';
import * as nodefs from 'fs';
import * as path from 'path';
import {
  statusPorcelain,
  statusMatrix,
  classifyStatusRow,
  status,
} from '../../commands/status.js';
import { quoteGitPath } from '../../commands/ls-tree.js';
import { createGitSandbox, gitCommitAll, type GitSandbox } from './git-env.js';

type Mode = 'normal' | 'all' | 'no';

function gitStatus(sb: GitSandbox, mode: Mode = 'normal', ignored = false) {
  return sb.git([
    'status',
    '--porcelain=v1',
    '--no-renames',
    `--untracked-files=${mode}`,
    ...(ignored ? ['--ignored'] : []),
  ]);
}

async function tsStatus(
  sb: GitSandbox,
  mode: Mode = 'normal',
  ignored = false,
) {
  return statusPorcelain({
    fs: sb.fs,
    dir: sb.dir,
    untrackedFiles: mode,
    ignored,
  });
}

/** Porcelain lines derived from statusMatrix + classifyStatusRow (-uall). */
async function matrixPorcelain(sb: GitSandbox): Promise<string> {
  const rows = await statusMatrix({ fs: sb.fs, dir: sb.dir });
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const row of rows) {
    const c = classifyStatusRow(row);
    const p = quoteGitPath(row[0], true, true);
    if (c.isStaged || c.isUnstaged) {
      tracked.push(
        `${c.stagedStatus}${c.isUnstaged ? c.unstagedStatus : ' '} ${p}\n`,
      );
    }
    if (c.isUntracked) untracked.push(`?? ${p}\n`);
  }
  return tracked.join('') + untracked.join('');
}

async function expectStatusMatches(
  sb: GitSandbox,
  opts: { matrix?: boolean } = {},
) {
  for (const mode of ['normal', 'all', 'no'] as Mode[]) {
    expect(await tsStatus(sb, mode), `-u${mode}`).toBe(gitStatus(sb, mode));
  }
  expect(await tsStatus(sb, 'normal', true), '--ignored').toBe(
    gitStatus(sb, 'normal', true),
  );
  if (opts.matrix !== false) {
    expect(await matrixPorcelain(sb), 'statusMatrix').toBe(
      gitStatus(sb, 'all'),
    );
  }
}

function chmod(sb: GitSandbox, p: string, mode: number) {
  nodefs.chmodSync(path.join(sb.dir, p), mode);
}

function symlink(sb: GitSandbox, target: string, p: string) {
  nodefs.symlinkSync(target, path.join(sb.dir, p));
}

/** Base repository used by most scenarios. */
function baseRepo(): GitSandbox {
  const sb = createGitSandbox();
  sb.write('a.txt', 'a\n');
  sb.write('b.txt', 'b\n');
  sb.write('c.txt', 'c\n');
  sb.write('dir/one.txt', '1\n');
  sb.write('dir/sub/two.txt', '2\n');
  sb.write('run.sh', '#!/bin/sh\n');
  chmod(sb, 'run.sh', 0o755);
  symlink(sb, 'a.txt', 'link');
  gitCommitAll(sb, 'base');
  return sb;
}

describe('status vs git status --porcelain=v1', () => {
  let sb: GitSandbox;
  afterEach(() => sb?.cleanup());

  it('clean repository and unborn branch', async () => {
    sb = createGitSandbox();
    await expectStatusMatches(sb);
    sb.write('new.txt', 'n\n');
    sb.write('newdir/x.txt', 'x\n');
    await expectStatusMatches(sb);
    sb.git(['add', 'new.txt']);
    await expectStatusMatches(sb);
    sb.cleanup();

    sb = baseRepo();
    await expectStatusMatches(sb);
  });

  it('staged, unstaged and both (M, A, D, AM, AD, MM, MD)', async () => {
    sb = baseRepo();
    sb.write('a.txt', 'staged\n');
    sb.git(['add', 'a.txt']); // M_
    sb.write('b.txt', 'unstaged\n'); // _M
    sb.write('c.txt', 'staged\n');
    sb.git(['add', 'c.txt']);
    sb.write('c.txt', 'and unstaged\n'); // MM
    sb.write('added.txt', 'new\n');
    sb.git(['add', 'added.txt']); // A_
    sb.write('am.txt', 'new\n');
    sb.git(['add', 'am.txt']);
    sb.write('am.txt', 'changed\n'); // AM
    sb.write('ad.txt', 'new\n');
    sb.git(['add', 'ad.txt']);
    sb.rm('ad.txt'); // AD
    sb.git(['rm', '-q', 'dir/one.txt']); // D_
    sb.rm('dir/sub/two.txt'); // _D
    sb.write('run.sh', '#!/bin/sh\nexit 1\n');
    sb.git(['add', 'run.sh']);
    sb.rm('run.sh'); // MD
    await expectStatusMatches(sb);
  });

  it('staged deletion with an untracked file of the same name', async () => {
    sb = baseRepo();
    sb.git(['rm', '-q', '--cached', 'a.txt']); // D_ + ??
    sb.git(['rm', '-q', '--cached', 'b.txt']);
    sb.write('b.txt', 'different\n');
    await expectStatusMatches(sb);
  });

  it('renames appear as delete + add', async () => {
    sb = baseRepo();
    sb.git(['mv', 'a.txt', 'renamed.txt']);
    sb.git(['mv', 'dir', 'moved']);
    sb.write('moved/one.txt', 'edited after move\n');
    await expectStatusMatches(sb);
  });

  it('untracked directories are collapsed like git (-unormal)', async () => {
    sb = baseRepo();
    sb.write('newdir/a.txt', 'x\n');
    sb.write('newdir/deep/b.txt', 'x\n');
    sb.write('dir/newsub/c.txt', 'x\n'); // inside a tracked dir
    sb.write('dir/sub/d.txt', 'x\n');
    nodefs.mkdirSync(path.join(sb.dir, 'emptydir/nested'), { recursive: true });
    sb.write('onlyignored/x.log', 'x\n');
    sb.write('.gitignore', '*.log\n');
    await expectStatusMatches(sb);
  });

  it('ignore rules: negation, nested .gitignore, info/exclude, anchored, dir-only', async () => {
    sb = baseRepo();
    sb.write(
      '.gitignore',
      ['*.log', '!keep.log', 'build/', '/rootonly', 'docs/**/*.tmp', ''].join(
        '\n',
      ),
    );
    sb.write('sub/.gitignore', '!important.log\n*.cache\n/local\n');
    sb.write('.git/info/exclude', 'excluded.txt\n');
    for (const f of [
      'x.log',
      'keep.log',
      'sub/y.log',
      'sub/important.log',
      'sub/z.cache',
      'sub/local',
      'sub/deeper/local',
      'build/out.js',
      'sub/build/out.js',
      'rootonly',
      'sub/rootonly',
      'docs/a.tmp',
      'docs/x/y/b.tmp',
      'docs/readme.md',
      'excluded.txt',
      'sub/excluded.txt',
    ]) {
      sb.write(f, 'content\n');
    }
    await expectStatusMatches(sb);
    // Tracked files matching ignore patterns are still reported.
    sb.git(['add', '-f', 'x.log']);
    gitCommitAll(sb, 'force-add');
    sb.write('x.log', 'modified\n');
    await expectStatusMatches(sb);
  });

  it('directory whose contents are all ignored, ignored nested repo', async () => {
    sb = baseRepo();
    sb.write('.gitignore', '*.o\nvendor/\n');
    sb.write('objs/a.o', 'x');
    sb.write('objs/b.o', 'x');
    sb.write('mixed/a.o', 'x');
    sb.write('mixed/keep.c', 'x');
    sb.write('vendor/lib/x.js', 'x');
    const nested = path.join(sb.dir, 'nested');
    nodefs.mkdirSync(nested);
    sb.write('nested/f.txt', 'x');
    sb.git(['-C', nested, 'init', '-q']);
    // statusMatrix lists files only; it has no row for the nested repo.
    await expectStatusMatches(sb, { matrix: false });
  });

  it('executable bit changes respect core.filemode', async () => {
    sb = baseRepo();
    chmod(sb, 'a.txt', 0o755);
    chmod(sb, 'run.sh', 0o644);
    await expectStatusMatches(sb);
    sb.git(['add', 'a.txt']);
    await expectStatusMatches(sb);
    sb.git(['config', 'core.filemode', 'false']);
    await expectStatusMatches(sb);
  });

  it('symlinks: untracked, retargeted, type changes', async () => {
    sb = baseRepo();
    symlink(sb, 'dir', 'dirlink'); // untracked symlink to a directory
    symlink(sb, 'nowhere', 'dangling');
    sb.rm('link');
    symlink(sb, 'b.txt', 'link'); // retarget
    sb.rm('c.txt');
    symlink(sb, 'a.txt', 'c.txt'); // file -> symlink (T)
    // The status matrix cannot express a type change ('T'); it reports 'M'.
    await expectStatusMatches(sb, { matrix: false });
    expect(await matrixPorcelain(sb)).toBe(
      gitStatus(sb, 'all').replace(' T c.txt', ' M c.txt'),
    );
    sb.git(['add', 'c.txt']);
    await expectStatusMatches(sb, { matrix: false });
  });

  it('file replaced by a directory and vice versa', async () => {
    sb = baseRepo();
    sb.rm('a.txt');
    sb.write('a.txt/inner.txt', 'x\n');
    sb.rm('dir/sub');
    sb.write('dir/sub', 'now a file\n');
    await expectStatusMatches(sb);
  });

  it('detects changes the stat data cannot see (racy git)', async () => {
    sb = baseRepo();
    // Same size, same second as the index write.
    sb.write('a.txt', 'A\n');
    await expectStatusMatches(sb);
    sb.gitTry(['update-index', '--refresh']);

    // Same size and mtime restored after changing content.
    const file = path.join(sb.dir, 'b.txt');
    const before = nodefs.statSync(file);
    sb.write('b.txt', 'B\n');
    nodefs.utimesSync(file, before.atime, before.mtime);
    await expectStatusMatches(sb);

    // An old, refreshed index whose stat data matches is trusted, and
    // content changes are still found.
    const old = new Date(Date.now() - 3600_000);
    for (const f of ['a.txt', 'c.txt', 'dir/one.txt']) {
      nodefs.utimesSync(path.join(sb.dir, f), old, old);
    }
    sb.gitTry(['update-index', '--refresh']);
    await expectStatusMatches(sb);
    // Same size, mtime forged back to the recorded value: only the ctime
    // changed. git compares ctime at one-second granularity and can miss
    // this when everything happens within the same second; ts-git compares
    // at millisecond granularity and must report the change.
    sb.write('c.txt', 'C\n');
    nodefs.utimesSync(path.join(sb.dir, 'c.txt'), old, old);
    expect(await tsStatus(sb)).toBe(' M a.txt\n M b.txt\n M c.txt\n');
    // Once the mtime moves, git sees it as well.
    nodefs.utimesSync(path.join(sb.dir, 'c.txt'), new Date(), new Date());
    await expectStatusMatches(sb);
  });

  it('unmerged entries (UU, AA, UD, DU)', async () => {
    sb = createGitSandbox();
    sb.write('both.txt', 'base\n');
    sb.write('mod-del.txt', 'base\n');
    sb.write('del-mod.txt', 'base\n');
    sb.write('clean.txt', 'x\n');
    gitCommitAll(sb, 'base');
    sb.git(['checkout', '-q', '-b', 'theirs']);
    sb.write('both.txt', 'theirs\n');
    sb.write('added.txt', 'theirs\n');
    sb.rm('mod-del.txt');
    sb.write('del-mod.txt', 'theirs\n');
    gitCommitAll(sb, 'theirs');
    sb.git(['checkout', '-q', 'main']);
    sb.write('both.txt', 'ours\n');
    sb.write('added.txt', 'ours\n');
    sb.write('mod-del.txt', 'ours\n');
    sb.rm('del-mod.txt');
    gitCommitAll(sb, 'ours');
    expect(sb.gitTry(['merge', 'theirs']).status).not.toBe(0);
    expect(gitStatus(sb)).toMatch(/^UU both\.txt$/m);
    expect(gitStatus(sb)).toMatch(/^AA added\.txt$/m);
    await expectStatusMatches(sb, { matrix: false });
  });

  it('quotes special file names like git', async () => {
    sb = baseRepo();
    sb.write('tab\there.txt', 'x\n');
    sb.write('ファイル.txt', 'x\n');
    sb.write('quote".txt', 'x\n');
    sb.write('sp ace.txt', 'x\n');
    sb.write('ünï/cödé.txt', 'x\n');
    await expectStatusMatches(sb);
    sb.git(['add', '-A']);
    await expectStatusMatches(sb);
  });

  it('status() names ignored files and uses isomorphic-git names', async () => {
    sb = baseRepo();
    sb.write('.gitignore', '*.log\n');
    sb.write('x.log', 'x\n');
    sb.write('new.txt', 'x\n');
    sb.write('b.txt', 'changed\n');
    chmod(sb, 'a.txt', 0o755);
    sb.write('c.txt', 'staged\n');
    sb.git(['add', 'c.txt']);
    sb.write('c.txt', 'staged then reverted?\n');
    const s = (filepath: string) =>
      status({ fs: sb.fs, dir: sb.dir, filepath });
    expect(await s('x.log')).toBe('ignored');
    expect(await s('new.txt')).toBe('*added');
    expect(await s('b.txt')).toBe('*modified');
    expect(await s('a.txt')).toBe('*modified');
    expect(await s('c.txt')).toBe('*modified');
    expect(await s('run.sh')).toBe('unmodified');
    expect(await s('nope.txt')).toBe('absent');
    sb.write('c.txt', 'c\n'); // back to HEAD content, index differs
    expect(await s('c.txt')).toBe('*unmodified');
  });
});
