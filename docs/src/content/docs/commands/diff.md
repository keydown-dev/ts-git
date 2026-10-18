---
title: diff
description: Compare the working tree, index, commits and trees, and format the result like git diff.
---

Compute structured differences between two snapshots of the repository, then optionally format them as a unified patch, a diffstat or a list of names.

## Comparisons

| What you want                       | Git CLI equivalent      | TS-Git call                                                    |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Unstaged changes (index → worktree) | `git diff`              | `git.diff()`                                                   |
| Staged changes (`HEAD` → index)     | `git diff --cached`     | `git.diff({ cached: true })`                                   |
| Commit → worktree                   | `git diff HEAD`         | `git.diff({ left: { type: 'commit', ref: 'HEAD' }, right: { type: 'worktree' } })` |
| Commit → commit                     | `git diff A B`          | `git.diff({ left: { type: 'commit', ref: A }, right: { type: 'commit', ref: B } })` |
| Limit to paths                      | `git diff -- src/`      | `git.diff({ paths: ['src/'] })`                                |

Like `git diff`, worktree comparisons only cover **tracked** files. Untracked files appear in [`status`](/commands/status/), not here.

## GitClient method

```typescript
await git.diff(options?): Promise<DiffResult>
```

| Option              | Type                | Default            | Description                                                |
| ------------------- | ------------------- | ------------------ | ---------------------------------------------------------- |
| `left`              | `DiffSide`          | `{ type: 'index' }`    | "Old" side. Only used when `right` is also given      |
| `right`             | `DiffSide`          | `{ type: 'worktree' }` | "New" side. Only used when `left` is also given       |
| `cached`            | `boolean`           | `false`            | Compare `HEAD` to the index. Takes precedence over `left`/`right` |
| `paths`             | `string[]`          | all paths          | Only include these paths (or paths under these directories) |
| `contextLines`      | `number`            | `3`                | Unchanged lines of context around each hunk                |
| `lineDiffAlgorithm` | `LineDiffAlgorithm` | from constructor   | Overrides the client's algorithm for this call             |

Throws if no line diff algorithm is available from either the call or the constructor.

### DiffSide

```typescript
interface DiffSide {
  type: 'worktree' | 'index' | 'commit' | 'tree';
  ref?: string; // for commit/tree: an OID, a branch name or 'HEAD'
  treeOid?: string; // for commit/tree: a tree (or commit) OID
}
```

### DiffResult

```typescript
interface DiffResult {
  left: DiffSide;
  right: DiffSide;
  deltas: FileDelta[]; // one per changed file
  changed: number; // files changed
  insertions: number; // total added lines
  deletions: number; // total deleted lines
}

interface FileDelta {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';
  oldMode?: string; // e.g. '100644'
  newMode?: string;
  oldOid?: string; // abbreviated blob OIDs
  newOid?: string;
  isBinary?: boolean;
  hunks?: Hunk[];
  addedLines?: number;
  deletedLines?: number;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  context?: string;
  lines: { type: ' ' | '+' | '-'; content: string }[];
}
```

## Line diff algorithm

TS-Git computes hunks with a pluggable `LineDiffAlgorithm`, so it doesn't bundle a diff library. Install the companion Myers implementation:

```bash
npm install @keydown-app/ts-git-diff-myers
```

```typescript
import { myersLineDiff } from '@keydown-app/ts-git-diff-myers';

// Once, for every diff() call
const git = new GitClient({ fs, dir: '/my-repo', lineDiffAlgorithm: myersLineDiff });

// Or per call
await git.diff({ lineDiffAlgorithm: myersLineDiff });
```

To write your own, implement this signature:

```typescript
type LineDiffAlgorithm = (oldLines: string[], newLines: string[]) => LineDiffEdit[];

interface LineDiffEdit {
  type: '+' | '-' | ' ';
  oldIndex: number; // -1 for additions
  newIndex: number; // -1 for deletions
  content: string;
}
```

## Formatting

```typescript
import {
  formatDiff,
  formatPatch,
  formatNameOnly,
  formatNameStatus,
  formatStat,
} from '@keydown-app/ts-git';

formatPatch(result); // unified diff, like `git diff`
formatNameOnly(result); // like `git diff --name-only`
formatNameStatus(result); // like `git diff --name-status`
formatStat(result); // like `git diff --stat`

// Or pick by mode: 'patch' | 'name-only' | 'name-status' | 'stat'
formatDiff(result, 'stat');
```

## Standalone function

```typescript
import { diff } from '@keydown-app/ts-git';

const result = await diff({
  fs,
  dir,
  gitdir, // optional
  left, // optional
  right, // optional
  cached, // optional
  paths, // optional
  contextLines, // optional
  lineDiffAlgorithm, // required
});
```

`resolveDiffSpecs(fs, gitdir, ['main..feature', '--', 'src'])` turns CLI-style arguments into `left`, `right` and `paths`, which is useful when building your own command line.

## Example

```typescript
import { GitClient, MemoryFS, formatPatch, formatDiff } from '@keydown-app/ts-git';
import { myersLineDiff } from '@keydown-app/ts-git-diff-myers';

const fs = new MemoryFS();
const git = new GitClient({
  fs,
  dir: '/my-repo',
  defaultBranch: 'main',
  lineDiffAlgorithm: myersLineDiff,
});
const author = { name: 'John', email: 'john@example.com' };

await git.init();
await fs.writeFile('/my-repo/README.md', 'Hello\n');
await git.add('README.md');
await git.commit('Initial', author);

// Unstaged changes (index vs worktree)
await fs.writeFile('/my-repo/README.md', 'Hello World!\n');
const unstaged = await git.diff();
console.log(unstaged.changed); // 1

// Staged changes (HEAD vs index)
await git.add('README.md');
const staged = await git.diff({ cached: true });
console.log(formatPatch(staged));
// diff --git a/README.md b/README.md
// index e965047..980a0d5 100644
// --- a/README.md
// +++ b/README.md
// @@ ... @@
// -Hello
// +Hello World!

console.log(formatDiff(staged, 'name-status')); // 'M\tREADME.md'

// Between two commits
await git.commit('Update greeting', author);
const [newer, older] = await git.log(2);
const between = await git.diff({
  left: { type: 'commit', ref: older.oid },
  right: { type: 'commit', ref: newer.oid },
});
console.log(between.insertions, between.deletions); // 1 1
```

## Limitations

- No rename or copy detection (`-M`, `-C`): moves appear as a deletion plus an addition.
- No merge-base diffs (`A...B`) or special range syntax (`A^!`, `A^@`).
- Binary files are detected but not content-diffed.
- No `--word-diff`, colour output, `--no-index` or `diff.*` config.

See the [roadmap](/roadmap/) for the full list.

## See also

- [status](/commands/status/): which files changed
- [add](/commands/add/): stage changes
