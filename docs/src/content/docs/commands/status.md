---
title: status
description: Check the status of files across HEAD, the index and the working tree.
---

TS-Git reports status two ways: a single status string for one file, or a **status matrix** with a row of numeric codes for every file. The format matches [isomorphic-git's](https://isomorphic-git.org/docs/en/statusMatrix), so existing knowledge carries over.

## GitClient methods

### Status of one file

```typescript
await git.status(filepath: string): Promise<string>
```

### Status matrix

```typescript
await git.statusMatrix(): Promise<StatusRow[]>
```

## Status strings

A `*` prefix means the working tree has changes that are **not** staged.

| Status            | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `'unmodified'`    | Tracked and unchanged                                            |
| `'*modified'`     | Modified in the working tree, not staged                         |
| `'modified'`      | Modified and staged                                              |
| `'*added'`        | New file, not staged (untracked)                                 |
| `'added'`         | New file, staged                                                 |
| `'*deleted'`      | Deleted from the working tree, deletion not staged               |
| `'deleted'`       | Deletion staged                                                  |
| `'*unmodified'`   | Working tree matches `HEAD` but the index differs                |
| `'*absent'`       | Staged, then deleted from the working tree before committing     |
| `'absent'`        | Not in `HEAD`, the index or the working tree                     |

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

Common rows:

| Row                     | Meaning                                  |
| ----------------------- | ---------------------------------------- |
| `['a.txt', 0, 2, 0]`    | New, untracked                           |
| `['a.txt', 0, 2, 2]`    | Added, staged                            |
| `['a.txt', 1, 1, 1]`    | Unmodified                               |
| `['a.txt', 1, 2, 1]`    | Modified, not staged                     |
| `['a.txt', 1, 2, 2]`    | Modified, staged                         |
| `['a.txt', 1, 2, 3]`    | Modified, staged, then modified again    |
| `['a.txt', 1, 0, 1]`    | Deleted, not staged                      |
| `['a.txt', 1, 0, 0]`    | Deleted, staged                          |

## Standalone functions

```typescript
import { status, statusMatrix, classifyStatusRow } from '@keydown-app/ts-git';
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

### statusMatrix

```typescript
await statusMatrix({ fs, dir, filepaths?, filter? }): Promise<StatusRow[]>
```

| Option      | Type                          | Default      | Description                                                        |
| ----------- | ----------------------------- | ------------ | ------------------------------------------------------------------ |
| `fs`        | `FSAdapter`                   | **required** | Filesystem adapter                                                 |
| `dir`       | `string`                      | **required** | Working tree root                                                  |
| `gitdir`    | `string`                      | `<dir>/.git` | Git directory                                                      |
| `filepaths` | `string[]`                    | all files    | Only check these paths (skips walking the working tree)            |
| `filter`    | `(filepath: string) => boolean` | none       | Only include paths for which this returns `true`                   |

Without `filepaths`, the working tree is walked (honouring `.gitignore`) and combined with every path in the index and `HEAD`, so deletions show up too.

### classifyStatusRow

Turns a matrix row into Git-style categories, which is handy for rendering `git status`-like output:

```typescript
const info = classifyStatusRow(['src/app.ts', 1, 2, 1]);
// {
//   isStaged: false, isUnstaged: true, isUntracked: false, isClean: false,
//   stagedStatus: ' ', unstagedStatus: 'M'
// }
```

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });

await git.init();

await fs.writeFile('/my-repo/README.md', '# Hello');
console.log(await git.status('README.md')); // '*added'

await git.add('README.md');
console.log(await git.status('README.md')); // 'added'

await git.commit('Initial commit', {
  name: 'John Doe',
  email: 'john@example.com',
});
console.log(await git.status('README.md')); // 'unmodified'

await fs.writeFile('/my-repo/README.md', '# Hello World!');
console.log(await git.status('README.md')); // '*modified'

console.log(await git.statusMatrix());
// [['README.md', 1, 2, 1]]
```

## See also

- [add](/commands/add/): stage files
- [diff](/commands/diff/): see what changed inside files
