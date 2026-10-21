import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { NodeFSAdapter } from '../../fs/node-adapter.js';
import { init } from '../../commands/init.js';
import { addRemote } from '../../commands/remote.js';
import { fetch } from '../../commands/fetch.js';
import { push } from '../../commands/push.js';
import { PushRejectedError, HttpError } from '../../errors.js';
import { readConfig, getConfigValue } from '../../core/config.js';
import { createSandbox, type GitSandbox } from './git-helpers.js';
import { startGitHttpServer, type GitHttpServer } from './http-server.js';

function lsRemote(sb: GitSandbox, bare: string): Map<string, string> {
  const out = sb.git(bare, [
    'for-each-ref',
    '--format=%(objectname) %(refname)',
  ]);
  const m = new Map<string, string>();
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [oid, name] = line.split(' ');
    m.set(name, oid);
  }
  return m;
}

function localRefs(
  sb: GitSandbox,
  repo: string,
  pattern: string,
): Map<string, string> {
  const out = sb.git(repo, [
    'for-each-ref',
    '--format=%(objectname) %(refname)',
    pattern,
  ]);
  const m = new Map<string, string>();
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [oid, name] = line.split(' ');
    m.set(name, oid);
  }
  return m;
}

describe('fetch/push over smart HTTP (git http-backend)', () => {
  let sb: GitSandbox;
  let server: GitHttpServer;
  let projects: string;
  let bare: string;
  let work: string;
  let local: string;
  const fs = new NodeFSAdapter();

  const commitInWork = (file: string, content: string, msg: string) => {
    writeFileSync(join(work, file), content);
    sb.git(work, ['add', file]);
    sb.git(work, ['commit', '-q', '-m', msg]);
  };

  beforeEach(async () => {
    sb = createSandbox();
    projects = join(sb.root, 'srv');
    bare = join(projects, 'remote.git');
    work = join(sb.root, 'work');
    local = join(sb.root, 'local');
    mkdirSync(projects);
    sb.git(sb.root, ['init', '-q', '--bare', '-b', 'main', bare]);
    sb.git(sb.root, ['init', '-q', '-b', 'main', work]);
    sb.git(work, ['remote', 'add', 'origin', bare]);
    commitInWork('README.md', '# hello\n', 'initial');
    mkdirSync(join(work, 'src'));
    commitInWork('src/index.ts', 'export const x = 1;\n', 'add src');
    sb.git(work, ['tag', '-a', 'v1.0', '-m', 'release 1.0']);
    sb.git(work, ['checkout', '-q', '-b', 'feature/nested']);
    commitInWork('feature.txt', 'feature\n', 'feature work');
    sb.git(work, ['tag', 'light']);
    sb.git(work, ['checkout', '-q', 'main']);
    sb.git(work, [
      'push',
      '-q',
      'origin',
      'main',
      'feature/nested',
      'v1.0',
      'light',
    ]);

    server = await startGitHttpServer(projects, sb.root);
    mkdirSync(local);
    await init({ fs, dir: local, defaultBranch: 'main' });
    await addRemote({
      fs,
      dir: local,
      name: 'origin',
      url: `${server.url}/remote.git`,
    });
  });

  afterEach(async () => {
    await server.close();
    sb.cleanup();
  });

  it('fetches all branches into remote-tracking refs and follows tags', async () => {
    const result = await fetch({ fs, dir: local });
    const remote = lsRemote(sb, bare);

    expect(result.remoteHead).toBe('refs/heads/main');
    expect(result.objectCount).toBeGreaterThan(0);
    expect(localRefs(sb, local, 'refs/remotes')).toEqual(
      new Map([
        [
          'refs/remotes/origin/feature/nested',
          remote.get('refs/heads/feature/nested'),
        ],
        ['refs/remotes/origin/main', remote.get('refs/heads/main')],
      ]),
    );
    expect(localRefs(sb, local, 'refs/tags')).toEqual(
      new Map([
        ['refs/tags/light', remote.get('refs/tags/light')],
        ['refs/tags/v1.0', remote.get('refs/tags/v1.0')],
      ]),
    );
    expect(result.updates.every((u) => u.status === 'new')).toBe(true);
    sb.git(local, ['fsck', '--strict', '--no-dangling']);
    expect(sb.git(local, ['log', '--format=%s', 'origin/main'])).toBe(
      'add src\ninitial\n',
    );
  });

  it('writes FETCH_HEAD in the same format as git', async () => {
    // Reference: canonical git fetching into an identical repo.
    const ref = join(sb.root, 'ref');
    sb.git(sb.root, ['init', '-q', '-b', 'main', ref]);
    const url = `${server.url}/remote.git`;
    sb.git(ref, ['remote', 'add', 'origin', url]);
    sb.git(ref, ['config', 'branch.main.remote', 'origin']);
    sb.git(ref, ['config', 'branch.main.merge', 'refs/heads/main']);
    await sb.gitAsync(ref, ['fetch', '-q', 'origin']);

    writeFileSync(
      join(local, '.git', 'config'),
      readFileSync(join(local, '.git', 'config'), 'utf8') +
        '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
    );
    await fetch({ fs, dir: local });

    const sortLines = (s: string) => s.trim().split('\n').sort();
    expect(
      sortLines(readFileSync(join(local, '.git/FETCH_HEAD'), 'utf8')),
    ).toEqual(sortLines(readFileSync(join(ref, '.git/FETCH_HEAD'), 'utf8')));
  });

  it('fetches incrementally and reports fast-forwards', async () => {
    await fetch({ fs, dir: local });
    commitInWork('README.md', '# hello again\n', 'second');
    sb.git(work, ['push', '-q', 'origin', 'main']);

    const result = await fetch({ fs, dir: local });
    const main = result.updates.find(
      (u) => u.localRef === 'refs/remotes/origin/main',
    );
    expect(main?.status).toBe('fast-forward');
    // Only the new commit, its tree and the changed blob.
    expect(result.objectCount).toBe(3);
    expect(
      result.updates.filter((u) => u.status === 'up-to-date').length,
    ).toBeGreaterThan(0);
    sb.git(local, ['fsck', '--strict', '--no-dangling']);

    const again = await fetch({ fs, dir: local });
    expect(again.objectCount).toBe(0);
    expect(again.updates.every((u) => u.status === 'up-to-date')).toBe(true);
  });

  it('force-updates rewritten branches and prunes deleted ones', async () => {
    await fetch({ fs, dir: local });
    sb.git(work, ['reset', '-q', '--hard', 'HEAD~1']);
    commitInWork('other.txt', 'rewritten\n', 'rewrite');
    sb.git(work, ['push', '-q', '-f', 'origin', 'main']);
    sb.git(work, ['push', '-q', 'origin', '--delete', 'feature/nested']);

    const result = await fetch({ fs, dir: local, prune: true });
    expect(
      result.updates.find((u) => u.localRef === 'refs/remotes/origin/main')
        ?.status,
    ).toBe('forced');
    expect(
      result.updates.find(
        (u) => u.localRef === 'refs/remotes/origin/feature/nested',
      )?.status,
    ).toBe('pruned');
    expect(
      localRefs(sb, local, 'refs/remotes').has(
        'refs/remotes/origin/feature/nested',
      ),
    ).toBe(false);
  });

  it('rejects non-fast-forward updates without a + refspec', async () => {
    await fetch({
      fs,
      dir: local,
      refspecs: ['refs/heads/main:refs/remotes/origin/main'],
    });
    sb.git(work, ['reset', '-q', '--hard', 'HEAD~1']);
    commitInWork('other.txt', 'rewritten\n', 'rewrite');
    sb.git(work, ['push', '-q', '-f', 'origin', 'main']);
    const result = await fetch({
      fs,
      dir: local,
      refspecs: ['refs/heads/main:refs/remotes/origin/main'],
    });
    const u = result.updates.find(
      (x) => x.localRef === 'refs/remotes/origin/main',
    );
    expect(u?.status).toBe('rejected');
    expect(u?.reason).toBe('non-fast-forward');
  });

  it('fetches a single branch by short name into FETCH_HEAD', async () => {
    const result = await fetch({
      fs,
      dir: local,
      refspecs: ['feature/nested'],
      tags: false,
    });
    expect(result.fetchHead[0]).toMatchObject({
      remoteRef: 'refs/heads/feature/nested',
      notForMerge: false,
    });
    // Remote-tracking ref is updated opportunistically.
    expect(
      localRefs(sb, local, 'refs/remotes').has(
        'refs/remotes/origin/feature/nested',
      ),
    ).toBe(true);
    expect(localRefs(sb, local, 'refs/tags').size).toBe(0);
  });

  it('fetches from an empty repository', async () => {
    sb.git(sb.root, ['init', '-q', '--bare', join(projects, 'empty.git')]);
    await addRemote({
      fs,
      dir: local,
      name: 'empty',
      url: `${server.url}/empty.git`,
    });
    const result = await fetch({ fs, dir: local, remote: 'empty' });
    expect(result.updates).toEqual([]);
    expect(result.objectCount).toBe(0);
  });

  it('pushes new commits that canonical git accepts', async () => {
    await fetch({ fs, dir: local });
    // Build on origin/main locally with canonical git, then push with ts-git.
    sb.git(local, ['checkout', '-q', '-b', 'main', 'origin/main']);
    writeFileSync(join(local, 'new.txt'), 'pushed by ts-git\n');
    sb.git(local, ['add', 'new.txt']);
    sb.git(local, ['commit', '-q', '-m', 'from local']);
    const head = sb.git(local, ['rev-parse', 'HEAD']).trim();

    const result = await push({ fs, dir: local, setUpstream: true });
    expect(result.refs).toEqual([
      expect.objectContaining({
        ref: 'refs/heads/main',
        newOid: head,
        status: 'fast-forward',
      }),
    ]);
    expect(lsRemote(sb, bare).get('refs/heads/main')).toBe(head);
    sb.git(bare, ['fsck', '--strict', '--no-dangling']);
    // Remote-tracking ref and upstream config updated.
    expect(
      localRefs(sb, local, 'refs/remotes').get('refs/remotes/origin/main'),
    ).toBe(head);
    const config = await readConfig(fs, join(local, '.git'));
    expect(getConfigValue(config, 'branch', 'merge', 'main')).toBe(
      'refs/heads/main',
    );
    expect(getConfigValue(config, 'branch', 'remote', 'main')).toBe('origin');
  });

  it('pushes a brand new branch and a tag, then deletes the branch', async () => {
    await fetch({ fs, dir: local });
    sb.git(local, ['checkout', '-q', '-b', 'topic', 'origin/main']);
    writeFileSync(join(local, 'topic.txt'), 'topic\n');
    sb.git(local, ['add', '.']);
    sb.git(local, ['commit', '-q', '-m', 'topic']);
    sb.git(local, ['tag', '-a', 'v2.0', '-m', 'two']);

    const result = await push({ fs, dir: local, refspecs: ['topic', 'v2.0'] });
    expect(result.refs.map((r) => [r.ref, r.status])).toEqual([
      ['refs/heads/topic', 'new'],
      ['refs/tags/v2.0', 'new'],
    ]);
    const remote = lsRemote(sb, bare);
    expect(remote.get('refs/heads/topic')).toBe(
      sb.git(local, ['rev-parse', 'topic']).trim(),
    );
    expect(remote.get('refs/tags/v2.0')).toBe(
      sb.git(local, ['rev-parse', 'v2.0']).trim(),
    );
    sb.git(bare, ['fsck', '--strict', '--no-dangling']);

    const del = await push({ fs, dir: local, refspecs: [':topic'] });
    expect(del.refs[0]).toMatchObject({
      ref: 'refs/heads/topic',
      status: 'deleted',
    });
    expect(lsRemote(sb, bare).has('refs/heads/topic')).toBe(false);
    expect(
      localRefs(sb, local, 'refs/remotes').has('refs/remotes/origin/topic'),
    ).toBe(false);
  });

  it('rejects non-fast-forward pushes unless forced', async () => {
    await fetch({ fs, dir: local });
    sb.git(local, ['checkout', '-q', '-b', 'main', 'origin/main~1']);
    writeFileSync(join(local, 'diverge.txt'), 'diverged\n');
    sb.git(local, ['add', '.']);
    sb.git(local, ['commit', '-q', '-m', 'diverge']);

    const err = await push({ fs, dir: local, refspecs: ['main'] }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PushRejectedError);
    expect((err as PushRejectedError).refs[0]).toMatchObject({
      status: 'rejected',
      reason: 'non-fast-forward',
    });

    const forced = await push({ fs, dir: local, refspecs: ['+main'] });
    expect(forced.refs[0].status).toBe('forced');
    expect(lsRemote(sb, bare).get('refs/heads/main')).toBe(
      sb.git(local, ['rev-parse', 'HEAD']).trim(),
    );
  });

  it('rejects pushes when the remote has commits we have never fetched', async () => {
    await fetch({ fs, dir: local });
    sb.git(local, ['checkout', '-q', '-b', 'main', 'origin/main']);
    commitInWork('README.md', 'remote moved on\n', 'remote only');
    sb.git(work, ['push', '-q', 'origin', 'main']);
    writeFileSync(join(local, 'x.txt'), 'x\n');
    sb.git(local, ['add', '.']);
    sb.git(local, ['commit', '-q', '-m', 'local']);
    const err = await push({ fs, dir: local, refspecs: ['main'] }).catch(
      (e) => e,
    );
    expect((err as PushRejectedError).refs[0].reason).toBe('fetch first');
  });

  it('uses onAuth for servers that require credentials', async () => {
    await server.close();
    server = await startGitHttpServer(projects, sb.root, {
      basicAuth: { username: 'alice', password: 's3cret' },
    });
    const url = `${server.url}/remote.git`;

    const denied = await fetch({ fs, dir: local, remote: url }).catch((e) => e);
    expect(denied).toBeInstanceOf(HttpError);
    expect((denied as HttpError).statusCode).toBe(401);

    let asked = 0;
    const result = await fetch({
      fs,
      dir: local,
      remote: url,
      onAuth: () => {
        asked++;
        return { username: 'alice', password: 's3cret' };
      },
    });
    expect(asked).toBe(1);
    expect(result.fetchHead[0].remoteRef).toBe('HEAD');

    // Credentials embedded in the URL work as well.
    const embedded = url.replace('http://', 'http://alice:s3cret@');
    await expect(
      fetch({ fs, dir: local, remote: embedded }),
    ).resolves.toBeTruthy();
  });
});
