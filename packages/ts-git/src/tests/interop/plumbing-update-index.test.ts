import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as nodefs from 'fs';
import * as path from 'path';
import {
  updateIndex,
  type UpdateIndexArgs,
} from '../../commands/update-index.js';
import { createGitSandbox, gitCommitAt, type GitSandbox } from './git-env.js';

/**
 * Two identical repositories: canonical git operates on one, ts-git on the
 * other; afterwards both indexes must describe the same entries and git must
 * report the same status for both.
 */
interface Twins {
  g: GitSandbox;
  t: GitSandbox;
  both: (fn: (sb: GitSandbox) => void) => void;
}

function makeTwins(): Twins {
  const g = createGitSandbox();
  const t = createGitSandbox();
  const both = (fn: (sb: GitSandbox) => void) => {
    fn(g);
    fn(t);
  };
  both((sb) => {
    sb.write('a.txt', 'a\n');
    sb.write('run.sh', '#!/bin/sh\n');
    nodefs.chmodSync(path.join(sb.dir, 'run.sh'), 0o755);
    sb.write('dir/x.txt', 'x\n');
    sb.write('dir/y.txt', 'y\n');
    nodefs.symlinkSync('a.txt', path.join(sb.dir, 'link'));
    sb.git(['add', '-A']);
    gitCommitAt(sb, 'base', 1700000000);
  });
  return { g, t, both };
}

function indexState(sb: GitSandbox): string {
  return sb.git(['ls-files', '-s']);
}

function expectSameState(tw: Twins): void {
  expect(indexState(tw.t)).toBe(indexState(tw.g));
  expect(tw.t.git(['status', '--porcelain=v1', '-uall'])).toBe(
    tw.g.git(['status', '--porcelain=v1', '-uall']),
  );
  // git accepts the index ts-git wrote, and every blob exists.
  tw.t.git(['fsck', '--strict', '--no-dangling']);
  tw.t.git(['diff-index', '--cached', 'HEAD']);
}

async function tsUpdate(tw: Twins, args: Omit<UpdateIndexArgs, 'fs' | 'dir'>) {
  return updateIndex({ fs: tw.t.fs, dir: tw.t.dir, ...args });
}

