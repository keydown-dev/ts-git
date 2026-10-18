import { describe, it, expect, afterEach } from 'vitest';
import * as nodefs from 'fs';
import * as path from 'path';
import {
  diff,
  formatPatch,
  formatNameOnly,
  formatNameStatus,
  formatStat,
  resolveDiffSpecs,
} from '../../commands/diff/index.js';
import type { DiffSide, LineDiffAlgorithm, LineDiffEdit } from '../../types.js';
import { createGitSandbox, gitCommitAll, type GitSandbox } from './git-env.js';

/**
 * LCS line diff (O(n*m)); with the unique-line fixtures used here it yields
 * the same edit script as git's Myers implementation.
 */
const lcsLineDiff: LineDiffAlgorithm = (a, b) => {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const edits: LineDiffEdit[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      edits.push({ type: ' ', oldIndex: i, newIndex: j, content: a[i] });
      i++;
      j++;
    } else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) {
      edits.push({ type: '-', oldIndex: i, newIndex: -1, content: a[i] });
      i++;
    } else {
      edits.push({ type: '+', oldIndex: -1, newIndex: j, content: b[j] });
      j++;
    }
  }
  return edits;
};

const GIT_DIFF_FLAGS = ['--no-renames', '--no-ext-diff', '--no-color'];

type Spec =
  | { kind: 'worktree' }
  | { kind: 'cached' }
  | { kind: 'commit-worktree'; rev: string }
  | { kind: 'commits'; specs: string[] };

function gitArgsFor(spec: Spec): string[] {
  switch (spec.kind) {
    case 'worktree':
      return [];
    case 'cached':
      return ['--cached'];
    case 'commit-worktree':
      return [spec.rev];
    case 'commits':
      return spec.specs;
  }
}

async function tsDiff(
  sb: GitSandbox,
  spec: Spec,
  extra: { contextLines?: number; paths?: string[] } = {},
) {
  let left: DiffSide | undefined;
  let right: DiffSide | undefined;
  if (spec.kind === 'commit-worktree' || spec.kind === 'commits') {
    const specs = spec.kind === 'commits' ? spec.specs : [spec.rev];
    const r = await resolveDiffSpecs(sb.fs, sb.gitdir, specs);
    left = r!.left;
    right = r!.right;
  }
  return diff({
    fs: sb.fs,
    dir: sb.dir,
    cached: spec.kind === 'cached',
    left,
    right,
    lineDiffAlgorithm: lcsLineDiff,
    ...extra,
  });
}

async function expectAllFormatsMatch(
  sb: GitSandbox,
  spec: Spec,
  label: string,
) {
  const args = gitArgsFor(spec);
  const result = await tsDiff(sb, spec);
  expect(formatPatch(result), `${label}: patch`).toBe(
    sb.git(['diff', ...GIT_DIFF_FLAGS, ...args]),
  );
  expect(
    formatNameOnly(result) + (result.deltas.length ? '\n' : ''),
    `${label}: --name-only`,
  ).toBe(sb.git(['diff', ...GIT_DIFF_FLAGS, '--name-only', ...args]));
  expect(
    formatNameStatus(result) + (result.deltas.length ? '\n' : ''),
    `${label}: --name-status`,
  ).toBe(sb.git(['diff', ...GIT_DIFF_FLAGS, '--name-status', ...args]));
  expect(formatStat(result), `${label}: --stat`).toBe(
    sb.git(['diff', ...GIT_DIFF_FLAGS, '--stat', ...args]),
  );
}

