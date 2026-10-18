---
title: diff
description: Compare the working tree, index, commits and trees, and format the result exactly like git diff.
---

Compute structured differences between two snapshots of the repository, then optionally format them as a unified patch, a diffstat or a list of names. The formatted output is byte-for-byte what `git diff --no-renames` prints.

## Comparisons

| What you want                       | Git CLI equivalent      | TS-Git call                                                    |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Unstaged changes (index → worktree) | `git diff`              | `git.diff()`                                                   |
| Staged changes (`HEAD` → index)     | `git diff --cached`     | `git.diff({ cached: true })`                                   |
| Commit → worktree                   | `git diff HEAD`         | `git.diff({ left: { type: 'commit', ref: 'HEAD' }, right: { type: 'worktree' } })` |
| Commit → commit                     | `git diff A B` or `git diff A..B` | `git.diff({ left: { type: 'commit', ref: A }, right: { type: 'commit', ref: B } })` |
| Merge base → commit                 | `git diff A...B`        | `resolveDiffSpecs(fs, gitdir, ['A...B'])`, then `git.diff({ left, right })` |
| Limit to paths                      | `git diff -- src/`      | `git.diff({ paths: ['src/'] })`                                |

Like `git diff`, worktree comparisons only cover **tracked** files. Untracked files appear in [`status`](/commands/status/), not here. Paths with merge conflicts (unmerged index entries) are left out of comparisons that involve the index or the working tree.

## GitClient method

```typescript
await git.diff(options?): Promise<DiffResult>
```

| Option              | Type                | Default            | Description                                                |
| ------------------- | ------------------- | ------------------ | ---------------------------------------------------------- |
| `left`              | `DiffSide`          | `{ type: 'index' }`    | "Old" side. Only used when `right` is also given      |
| `right`             | `DiffSide`          | `{ type: 'worktree' }` | "New" side. Only used when `left` is also given       |
| `cached`            | `boolean`           | `false`            | Compare `HEAD` to the index. Ignored when both `left` and `right` are given |
| `paths`             | `string[]`          | all paths          | Only include these paths (or paths under these directories) |
| `contextLines`      | `number`            | `3`                | Unchanged lines of context around each hunk (`-U<n>`)      |
| `lineDiffAlgorithm` | `LineDiffAlgorithm` | from constructor   | Overrides the client's algorithm for this call             |

Throws if no line diff algorithm is available from either the call or the constructor.

### DiffSide

```typescript
interface DiffSide {
  type: 'worktree' | 'index' | 'commit' | 'tree';
  ref?: string; // for commit/tree: any revision, e.g. 'HEAD~1', 'v1.0', 'main:src' or an abbreviated OID
  treeOid?: string; // for commit/tree: a tree (or commit) OID, tried before `ref`
}
```

