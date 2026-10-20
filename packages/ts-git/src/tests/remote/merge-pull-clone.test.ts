import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { NodeFSAdapter } from '../../fs/node-adapter.js';
import { merge, abortMerge } from '../../commands/merge.js';
import { pull } from '../../commands/pull.js';
import { clone } from '../../commands/clone.js';
import { add } from '../../commands/add.js';
import { commit } from '../../commands/commit.js';
import { reset } from '../../commands/reset.js';
import { checkoutBranch } from '../../commands/branch.js';
import {
  MergeConflictError,
  NonFastForwardError,
  UncommittedChangesError,
  CheckoutConflictError,
} from '../../errors.js';
import { createSandbox, type GitSandbox } from './git-helpers.js';
import { startGitHttpServer, type GitHttpServer } from './http-server.js';

const fs = new NodeFSAdapter();
const author = {
  name: 'Test Committer',
  email: 'committer@example.com',
  timestamp: 1700000000,
  timezoneOffset: 0,
};

describe('merge (interop with git merge)', () => {
  let sb: GitSandbox;
  let repo: string;
  let twin: string;

  const write = (dir: string, file: string, content: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  const commitAll = (dir: string, msg: string) => {
    sb.git(dir, ['add', '-A']);
    sb.git(dir, ['commit', '-q', '-m', msg]);
  };
  /** Copy of the repo for running canonical git on identical state. */
  const makeTwin = () => {
    cpSync(repo, twin, { recursive: true });
  };

  beforeEach(() => {
    sb = createSandbox();
    repo = join(sb.root, 'repo');
    twin = join(sb.root, 'twin');
    sb.git(sb.root, ['init', '-q', '-b', 'main', repo]);
    sb.git(repo, ['config', 'user.name', author.name]);
    sb.git(repo, ['config', 'user.email', author.email]);
    const lines =
      Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    write(repo, 'shared.txt', lines);
    write(repo, 'dir/keep.txt', 'keep\n');
    write(repo, 'remove-me.txt', 'bye\n');
    commitAll(repo, 'base');
  });
  afterEach(() => sb.cleanup());

  it('fast-forwards and updates the working tree', async () => {
    sb.git(repo, ['checkout', '-q', '-b', 'feature']);
    write(repo, 'new/file.txt', 'new\n');
    sb.git(repo, ['rm', '-q', 'remove-me.txt']);
    commitAll(repo, 'feature');
    sb.git(repo, ['checkout', '-q', 'main']);

    const res = await merge({ fs, dir: repo, theirs: 'feature' });
    expect(res.type).toBe('fast-forward');
    expect(sb.git(repo, ['rev-parse', 'main'])).toBe(
      sb.git(repo, ['rev-parse', 'feature']),
    );
    expect(readFileSync(join(repo, 'new/file.txt'), 'utf8')).toBe('new\n');
    expect(existsSync(join(repo, 'remove-me.txt'))).toBe(false);
    expect(sb.git(repo, ['status', '--porcelain'])).toBe('');
    expect(sb.git(repo, ['rev-parse', 'ORIG_HEAD']).trim()).toBe(
      res.type === 'fast-forward' ? res.previous : '',
    );

    expect((await merge({ fs, dir: repo, theirs: 'feature' })).type).toBe(
      'up-to-date',
    );
  });

  it('creates the same merge tree and message as git for a clean merge', async () => {
    sb.git(repo, ['checkout', '-q', '-b', 'feature']);
    const shared = readFileSync(join(repo, 'shared.txt'), 'utf8');
    write(repo, 'shared.txt', shared.replace('line 18', 'feature 18'));
    write(repo, 'feature.txt', 'feature\n');
    commitAll(repo, 'feature change');
    sb.git(repo, ['checkout', '-q', 'main']);
    write(repo, 'shared.txt', shared.replace('line 2\n', 'main 2\n'));
    sb.git(repo, ['rm', '-q', 'remove-me.txt']);
    commitAll(repo, 'main change');
    makeTwin();

    const expectedTree = sb
      .git(repo, ['merge-tree', '--write-tree', 'main', 'feature'])
      .trim();
    const res = await merge({
      fs,
      dir: repo,
      theirs: 'feature',
      author: { ...author, name: 'Test Author', email: 'author@example.com' },
      committer: author,
    });
    expect(res.type).toBe('merge');
    expect(sb.git(repo, ['rev-parse', 'HEAD^{tree}']).trim()).toBe(
      expectedTree,
    );
    expect(
      sb.git(repo, ['rev-list', '--parents', '-1', 'HEAD']).trim().split(' '),
    ).toHaveLength(3);
    expect(sb.git(repo, ['status', '--porcelain'])).toBe('');
    sb.git(repo, ['fsck', '--strict', '--no-dangling']);

    sb.git(twin, ['merge', '-q', '--no-edit', 'feature']);
    expect(sb.git(repo, ['log', '-1', '--format=%B'])).toBe(
      sb.git(twin, ['log', '-1', '--format=%B']),
    );
    // Same author/committer/time => byte-identical commit.
    expect(sb.git(repo, ['rev-parse', 'HEAD'])).toBe(
      sb.git(twin, ['rev-parse', 'HEAD']),
    );
  });

  it('leaves the same conflict state as git and concludes with commit', async () => {
    sb.git(repo, ['checkout', '-q', '-b', 'feature']);
    const shared = readFileSync(join(repo, 'shared.txt'), 'utf8');
    write(repo, 'shared.txt', shared.replace('line 10', 'feature 10'));
    write(repo, 'dir/keep.txt', 'feature keep\n');
    commitAll(repo, 'feature');
    sb.git(repo, ['checkout', '-q', 'main']);
    write(repo, 'shared.txt', shared.replace('line 10', 'main 10'));
    sb.git(repo, ['rm', '-q', 'dir/keep.txt']);
    write(repo, 'main-only.txt', 'main\n');
    commitAll(repo, 'main');
    makeTwin();

    const err = await merge({ fs, dir: repo, theirs: 'feature', author }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MergeConflictError);
    expect((err as MergeConflictError).paths).toEqual([
      'dir/keep.txt',
      'shared.txt',
    ]);

    try {
      sb.git(twin, ['merge', '--no-edit', 'feature']);
    } catch {
      // expected: conflicts
    }
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe(
      readFileSync(join(twin, 'shared.txt'), 'utf8'),
    );
    expect(readFileSync(join(repo, 'dir/keep.txt'), 'utf8')).toBe(
      'feature keep\n',
    );
    expect(sb.git(repo, ['ls-files', '-u'])).toBe(
      sb.git(twin, ['ls-files', '-u']),
    );
    expect(sb.git(repo, ['status', '--porcelain'])).toBe(
      sb.git(twin, ['status', '--porcelain']),
    );
    expect(readFileSync(join(repo, '.git/MERGE_HEAD'), 'utf8')).toBe(
      readFileSync(join(twin, '.git/MERGE_HEAD'), 'utf8'),
    );
    expect(readFileSync(join(repo, '.git/MERGE_MSG'), 'utf8')).toBe(
      readFileSync(join(twin, '.git/MERGE_MSG'), 'utf8'),
    );

    // Another merge is refused while one is in progress.
    await expect(merge({ fs, dir: repo, theirs: 'feature' })).rejects.toThrow(
      /MERGE_HEAD/,
    );

    // Resolve and conclude.
    write(repo, 'shared.txt', shared.replace('line 10', 'resolved 10'));
    await add({ fs, dir: repo, filepath: ['shared.txt', 'dir/keep.txt'] });
    const oid = await commit({
      fs,
      dir: repo,
      message: 'Merge feature',
      author,
    });
    const parents = sb
      .git(repo, ['rev-list', '--parents', '-1', oid])
      .trim()
      .split(' ');
    expect(parents.slice(1)).toEqual([
      sb.git(repo, ['rev-parse', 'ORIG_HEAD']).trim(),
      sb.git(repo, ['rev-parse', 'feature']).trim(),
    ]);
    expect(existsSync(join(repo, '.git/MERGE_HEAD'))).toBe(false);
    expect(sb.git(repo, ['status', '--porcelain'])).toBe('');
    sb.git(repo, ['fsck', '--strict', '--no-dangling']);
  });

  it('aborts a conflicted merge back to the original state', async () => {
    sb.git(repo, ['checkout', '-q', '-b', 'feature']);
    write(repo, 'shared.txt', 'feature\n');
    write(repo, 'added-by-feature.txt', 'x\n');
    commitAll(repo, 'feature');
    sb.git(repo, ['checkout', '-q', 'main']);
    write(repo, 'shared.txt', 'main\n');
    commitAll(repo, 'main');
    const before = sb.git(repo, ['rev-parse', 'HEAD']);

    await expect(
      merge({ fs, dir: repo, theirs: 'feature', author }),
    ).rejects.toBeInstanceOf(MergeConflictError);
    expect(existsSync(join(repo, 'added-by-feature.txt'))).toBe(true);
    await abortMerge({ fs, dir: repo });
    expect(sb.git(repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(sb.git(repo, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('main\n');
    expect(existsSync(join(repo, 'added-by-feature.txt'))).toBe(false);
    expect(existsSync(join(repo, '.git/MERGE_HEAD'))).toBe(false);
  });

  it('keeps unrelated local edits when aborting, like git merge --abort', async () => {
    sb.git(repo, ['checkout', '-q', '-b', 'feature']);
    write(repo, 'shared.txt', 'feature\n');
    commitAll(repo, 'feature');
    sb.git(repo, ['checkout', '-q', 'main']);
    write(repo, 'shared.txt', 'main\n');
    commitAll(repo, 'main');
    makeTwin();

    await expect(
      merge({ fs, dir: repo, theirs: 'feature', author }),
    ).rejects.toBeInstanceOf(MergeConflictError);
    try {
      sb.git(twin, ['merge', '--no-edit', 'feature']);
    } catch {
      // expected: conflict
    }
    for (const d of [repo, twin])
      write(d, 'dir/keep.txt', 'my precious local edit\n');

    await abortMerge({ fs, dir: repo });
    sb.git(twin, ['merge', '--abort']);

    expect(readFileSync(join(repo, 'dir/keep.txt'), 'utf8')).toBe(
      'my precious local edit\n',
    );
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('main\n');
    expect(sb.git(repo, ['status', '--porcelain'])).toBe(
      sb.git(twin, ['status', '--porcelain']),
    );
  });

  it('reset and checkout abandon a merge in progress like git', async () => {
    sb.git(repo, ['checkout', '-q', '-b', 'feature']);
    write(repo, 'shared.txt', 'feature\n');
    commitAll(repo, 'feature');
    sb.git(repo, ['checkout', '-q', 'main']);
    write(repo, 'shared.txt', 'main\n');
    commitAll(repo, 'main');
    const conflict = () =>
      expect(
        merge({ fs, dir: repo, theirs: 'feature', author }),
      ).rejects.toBeInstanceOf(MergeConflictError);

    await conflict();
    await expect(reset({ fs, dir: repo, mode: 'soft' })).rejects.toThrow(
      /middle of a merge/,
    );
    await reset({ fs, dir: repo, mode: 'hard' });
    expect(existsSync(join(repo, '.git/MERGE_HEAD'))).toBe(false);
    write(repo, 'after.txt', 'x\n');
    await add({ fs, dir: repo, filepath: 'after.txt' });
    const oid = await commit({ fs, dir: repo, message: 'after reset', author });
    expect(
      sb.git(repo, ['rev-list', '--parents', '-1', oid]).trim().split(' '),
    ).toHaveLength(2);

    await conflict();
    await reset({ fs, dir: repo, mode: 'mixed' });
    expect(existsSync(join(repo, '.git/MERGE_HEAD'))).toBe(false);
    await reset({ fs, dir: repo, mode: 'hard' });

    await conflict();
    write(repo, 'shared.txt', 'resolved\n');
    await add({ fs, dir: repo, filepath: 'shared.txt' });
    await checkoutBranch({ fs, dir: repo, ref: 'feature', force: true });
    expect(existsSync(join(repo, '.git/MERGE_HEAD'))).toBe(false);
  });

  it('refuses to merge over staged or conflicting local changes', async () => {
    sb.git(repo, ['checkout', '-q', '-b', 'feature']);
    write(repo, 'dir/keep.txt', 'feature\n');
    commitAll(repo, 'feature');
    sb.git(repo, ['checkout', '-q', 'main']);
    write(repo, 'main.txt', 'main\n');
    commitAll(repo, 'main');

    write(repo, 'staged.txt', 'staged\n');
    sb.git(repo, ['add', 'staged.txt']);
    await expect(
      merge({ fs, dir: repo, theirs: 'feature', author }),
    ).rejects.toBeInstanceOf(UncommittedChangesError);
    sb.git(repo, ['reset', '-q', 'staged.txt']);

    // A staged mode-only change counts as a local change too.
    sb.git(repo, ['update-index', '--chmod=+x', 'main.txt']);
    await expect(
      merge({ fs, dir: repo, theirs: 'feature', author }),
    ).rejects.toBeInstanceOf(UncommittedChangesError);
    sb.git(repo, ['update-index', '--chmod=-x', 'main.txt']);

    write(repo, 'dir/keep.txt', 'local edit\n');
    await expect(
      merge({ fs, dir: repo, theirs: 'feature', author }),
    ).rejects.toBeInstanceOf(CheckoutConflictError);
    expect(readFileSync(join(repo, 'dir/keep.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(sb.git(repo, ['log', '-1', '--format=%s'])).toBe('main\n');
  });

  it('honours fastForward: only / never', async () => {
    sb.git(repo, ['checkout', '-q', '-b', 'feature']);
    write(repo, 'f.txt', 'f\n');
    commitAll(repo, 'feature');
    sb.git(repo, ['checkout', '-q', 'main']);

    const noff = await merge({
      fs,
      dir: repo,
      theirs: 'feature',
      fastForward: 'never',
      author,
    });
    expect(noff.type).toBe('merge');
    expect(sb.git(repo, ['log', '-1', '--format=%s'])).toBe(
      "Merge branch 'feature'\n",
    );

    sb.git(repo, ['checkout', '-q', '-b', 'other', 'HEAD~1']);
    write(repo, 'o.txt', 'o\n');
    commitAll(repo, 'other');
    await expect(
      merge({ fs, dir: repo, theirs: 'main', fastForward: 'only' }),
    ).rejects.toBeInstanceOf(NonFastForwardError);
  });
});

describe('clone and pull over smart HTTP', () => {
  let sb: GitSandbox;
  let server: GitHttpServer;
  let projects: string;
  let bare: string;
  let work: string;

  const commitInWork = (file: string, content: string, msg: string) => {
    mkdirSync(join(work, file, '..'), { recursive: true });
    writeFileSync(join(work, file), content);
    sb.git(work, ['add', file]);
    sb.git(work, ['commit', '-q', '-m', msg]);
  };

  beforeEach(async () => {
    sb = createSandbox();
    projects = join(sb.root, 'srv');
    bare = join(projects, 'repo.git');
    work = join(sb.root, 'work');
    mkdirSync(projects);
    sb.git(sb.root, ['init', '-q', '--bare', '-b', 'trunk', bare]);
    sb.git(sb.root, ['init', '-q', '-b', 'trunk', work]);
    sb.git(work, ['remote', 'add', 'origin', bare]);
    commitInWork('README.md', '# readme\n', 'initial');
    commitInWork('src/app.ts', 'export {};\n', 'app');
    writeFileSync(join(work, 'run.sh'), '#!/bin/sh\necho hi\n', {
      mode: 0o755,
    });
    sb.git(work, ['add', 'run.sh']);
    sb.git(work, ['commit', '-q', '-m', 'script']);
    sb.git(work, ['tag', '-a', 'v1', '-m', 'v1']);
    sb.git(work, ['branch', 'dev']);
    sb.git(work, ['push', '-q', 'origin', 'trunk', 'dev', 'v1']);
    server = await startGitHttpServer(projects, sb.root);
  });
  afterEach(async () => {
    await server.close();
    sb.cleanup();
  });

  it('clones like git clone', async () => {
    const url = `${server.url}/repo.git`;
    const dir = join(sb.root, 'ours');
    const ref = join(sb.root, 'theirs');
    const res = await clone({ fs, dir, url });
    await sb.gitAsync(sb.root, ['clone', '-q', url, ref]);

    expect(res.branch).toBe('trunk');
    const refsOf = (d: string) =>
      sb.git(d, [
        'for-each-ref',
        '--format=%(objectname) %(refname) %(symref)',
      ]);
    expect(refsOf(dir)).toBe(refsOf(ref));
    expect(sb.git(dir, ['symbolic-ref', 'HEAD'])).toBe(
      sb.git(ref, ['symbolic-ref', 'HEAD']),
    );
    expect(sb.git(dir, ['config', '--get-regexp', '^(remote|branch)\\.'])).toBe(
      sb.git(ref, ['config', '--get-regexp', '^(remote|branch)\\.']),
    );
    expect(sb.git(dir, ['ls-files', '-s'])).toBe(
      sb.git(ref, ['ls-files', '-s']),
    );
    expect(sb.git(dir, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toBe('export {};\n');
    sb.git(dir, ['fsck', '--strict', '--no-dangling']);
  });

  it('clones a specific branch, single-branch, or a tag', async () => {
    const url = `${server.url}/repo.git`;
    const a = await clone({
      fs,
      dir: join(sb.root, 'a'),
      url,
      ref: 'dev',
      singleBranch: true,
    });
    expect(a.branch).toBe('dev');
    expect(
      sb.git(join(sb.root, 'a'), [
        'config',
        '--get-all',
        'remote.origin.fetch',
      ]),
    ).toBe('+refs/heads/dev:refs/remotes/origin/dev\n');
    expect(
      sb.git(join(sb.root, 'a'), [
        'for-each-ref',
        '--format=%(refname)',
        'refs/remotes',
      ]),
    ).not.toContain('trunk');

    const t = await clone({ fs, dir: join(sb.root, 't'), url, ref: 'v1' });
    expect(t.branch).toBeNull();
    expect(sb.git(join(sb.root, 't'), ['rev-parse', 'HEAD'])).toBe(
      sb.git(work, ['rev-parse', 'v1^{commit}']),
    );
  });

  it('clones an empty repository', async () => {
    sb.git(sb.root, ['init', '-q', '--bare', join(projects, 'empty.git')]);
    const res = await clone({
      fs,
      dir: join(sb.root, 'e'),
      url: `${server.url}/empty.git`,
    });
    expect(res.head).toBeNull();
    expect(existsSync(join(sb.root, 'e/.git/HEAD'))).toBe(true);
  });

  it('refuses to clone into a non-empty directory', async () => {
    const dir = join(sb.root, 'busy');
    mkdirSync(dir);
    writeFileSync(join(dir, 'x'), 'x');
    await expect(
      clone({ fs, dir, url: `${server.url}/repo.git` }),
    ).rejects.toThrow(/not an empty directory/);
  });

  it('pulls fast-forward and divergent changes like git pull', async () => {
    const url = `${server.url}/repo.git`;
    const dir = join(sb.root, 'ours');
    const ref = join(sb.root, 'theirs');
    await clone({ fs, dir, url });
    await sb.gitAsync(sb.root, ['clone', '-q', url, ref]);

    commitInWork('README.md', '# readme v2\n', 'remote update');
    sb.git(work, ['push', '-q', 'origin', 'trunk']);
    const ff = await pull({ fs, dir, author });
    expect(ff.merge.type).toBe('fast-forward');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# readme v2\n');
    expect(sb.git(dir, ['status', '--porcelain'])).toBe('');

    // Diverge: local commit + remote commit, then pull creates a merge.
    await sb.gitAsync(ref, ['pull', '-q', '--no-rebase']);
    for (const d of [dir, ref]) {
      writeFileSync(join(d, 'local.txt'), 'local\n');
      sb.git(d, ['add', 'local.txt']);
      sb.git(d, [
        '-c',
        `user.name=${author.name}`,
        '-c',
        `user.email=${author.email}`,
        'commit',
        '-q',
        '-m',
        'local',
      ]);
    }
    commitInWork('src/app.ts', 'export const v = 2;\n', 'remote again');
    sb.git(work, ['push', '-q', 'origin', 'trunk']);

    await expect(pull({ fs, dir, fastForward: 'only' })).rejects.toBeInstanceOf(
      NonFastForwardError,
    );
    const merged = await pull({ fs, dir, author });
    expect(merged.merge.type).toBe('merge');
    await sb.gitAsync(ref, [
      '-c',
      `user.name=${author.name}`,
      '-c',
      `user.email=${author.email}`,
      'pull',
      '-q',
      '--no-rebase',
      '--no-edit',
    ]);
    expect(sb.git(dir, ['log', '-1', '--format=%B'])).toBe(
      sb.git(ref, ['log', '-1', '--format=%B']),
    );
    expect(sb.git(dir, ['rev-parse', 'HEAD^{tree}'])).toBe(
      sb.git(ref, ['rev-parse', 'HEAD^{tree}']),
    );
    expect(sb.git(dir, ['status', '--porcelain'])).toBe('');
    sb.git(dir, ['fsck', '--strict', '--no-dangling']);
  });
});
