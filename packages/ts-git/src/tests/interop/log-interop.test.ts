import { describe, it, expect, afterEach } from 'vitest';
import { log } from '../../commands/log.js';
import { invalidatePackCache } from '../../core/packfile.js';
import { createGitSandbox, gitCommitAt, type GitSandbox } from './git-env.js';

async function tsLog(sb: GitSandbox, opts: Record<string, unknown> = {}) {
  return (await log({ fs: sb.fs, dir: sb.dir, ...opts })).map((e) => e.oid);
}

function gitLog(sb: GitSandbox, args: string[] = []): string[] {
  return sb
    .git(['log', '--format=%H', ...args])
    .split('\n')
    .filter(Boolean);
}

/**
 * Branchy history with merges, octopus merge and committer dates that are
 * out of topological order (clock skew), which is where git's date-ordered
 * walk differs from naive first-parent or DFS traversal.
 */
function buildHistory(sb: GitSandbox): void {
  let t = 1700000000;
  const commit = (msg: string, dt = 100) => {
    t += dt;
    sb.write(`${msg}.txt`, `${msg}\n`);
    sb.git(['add', '-A']);
    return gitCommitAt(sb, msg, t);
  };

  commit('root');
  commit('m1');
  sb.git(['checkout', '-q', '-b', 'feature']);
  commit('f1');
  commit('f2');
  sb.git(['checkout', '-q', 'main']);
  commit('m2');
  sb.git(['checkout', '-q', '-b', 'skew']);
  commit('skewed-old', -5000); // older than its parent
  commit('skewed-new', 6000);
  sb.git(['checkout', '-q', 'main']);
  commit('m3');
  t += 100;
  sb.env.GIT_COMMITTER_DATE = `${t} +0000`;
  sb.env.GIT_AUTHOR_DATE = `${t} +0000`;
  sb.git(['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);
  sb.git(['checkout', '-q', '-b', 'o1', 'HEAD~2']);
  commit('o1');
  sb.git(['checkout', '-q', '-b', 'o2', 'main~1']);
  commit('o2');
  sb.git(['checkout', '-q', 'main']);
  t += 100;
  sb.env.GIT_COMMITTER_DATE = `${t} +0000`;
  sb.env.GIT_AUTHOR_DATE = `${t} +0000`;
  sb.gitTry(['merge', '-q', '-m', 'octopus', 'o1', 'o2', 'skew']);
  if (sb.gitTry(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0) {
    // Resolve conflicts on log.txt if any.
    sb.write('log.txt', 'octopus\n');
    sb.git(['add', '-A']);
    gitCommitAt(sb, 'octopus', t);
  }
  // Same-second commits to exercise tie ordering.
  commit('same-a', 0);
  commit('same-b', 0);
  sb.git(['tag', '-a', 'v1', 'HEAD~3', '-m', 'tag']);
}

describe('log vs git log', () => {
  let sb: GitSandbox;
  afterEach(() => sb?.cleanup());

  it('returns [] for an unborn branch', async () => {
    sb = createGitSandbox();
    expect(await tsLog(sb)).toEqual([]);
  });

  it('matches git log order on a history with merges and clock skew', async () => {
    sb = createGitSandbox();
    buildHistory(sb);
    const expected = gitLog(sb);
    expect(expected.length).toBeGreaterThan(10);
    expect(await tsLog(sb)).toEqual(expected);

    for (const ref of [
      'feature',
      'skew',
      'v1',
      'HEAD~1',
      'main~2^2',
      'main~2^4',
      'o2',
    ]) {
      expect(await tsLog(sb, { ref }), ref).toEqual(gitLog(sb, [ref]));
    }
    for (const n of [1, 3, 7]) {
      expect(await tsLog(sb, { depth: n })).toEqual(gitLog(sb, ['-n', `${n}`]));
    }
    expect(await tsLog(sb, { firstParent: true })).toEqual(
      gitLog(sb, ['--first-parent']),
    );
  });

  it('walks from a detached HEAD and from packed objects', async () => {
    sb = createGitSandbox();
    buildHistory(sb);
    sb.git(['checkout', '-q', '--detach', 'feature~1']);
    expect(await tsLog(sb)).toEqual(gitLog(sb));

    sb.git(['checkout', '-q', 'main']);
    sb.git(['gc', '-q', '--aggressive']);
    sb.git(['prune-packed']);
    invalidatePackCache(sb.fs);
    expect(await tsLog(sb)).toEqual(gitLog(sb));
  });

  it('stops at shallow boundaries like git', async () => {
    const src = createGitSandbox();
    try {
      buildHistory(src);
      sb = createGitSandbox({ init: false });
      sb.git([
        'clone',
        '-q',
        '--no-local',
        '--depth',
        '3',
        `file://${src.dir}`,
        '.',
      ]);
      const expected = gitLog(sb);
      expect(expected.length).toBeGreaterThan(0);
      expect(await tsLog(sb)).toEqual(expected);
    } finally {
      src.cleanup();
    }
  });

  it('parses commit metadata identically to git', async () => {
    sb = createGitSandbox();
    buildHistory(sb);
    const fmt = sb
      .git([
        'log',
        '--format=%H%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%P%x00%B%x01',
      ])
      .split('\x01\n')
      .filter((s) => s.trim());
    const entries = await log({ fs: sb.fs, dir: sb.dir });
    expect(entries).toHaveLength(fmt.length);
    fmt.forEach((rec, i) => {
      const [oid, an, ae, at, cn, ce, ct, parents, body] = rec.split('\0');
      const c = entries[i].commit;
      expect(entries[i].oid).toBe(oid);
      expect([
        c.author.name,
        c.author.email,
        String(c.author.timestamp),
      ]).toEqual([an, ae, at]);
      expect([
        c.committer.name,
        c.committer.email,
        String(c.committer.timestamp),
      ]).toEqual([cn, ce, ct]);
      expect(c.parent.join(' ')).toBe(parents);
      expect(c.message).toBe(body);
    });
  });
});