function numbered(prefix: string, count: number, from = 1): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} line ${i + from}`);
}

/** C-like source so the default funcname rule has something to find. */
function source(variant: Record<number, string> = {}): string {
  const out: string[] = [];
  for (let f = 1; f <= 4; f++) {
    out.push(`int function_${f}(void)   `); // trailing spaces are stripped
    out.push('{');
    for (let k = 1; k <= 12; k++) {
      const n = f * 100 + k;
      out.push(variant[n] ?? `    statement_${n}();`);
    }
    out.push('}');
    out.push('');
  }
  out.push(
    'static const char *a_very_long_function_name_that_goes_beyond_eighty_columns_for_sure(int argument)',
  );
  for (let k = 1; k <= 8; k++) out.push(`    tail_${k}();`);
  return out.join('\n') + '\n';
}

function chmod(sb: GitSandbox, p: string, mode: number) {
  nodefs.chmodSync(path.join(sb.dir, p), mode);
}

describe('diff output vs git diff (exact)', () => {
  let sb: GitSandbox;
  afterEach(() => sb?.cleanup());

  it('modifications: hunks, context merging, funcname, no-newline-at-EOF', async () => {
    sb = createGitSandbox();
    sb.write('src.c', source());
    sb.write('gap6.txt', numbered('g', 30).join('\n') + '\n');
    sb.write('gap7.txt', numbered('h', 30).join('\n') + '\n');
    sb.write('eof-add-nl.txt', 'one\ntwo');
    sb.write('eof-del-nl.txt', 'one\ntwo\n');
    sb.write('eof-mod.txt', 'one\ntwo');
    sb.write('first-line.txt', numbered('f', 10).join('\n') + '\n');
    gitCommitAll(sb, 'base');

    sb.write(
      'src.c',
      source({
        103: '    changed_103();',
        112: '    changed_112();',
        307: '    x();',
        402: '',
      }) + '    appended();\n',
    );
    const g6 = numbered('g', 30);
    g6[5] = 'changed A';
    g6[12] = 'changed B'; // 6 unchanged lines between -> one hunk
    sb.write('gap6.txt', g6.join('\n') + '\n');
    const g7 = numbered('h', 30);
    g7[5] = 'changed A';
    g7[13] = 'changed B'; // 7 unchanged lines between -> two hunks
    sb.write('gap7.txt', g7.join('\n') + '\n');
    sb.write('eof-add-nl.txt', 'one\ntwo\n');
    sb.write('eof-del-nl.txt', 'one\ntwo');
    sb.write('eof-mod.txt', 'one\nTWO');
    const f = numbered('f', 10);
    f[0] = 'new first';
    sb.write('first-line.txt', f.join('\n') + '\n');

    await expectAllFormatsMatch(sb, { kind: 'worktree' }, 'worktree');
    sb.git(['add', '-A']);
    await expectAllFormatsMatch(sb, { kind: 'cached' }, 'cached');
    await expectAllFormatsMatch(
      sb,
      { kind: 'commit-worktree', rev: 'HEAD' },
      'HEAD',
    );

    for (const ctx of [0, 1, 5]) {
      const result = await tsDiff(
        sb,
        { kind: 'cached' },
        { contextLines: ctx },
      );
      expect(formatPatch(result), `-U${ctx}`).toBe(
        sb.git(['diff', ...GIT_DIFF_FLAGS, `-U${ctx}`, '--cached']),
      );
    }
  });

  it('adds, deletes, empty files, binary files, renames as delete+add', async () => {
    sb = createGitSandbox();
    sb.write('keep.txt', 'keep\n');
    sb.write('delete-me.txt', 'bye\nbye\n');
    sb.write('empty-delete.txt', '');
    sb.write('bin-mod.dat', Buffer.from([0, 1, 2, 3]));
    sb.write('bin-del.dat', Buffer.from([9, 0, 9]));
    sb.write('old-name.txt', 'rename me\n');
    sb.write('to-binary.txt', 'text\n');
    sb.write('del sp.txt', 'gone\n');
    gitCommitAll(sb, 'base');

    sb.rm('delete-me.txt');
    sb.rm('empty-delete.txt');
    sb.write('new.txt', 'hello\nworld\n');
    sb.write('new-no-eol.txt', 'x');
    sb.write('new sp.txt', 'spaced\n');
    sb.rm('del sp.txt');
    sb.write('empty-new.txt', '');
    sb.write('bin-mod.dat', Buffer.from([0, 1, 2, 3, 4, 5]));
    sb.rm('bin-del.dat');
    sb.write('bin-new.dat', Buffer.from([0, 0, 0]));
    sb.write('to-binary.txt', Buffer.from([0, 116, 0]));
    sb.git(['mv', 'old-name.txt', 'new-name.txt']);
    sb.git(['add', '-A']);
    await expectAllFormatsMatch(sb, { kind: 'cached' }, 'cached');
    const base = sb.git(['rev-parse', 'HEAD']).trim();
    gitCommitAll(sb, 'second');
    await expectAllFormatsMatch(
      sb,
      { kind: 'commits', specs: [base, 'HEAD'] },
      'A B',
    );
    await expectAllFormatsMatch(
      sb,
      { kind: 'commits', specs: [`${base}..HEAD`] },
      'A..B',
    );
    await expectAllFormatsMatch(
      sb,
      { kind: 'commits', specs: ['HEAD', base] },
      'B A',
    );
  });

  it('mode changes, symlinks and type changes', async () => {
    sb = createGitSandbox();
    sb.write('mode-only.sh', 'echo\n');
    sb.write('mode-and-content.sh', 'echo 1\n');
    sb.write('exec-off.sh', 'echo\n');
    chmod(sb, 'exec-off.sh', 0o755);
    sb.write('becomes-link.txt', 'plain\n');
    nodefs.symlinkSync('keep-target', path.join(sb.dir, 'link'));
    gitCommitAll(sb, 'base');

    chmod(sb, 'mode-only.sh', 0o755);
    sb.write('mode-and-content.sh', 'echo 2\n');
    chmod(sb, 'mode-and-content.sh', 0o755);
    chmod(sb, 'exec-off.sh', 0o644);
    sb.rm('becomes-link.txt');
    nodefs.symlinkSync('link-target', path.join(sb.dir, 'becomes-link.txt'));
    sb.rm('link');
    nodefs.symlinkSync('other-target', path.join(sb.dir, 'link'));
    nodefs.symlinkSync('new-target', path.join(sb.dir, 'new-link'));
    sb.git(['add', 'new-link']);

    await expectAllFormatsMatch(sb, { kind: 'worktree' }, 'worktree');
    sb.git(['add', '-A']);
    await expectAllFormatsMatch(sb, { kind: 'cached' }, 'cached');

    // core.filemode=false: worktree exec-bit changes are invisible.
    sb.git(['reset', '-q']);
    sb.git(['config', 'core.filemode', 'false']);
    await expectAllFormatsMatch(sb, { kind: 'worktree' }, 'filemode=false');
  });

  it('quoted paths, nested directories and path filters', async () => {
    sb = createGitSandbox();
    const names = [
      'tab\tname.txt',
      'quote"name.txt',
      'sp ace.txt',
      'ファイル.txt',
      'dir/sub/deep.txt',
      'dir/other.txt',
      'a-b',
      'a/b',
      'a.b',
    ];
    for (const n of names) sb.write(n, `${n}\nv1\n`);
    gitCommitAll(sb, 'base');
    for (const n of names) sb.write(n, `${n}\nv2\n`);
    await expectAllFormatsMatch(sb, { kind: 'worktree' }, 'worktree');

    for (const paths of [['dir'], ['dir/sub'], ['a'], ['a-b', 'sp ace.txt']]) {
      const result = await tsDiff(sb, { kind: 'worktree' }, { paths });
      expect(formatPatch(result), paths.join(',')).toBe(
        sb.git(['diff', ...GIT_DIFF_FLAGS, '--', ...paths]),
      );
    }
  });

  it('--stat scaling and long names', async () => {
    sb = createGitSandbox();
    const long =
      'very/long/directory/name/that/keeps/going/and/going/forever/file-with-a-long-name.txt';
    sb.write(long, numbered('l', 10).join('\n') + '\n');
    sb.write('big.txt', numbered('b', 300).join('\n') + '\n');
    sb.write('small.txt', 'a\nb\n');
    gitCommitAll(sb, 'base');
    sb.write(long, numbered('L', 10).join('\n') + '\n');
    sb.write('big.txt', numbered('B', 250).join('\n') + '\n');
    sb.write('small.txt', 'a\nc\n');
    sb.write('only-adds.txt', numbered('n', 40).join('\n') + '\n');
    sb.git(['add', '-A']);
    await expectAllFormatsMatch(sb, { kind: 'cached' }, 'stat');
  });

  it('A...B diffs from the merge base', async () => {
    sb = createGitSandbox();
    sb.write('f.txt', 'base\n');
    gitCommitAll(sb, 'base');
    sb.git(['checkout', '-q', '-b', 'topic']);
    sb.write('topic.txt', 'topic\n');
    gitCommitAll(sb, 'topic');
    sb.git(['checkout', '-q', 'main']);
    sb.write('f.txt', 'main change\n');
    gitCommitAll(sb, 'main');
    await expectAllFormatsMatch(
      sb,
      { kind: 'commits', specs: ['main...topic'] },
      '...',
    );
    await expectAllFormatsMatch(
      sb,
      { kind: 'commits', specs: ['main..topic'] },
      '..',
    );
    await expectAllFormatsMatch(
      sb,
      { kind: 'commits', specs: ['topic..'] },
      'topic..',
    );
  });

  it('no changes produce empty output', async () => {
    sb = createGitSandbox();
    sb.write('a.txt', 'a\n');
    gitCommitAll(sb, 'base');
    await expectAllFormatsMatch(sb, { kind: 'worktree' }, 'clean');
    await expectAllFormatsMatch(sb, { kind: 'cached' }, 'clean cached');
  });
});