`ref` and `treeOid` accept the same [revision syntax](/plumbing/cat-file/#revision-syntax) as `cat-file`, and are peeled to a tree, so commits, annotated tags and trees all work. A commit or tree side with neither set is the empty tree. An unresolvable revision throws `bad revision '<rev>'`.

### DiffResult

```typescript
interface DiffResult {
  left: DiffSide;
  right: DiffSide;
  deltas: FileDelta[]; // one per changed file, sorted by path
  changed: number; // files changed
  insertions: number; // total added lines
  deletions: number; // total deleted lines
}

interface FileDelta {
  path: string;
  status: 'A' | 'M' | 'D' | 'T'; // also 'R' | 'C' | 'U' | 'X' in the type, not produced yet
  oldMode?: string; // e.g. '100644'
  newMode?: string;
  oldOid?: string; // abbreviated (7-character) blob OIDs
  newOid?: string;
  isBinary?: boolean;
  hunks?: Hunk[];
  addedHunks?: Hunk[]; // type changes only: the creation half (see below)
  addedLines?: number;
  deletedLines?: number;
  oldSize?: number; // blob sizes in bytes, used for binary --stat lines
  newSize?: number;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  context?: string; // function context shown after the second @@
  lines: DiffLine[];
}

interface DiffLine {
  type: ' ' | '+' | '-';
  content: string; // without the trailing newline
  noNewline?: boolean; // last line of a file that doesn't end in a newline
}
```

A change of type (regular file, symlink or submodule) has status `'T'`. Git prints it as a deletion followed by a creation, so `hunks` holds the deletion half and `addedHunks` the creation half. A mode-only change (for example `chmod +x`) has status `'M'` and empty `hunks`.

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

Lines are passed **with** their trailing `\n` (the last line may lack one), so a line that only differs by a missing final newline counts as changed, as in Git. Within each run of changes, deletions are reordered before additions, as Git prints them. The hunks match Git's whenever the algorithm produces the same edit script as Git's Myers implementation.

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
formatStat(result, { width: 120 }); // like `git diff --stat=120`

// Or pick by mode: 'patch' | 'name-only' | 'name-status' | 'stat'
formatDiff(result, 'stat');
```

Each formatter reproduces Git's output exactly (with rename detection off):

- **Headers**: `diff --git`, `new file mode`, `deleted file mode`, `old mode` / `new mode` and `index <old>..<new> <mode>` lines, with `/dev/null` for added and deleted files.
- **Hunk headers** use Git's range format (`@@ -1 +1,2 @@`) and include **function context**: the nearest line above the hunk that starts with a letter, `_` or `$`, as Git's default `funcname` rule does.
- **Missing final newline**: `\ No newline at end of file` follows the affected line.
- **Binary files** (a NUL byte in the first 8000 bytes) print `Binary files a/x and b/x differ`, and `Bin <old> -> <new> bytes` in `--stat`.
- **Path quoting**: names with control characters, `"`, `\` or non-ASCII bytes are quoted with C-style and octal escapes (`core.quotePath=true`), and `---`/`+++` lines get a trailing TAB when the name contains a space.
- **`--stat`** uses Git's 80-column layout when not writing to a terminal: graph bars are scaled to fit, long names are shortened with `...`, and the summary line says `1 file changed, 2 insertions(+), 1 deletion(-)` in Git's wording.

`formatPatch` returns `''` when there are no changes; `formatStat` too. `formatNameOnly` and `formatNameStatus` join lines with `\n` and don't add a trailing newline.

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

### resolveDiffSpecs

`resolveDiffSpecs(fs, gitdir, args)` turns `git diff`-style arguments into `left`, `right` and `paths`, which is useful when building your own command line. It returns `null` when `args` contains no revision.

| Arguments           | Compares                                                        |
| ------------------- | --------------------------------------------------------------- |
| `['A']`             | Commit `A` → worktree                                           |
| `['A', 'B']`        | Commit `A` → commit `B`                                         |
| `['A..B']`          | Commit `A` → commit `B` (an empty side means `HEAD`: `A..`, `..B`) |
| `['A...B']`         | The merge base of `A` and `B` → commit `B`                      |
| `[..., '--', 'src']` | Anything after `--` becomes `paths`                            |

Each revision can be anything [`cat-file`](/plumbing/cat-file/#revision-syntax) accepts, including tree-ish revisions such as `HEAD:src`. For `A...B` with several merge bases, the first one is used; if there's none, it throws.

```typescript
const specs = await resolveDiffSpecs(fs, '/my-repo/.git', ['main...feature', '--', 'src']);
if (specs) {
  const result = await diff({ fs, dir: '/my-repo', ...specs, lineDiffAlgorithm: myersLineDiff });
}
```

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
await fs.writeFile(
  '/my-repo/greet.ts',
  'export function greet(name: string) {\n' +
    '  const greeting = "Hello";\n' +
    '  const punctuation = "!";\n' +
    '  console.log("greeting");\n' +
    '  return `${greeting}, ${name}${punctuation}`;\n' +
    '}\n',
);
await fs.writeFile('/my-repo/notes.txt', 'one\ntwo'); // no final newline
await git.addAll();
await git.commit('Initial', author);

// Unstaged changes (index vs worktree)
await fs.writeFile(
  '/my-repo/greet.ts',
  (await fs.readFileString('/my-repo/greet.ts')).replace('}`;', '}?`;'),
);
await fs.writeFile('/my-repo/notes.txt', 'one\ntwo\nthree\n');

const unstaged = await git.diff();
console.log(unstaged.changed); // 2
console.log(formatPatch(unstaged));
// diff --git a/greet.ts b/greet.ts
// index dd3fc68..8443575 100644
// --- a/greet.ts
// +++ b/greet.ts
// @@ -2,5 +2,5 @@ export function greet(name: string) {
//    const greeting = "Hello";
//    const punctuation = "!";
//    console.log("greeting");
// -  return `${greeting}, ${name}${punctuation}`;
// +  return `${greeting}, ${name}${punctuation}?`;
//  }
// diff --git a/notes.txt b/notes.txt
// index 9ed40b4..4cb29ea 100644
// --- a/notes.txt
// +++ b/notes.txt
// @@ -1,2 +1,3 @@
//  one
// -two
// \ No newline at end of file
// +two
// +three

console.log(formatDiff(unstaged, 'stat'));
//  greet.ts  | 2 +-
//  notes.txt | 3 ++-
//  2 files changed, 3 insertions(+), 2 deletions(-)

// Staged changes (HEAD vs index)
await git.addAll();
const staged = await git.diff({ cached: true });
console.log(formatDiff(staged, 'name-status')); // 'M\tgreet.ts\nM\tnotes.txt'

// Between two commits
await git.commit('Update', author);
const between = await git.diff({
  left: { type: 'commit', ref: 'HEAD~1' },
  right: { type: 'commit', ref: 'HEAD' },
});
console.log(between.insertions, between.deletions); // 3 2
```

## Limitations

- No rename or copy detection (`-M`, `-C`): moves appear as a deletion plus an addition.
- No special range syntax (`A^!`, `A^@`) or combined diffs for merge commits.
- Binary files are detected but not content-diffed (no `--binary` patches).
- Only Git's default function-context rule; `diff=<driver>` attributes and custom `xfuncname` patterns aren't applied.
- No `--word-diff`, colour output, `--no-index` or `diff.*` config.

See the [roadmap](/roadmap/) for the full list.

## See also

- [status](/commands/status/): which files changed
- [add](/commands/add/): stage changes
