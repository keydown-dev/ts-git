---
title: remove
description: Remove paths from the Git index without deleting them from disk.
---

Remove a path from the index (staging area). This is equivalent to `git rm --cached <file>`: the file stays in the working tree and becomes untracked. If the path was committed, the removal is staged as a deletion for the next commit.

## GitClient method

```typescript
await git.remove(filepath: string): Promise<void>
```

| Parameter  | Type     | Description                                           |
| ---------- | -------- | ----------------------------------------------------- |
| `filepath` | `string` | Path to remove from the index, relative to the repo root |

To delete the file from disk as well (like plain `git rm`), delete it through your adapter, for example `await fs.unlink('/my-repo/old.txt')`.

## Standalone function

```typescript
import { remove } from '@keydown-app/ts-git';

await remove({ fs, dir, filepath }): Promise<void>
```

| Option     | Type                 | Default      | Description                       |
| ---------- | -------------------- | ------------ | --------------------------------- |
| `fs`       | `FSAdapter`          | **required** | Filesystem adapter                |
| `dir`      | `string`             | **required** | Working tree root                 |
| `gitdir`   | `string`             | `<dir>/.git` | Git directory                     |
| `filepath` | `string \| string[]` | **required** | One or more paths to remove       |

Removing a path that names a directory throws `IsADirectoryError`. Paths that aren't in the index are ignored.

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo' });

await git.init();

// Create and stage a file
await fs.writeFile('/my-repo/temp.txt', 'temporary');
await git.add('temp.txt');
console.log(await git.status('temp.txt')); // 'added'

// Remove it from the index (the file is kept on disk)
await git.remove('temp.txt');

console.log(await git.status('temp.txt')); // '*added' (untracked)
console.log(await fs.exists('/my-repo/temp.txt')); // true
```

## See also

- [add](/commands/add/): stage files
- [reset](/commands/reset/): unstage changes but keep the path tracked
