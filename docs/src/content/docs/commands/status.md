---
title: status
description: Check the status of files across HEAD, the index and the working tree.
---

TS-Git reports status three ways:

- **Porcelain output**: exactly what `git status --porcelain=v1 --no-renames` prints, or the same entries as objects
- **Status matrix**: a row of numeric codes for every file, in the format of [isomorphic-git's `statusMatrix`](https://isomorphic-git.org/docs/en/statusMatrix)
- **Status string**: a single isomorphic-git style name for one file

All three share one engine, which compares `HEAD`, the index and the working tree the way Git does (see [How changes are detected](#how-changes-are-detected)).

## GitClient methods

### Status of one file

```typescript
await git.status(filepath: string): Promise<string>
```

### Status matrix

```typescript
await git.statusMatrix(): Promise<StatusRow[]>
```

Porcelain output has no `GitClient` method. Use the standalone [`statusPorcelain`](#statusporcelain) or [`statusEntries`](#statusentries) functions.

## Porcelain output

`statusPorcelain` returns the exact bytes of `git status --porcelain=v1 --no-renames`, so you can compare it with Git or parse it with existing tools. Each line is `XY path`:

- `X` is the index compared to `HEAD`
- `Y` is the working tree compared to the index

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| ` `  | Unchanged                                                    |
| `M`  | Modified (content or executable bit)                         |
| `T`  | Type changed (regular file, symlink or submodule)            |
| `A`  | Added to the index                                           |
| `D`  | Deleted                                                      |
| `??` | Untracked                                                    |
| `!!` | Ignored (only with `ignored: true`)                          |

Common lines:

| Line          | Meaning                                                |
| ------------- | ------------------------------------------------------ |
| ` M a.txt`    | Modified, not staged                                   |
| `M  a.txt`    | Modified and staged                                    |
| `MM a.txt`    | Staged, then modified again                            |
| `A  a.txt`    | New file, staged                                       |
| `AM a.txt`    | Staged, then modified again                            |
| `AD a.txt`    | Staged, then deleted from the working tree             |
| ` D a.txt`    | Deleted, not staged                                    |
| `D  a.txt`    | Deletion staged                                        |
| `?? src/`     | Untracked directory (no tracked files inside)          |

Entries are printed in Git's order: tracked changes sorted by path, then untracked paths, then ignored paths. Paths are quoted the way Git quotes them (`core.quotePath=true`): names containing control characters, `"`, `\`, spaces or non-ASCII bytes are wrapped in double quotes with C-style and octal escapes, for example `?? "\303\274n\303\257.txt"`.

### Untracked files

The `untrackedFiles` option matches `--untracked-files`:

| Value      | Behaviour                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `'normal'` | Default. An untracked directory that contains no tracked files is shown once, as `dir/`                    |
| `'all'`    | Every untracked file is listed individually                                                                |
| `'no'`     | Untracked files are not shown                                                                              |

Untracked nested repositories (directories containing a `.git`) are shown as `dir/` and not descended into.

### Ignored files

With `ignored: true` (`--ignored`), ignored paths are listed with `!!` after the untracked ones. With the default `untrackedFiles: 'normal'`, an ignored path is shown through its outermost directory that holds no tracked or untracked content, as Git does. With `untrackedFiles: 'all'`, the individual files inside ignored directories are listed.

Ignore rules come from `.gitignore` files (deeper files take precedence), `.git/info/exclude` and an absolute `core.excludesFile`, following gitignore(5), including negation, anchored and directory-only patterns. `core.ignoreCase` is honoured.

### Unmerged paths

While a merge has conflicts, conflicted paths are reported with Git's two-letter unmerged codes instead of `XY` changes:

| Code | Stages present          | Meaning                        |
| ---- | ----------------------- | ------------------------------ |
| `UU` | base, ours, theirs      | Both modified                  |
| `AA` | ours, theirs            | Both added                     |
| `UD` | base, ours              | Deleted by them                |
| `DU` | base, theirs            | Deleted by us                  |
| `AU` | ours                    | Added by us                    |
| `UA` | theirs                  | Added by them                  |
| `DD` | base                    | Both deleted                   |

### Renames

Rename detection isn't implemented, which is why the output matches `--no-renames`: a moved file appears as a deletion plus an addition (`D  old.txt` and `A  new.txt` once both sides are staged).

## Status strings

A `*` prefix means the working tree has changes that are **not** staged.

| Status                | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `'unmodified'`        | Tracked and unchanged                                            |
| `'*modified'`         | Modified in the working tree, not staged                         |
| `'modified'`          | Modified and staged                                              |
| `'*added'`            | New file, not staged (untracked)                                 |
| `'added'`             | New file, staged                                                 |
| `'*deleted'`          | Deleted from the working tree, deletion not staged               |
| `'deleted'`           | Deletion staged                                                  |
| `'*unmodified'`       | Working tree matches `HEAD` but the index differs                |
| `'*absent'`           | Staged, then deleted from the working tree before committing     |
| `'*undeleted'`        | Deletion staged, but the file is back in the working tree unchanged |
| `'*undeletemodified'` | Deletion staged, but the file is back in the working tree with changes |
| `'ignored'`           | Untracked and matched by an ignore rule                          |
| `'absent'`            | Not in `HEAD`, the index or the working tree                     |

## Status matrix

Each row is `[filepath, head, workdir, stage]`:

```typescript
type StatusRow = [
  filepath: string,
  head: 0 | 1,
  workdir: 0 | 1 | 2,
  stage: 0 | 1 | 2 | 3,
];
```

| Column    | `0`    | `1`                 | `2`                        | `3`                                |
| --------- | ------ | ------------------- | -------------------------- | ---------------------------------- |
| `head`    | absent | present in `HEAD`   |                            |                                    |
| `workdir` | absent | identical to `HEAD` | different from `HEAD`      |                                    |
| `stage`   | absent | identical to `HEAD` | identical to the worktree  | different from both `HEAD` and worktree |

"Identical" compares both the blob OID and the file mode, so a change to only the executable bit (when `core.fileMode` is true) or a file replaced by a symlink counts as a difference.

Common rows:

| Row                     | Meaning                                  |
| ----------------------- | ---------------------------------------- |
| `['a.txt', 0, 2, 0]`    | New, untracked                           |
| `['a.txt', 0, 2, 2]`    | Added, staged                            |
| `['a.txt', 0, 2, 3]`    | Added, staged, then modified again       |
| `['a.txt', 0, 0, 3]`    | Added, staged, then deleted from the working tree |
| `['a.txt', 1, 1, 1]`    | Unmodified                               |
| `['a.txt', 1, 2, 1]`    | Modified, not staged                     |
| `['a.txt', 1, 2, 2]`    | Modified, staged                         |
| `['a.txt', 1, 2, 3]`    | Modified, staged, then modified again    |
| `['a.txt', 1, 0, 1]`    | Deleted, not staged                      |
| `['a.txt', 1, 0, 0]`    | Deleted, staged                          |

Rows are sorted by path (byte order, as Git sorts). Ignored untracked files are left out. For an unmerged path, the matrix uses a single representative index entry (stage 0 if present, otherwise "ours"); use [`statusPorcelain`](#unmerged-paths) to see conflicts.

## How changes are detected

The status engine follows Git's rules, so its results match `git status` on the same repository:

- **Modes**: the executable bit is compared when `core.fileMode` is true (the default). With `core.fileMode=false`, the mode recorded in the index is kept. Symlinks are compared as mode `120000` blobs of their link target when `core.symlinks` is true (the default), and never followed.
- **Type changes**: a file replaced by a symlink (or the reverse) is a type change (`T`). A tracked file replaced by a directory is reported as deleted, and a tracked directory replaced by a file shows the old files as deleted and the new file as untracked.
- **Submodules**: gitlink (`160000`) entries are listed like other paths, but the submodule checkout itself isn't inspected.
- **Racy-git safety**: an index entry's cached stat data (size, mtime, ctime, inode) is only trusted when it still matches the file **and** the file was last modified more than a second before the index was written. Otherwise the file is re-hashed. This catches edits made in the same instant the index was written, and edits that kept the same size and restored the old mtime. Times are compared at millisecond precision, so ts-git can notice a change that Git, comparing ctime at one-second granularity, misses.

## Standalone functions

```typescript
import {
  status,
  statusMatrix,
  statusPorcelain,
  statusEntries,
  classifyStatusRow,
} from '@keydown-dev/ts-git';
```

### statusPorcelain

```typescript
await statusPorcelain({ fs, dir, untrackedFiles?, ignored? }): Promise<string>
```

| Option           | Type                         | Default      | Description                                      |
| ---------------- | ---------------------------- | ------------ | ------------------------------------------------ |
| `fs`             | `FSAdapter`                  | **required** | Filesystem adapter                               |
| `dir`            | `string`                     | **required** | Working tree root                                |
| `gitdir`         | `string`                     | `<dir>/.git` | Git directory                                    |
| `untrackedFiles` | `'no' \| 'normal' \| 'all'`  | `'normal'`   | Like `--untracked-files`                         |
| `ignored`        | `boolean`                    | `false`      | Also list ignored paths, like `--ignored`        |

Returns one `XY path\n` line per entry, or `''` when the working tree is clean.

### statusEntries

Takes the same options as `statusPorcelain` and returns the same entries, in the same order, as objects. Paths are not quoted.

```typescript
await statusEntries({ fs, dir, untrackedFiles?, ignored? }): Promise<StatusEntry[]>

interface StatusEntry {
  path: string; // repo-relative; collapsed directories end with '/'
  index: string; // X column
  worktree: string; // Y column
}
```

### status

```typescript
await status({ fs, dir, filepath }): Promise<StatusName>
```

| Option     | Type        | Default      | Description                         |
| ---------- | ----------- | ------------ | ----------------------------------- |
| `fs`       | `FSAdapter` | **required** | Filesystem adapter                  |
| `dir`      | `string`    | **required** | Working tree root                   |
| `gitdir`   | `string`    | `<dir>/.git` | Git directory                       |
| `filepath` | `string`    | **required** | File to check, relative to `dir`    |

Returns `'ignored'` for an untracked file matched by an ignore rule.

### statusMatrix

```typescript
await statusMatrix({ fs, dir, filepaths?, filter? }): Promise<StatusRow[]>
```

| Option      | Type                          | Default      | Description                                                        |
| ----------- | ----------------------------- | ------------ | ------------------------------------------------------------------ |
| `fs`        | `FSAdapter`                   | **required** | Filesystem adapter                                                 |
| `dir`       | `string`                      | **required** | Working tree root                                                  |
| `gitdir`    | `string`                      | `<dir>/.git` | Git directory                                                      |
| `filepaths` | `string[]`                    | all files    | Only include these paths, or paths under these directories         |
| `filter`    | `(filepath: string) => boolean` | none       | Only include paths for which this returns `true`                   |

The working tree is walked (honouring ignore rules) and combined with every path in the index and `HEAD`, so deletions show up too. A path named explicitly in `filepaths` that exists but is ignored is still reported.

### classifyStatusRow

Turns a matrix row into Git-style categories and `X`/`Y` codes, which is handy for rendering `git status`-like output from the matrix:

```typescript
const info = classifyStatusRow(['src/app.ts', 1, 2, 1]);
// {
//   isStaged: false, isUnstaged: true, isUntracked: false, isClean: false,
//   stagedStatus: ' ', unstagedStatus: 'M'
// }
```

For output that matches Git exactly, including type changes, unmerged paths and directory collapsing, prefer `statusPorcelain` or `statusEntries`.

## Example

```typescript
import { GitClient, MemoryFS, statusPorcelain } from '@keydown-dev/ts-git';

const fs = new MemoryFS();
const dir = '/my-repo';
const git = new GitClient({ fs, dir, defaultBranch: 'main' });

await git.init();

await fs.writeFile('/my-repo/README.md', '# Hello\n');
console.log(await git.status('README.md')); // '*added'

await git.add('README.md');
console.log(await git.status('README.md')); // 'added'

await fs.writeFile('/my-repo/.gitignore', '*.log\n');
await git.add('.gitignore');
await git.commit('Initial commit', {
  name: 'John Doe',
  email: 'john@example.com',
});
console.log(await git.status('README.md')); // 'unmodified'

await fs.writeFile('/my-repo/README.md', '# Hello World!\n');
await fs.writeFile('/my-repo/src/app.ts', 'export {};\n');
await fs.writeFile('/my-repo/src/util.ts', 'export {};\n');
await fs.writeFile('/my-repo/debug.log', 'x\n');

console.log(await git.status('README.md')); // '*modified'
console.log(await git.status('debug.log')); // 'ignored'

console.log(await statusPorcelain({ fs, dir }));
//  M README.md
// ?? src/

console.log(await statusPorcelain({ fs, dir, untrackedFiles: 'all', ignored: true }));
//  M README.md
// ?? src/app.ts
// ?? src/util.ts
// !! debug.log

console.log(await git.statusMatrix());
// [
//   ['.gitignore', 1, 1, 1],
//   ['README.md', 1, 2, 1],
//   ['src/app.ts', 0, 2, 0],
//   ['src/util.ts', 0, 2, 0],
// ]
```

## See also

- [add](/commands/add/): stage files
- [diff](/commands/diff/): see what changed inside files