describe('update-index vs git update-index', () => {
  let tw: Twins;
  beforeEach(() => {
    tw = makeTwins();
  });
  afterEach(() => {
    tw.g.cleanup();
    tw.t.cleanup();
  });

  it('--add stages a new file (and writes its blob)', async () => {
    tw.both((sb) => sb.write('new.txt', 'new\n'));
    tw.g.git(['update-index', '--add', 'new.txt']);
    const r = await tsUpdate(tw, { add: true, filepath: 'new.txt' });
    expect(r.added).toEqual(['new.txt']);
    expectSameState(tw);
  });

  it('updates a modified tracked file without --add', async () => {
    tw.both((sb) => sb.write('dir/x.txt', 'changed\n'));
    tw.g.git(['update-index', 'dir/x.txt']);
    const r = await tsUpdate(tw, { filepath: 'dir/x.txt' });
    expect(r.updated).toEqual(['dir/x.txt']);
    expectSameState(tw);
  });

  it('refuses untracked files without --add', async () => {
    tw.both((sb) => sb.write('new.txt', 'new\n'));
    expect(tw.g.gitTry(['update-index', 'new.txt']).status).not.toBe(0);
    await expect(tsUpdate(tw, { filepath: 'new.txt' })).rejects.toThrow(
      /missing --add/,
    );
    expectSameState(tw);
  });

  it('missing file: error without --remove, removed with --remove', async () => {
    tw.both((sb) => sb.rm('a.txt'));
    expect(tw.g.gitTry(['update-index', 'a.txt']).status).not.toBe(0);
    await expect(tsUpdate(tw, { filepath: 'a.txt' })).rejects.toThrow(
      /does not exist/,
    );
    tw.g.git(['update-index', '--remove', 'a.txt']);
    const r = await tsUpdate(tw, { remove: true, filepath: 'a.txt' });
    expect(r.removed).toEqual(['a.txt']);
    expectSameState(tw);
  });

  it('--remove on an existing file updates it instead of removing', async () => {
    tw.both((sb) => sb.write('dir/y.txt', 'still here\n'));
    tw.g.git(['update-index', '--remove', 'dir/y.txt']);
    await tsUpdate(tw, { remove: true, filepath: 'dir/y.txt' });
    expectSameState(tw);
  });

  it('--force-remove removes even if the file exists', async () => {
    tw.g.git(['update-index', '--force-remove', 'run.sh', 'dir/x.txt']);
    const r = await tsUpdate(tw, {
      forceRemove: true,
      filepath: ['run.sh', 'dir/x.txt'],
    });
    expect(r.removed).toEqual(['run.sh', 'dir/x.txt']);
    expectSameState(tw);
  });

  it('records executable bit changes when core.filemode is true', async () => {
    tw.both((sb) => {
      nodefs.chmodSync(path.join(sb.dir, 'a.txt'), 0o755);
      nodefs.chmodSync(path.join(sb.dir, 'run.sh'), 0o644);
    });
    tw.g.git(['update-index', 'a.txt', 'run.sh']);
    await tsUpdate(tw, { filepath: ['a.txt', 'run.sh'] });
    expect(indexState(tw.t)).toContain('100755');
    expectSameState(tw);
  });

  it('keeps the recorded mode when core.filemode is false', async () => {
    tw.both((sb) => {
      sb.git(['config', 'core.filemode', 'false']);
      nodefs.chmodSync(path.join(sb.dir, 'a.txt'), 0o755);
      nodefs.chmodSync(path.join(sb.dir, 'run.sh'), 0o644);
      sb.write('a.txt', 'a2\n');
      sb.write('run.sh', '#!/bin/sh\nexit 0\n');
    });
    tw.g.git(['update-index', 'a.txt', 'run.sh']);
    await tsUpdate(tw, { filepath: ['a.txt', 'run.sh'] });
    expectSameState(tw);
  });

  it('stores symlinks as 120000 blobs of the target path', async () => {
    tw.both((sb) => {
      sb.rm('link');
      nodefs.symlinkSync('dir/x.txt', path.join(sb.dir, 'link'));
      nodefs.symlinkSync('nowhere', path.join(sb.dir, 'dangling'));
    });
    tw.g.git(['update-index', '--add', 'link', 'dangling']);
    await tsUpdate(tw, { add: true, filepath: ['link', 'dangling'] });
    expect(indexState(tw.t)).toMatch(/^120000 .* 0\tdangling$/m);
    expectSameState(tw);
  });

  it('--cacheinfo adds entries without touching the worktree', async () => {
    const blob = tw.g.git(['rev-parse', 'HEAD:a.txt']).trim();
    const gitlink = 'b'.repeat(40);
    expect(
      tw.g.gitTry(['update-index', '--cacheinfo', `100644,${blob},c.txt`])
        .status,
    ).not.toBe(0);
    await expect(
      tsUpdate(tw, {
        cacheinfo: [{ mode: '100644', oid: blob, path: 'c.txt' }],
      }),
    ).rejects.toThrow(/missing --add/);

    tw.g.git([
      'update-index',
      '--add',
      '--cacheinfo',
      `100644,${blob},c.txt`,
      '--cacheinfo',
      `160000,${gitlink},sub`,
      '--cacheinfo',
      `100755,${blob},dir/x.txt`,
    ]);
    await tsUpdate(tw, {
      add: true,
      cacheinfo: [
        { mode: '100644', oid: blob, path: 'c.txt' },
        { mode: '160000', oid: gitlink, path: 'sub' },
        { mode: 0o100755, oid: blob, path: 'dir/x.txt' },
      ],
    });
    expect(indexState(tw.t)).toBe(indexState(tw.g));
    expect(tw.t.git(['status', '--porcelain=v1'])).toBe(
      tw.g.git(['status', '--porcelain=v1']),
    );
  });

  it('resolves an unmerged path by replacing all stages', async () => {
    tw.both((sb) => {
      sb.git(['checkout', '-q', '-b', 'other']);
      sb.write('a.txt', 'other\n');
      sb.git(['commit', '-qam', 'other']);
      sb.git(['checkout', '-q', 'main']);
      sb.write('a.txt', 'main\n');
      sb.git(['commit', '-qam', 'main']);
      expect(sb.gitTry(['merge', 'other']).status).not.toBe(0);
      sb.write('a.txt', 'resolved\n');
    });
    expect(indexState(tw.t)).toMatch(/ 1\ta\.txt\n.* 2\ta\.txt\n.* 3\ta\.txt/);
    tw.g.git(['update-index', 'a.txt']);
    await tsUpdate(tw, { filepath: 'a.txt' });
    expectSameState(tw);
  });

  it('writes entries in git index order (byte order)', async () => {
    const names = [
      'B.txt',
      'a-b',
      'a.b',
      'ab',
      'a_b',
      'Z/z.txt',
      'dir-x',
      'dir0',
    ];
    tw.both((sb) => names.forEach((n) => sb.write(n, n + '\n')));
    tw.g.git(['update-index', '--add', ...names]);
    await tsUpdate(tw, { add: true, filepath: names });
    expectSameState(tw);
  });

  it('handles non-ASCII paths', async () => {
    const names = ['é.txt', 'ファイル.txt', 'zz.txt'];
    tw.both((sb) => names.forEach((n) => sb.write(n, n + '\n')));
    tw.g.git(['update-index', '--add', ...names]);
    await tsUpdate(tw, { add: true, filepath: names });
    expectSameState(tw);
  });

  it('rejects directories like git', async () => {
    expect(tw.g.gitTry(['update-index', '--add', 'dir']).status).not.toBe(0);
    await expect(tsUpdate(tw, { add: true, filepath: 'dir' })).rejects.toThrow(
      /directory/,
    );
  });
});
