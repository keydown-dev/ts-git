---
title: remove
description: Remove paths from the Git index without deleting them from disk.
---

Remove paths from the index (staging area). This follows `git rm --cached [-r] [-f] <pathspec>...`: the files stay in the working tree and become untracked. If a path was committed, the removal is staged as a deletion for the next commit.

## GitClient method

```typescript
await git.remove(
  filepath: string | string[],
  options?: { recursive?: boolean; force?: boolean },
): Promise<void>
```

| Parameter           | Type                 | Default | Description                                                     |
| ------------------- | -------------------- | ------- | --------------------------------------------------------------- |
| `filepath`          | `string \| string[]` |         | Pathspec(s) to remove from the index, relative to the repo root |
| `options.recursive` | `boolean`            | `false` | Allow removing a directory's entries (like `git rm -r`)          |
| `options.force`     | `boolean`            | `false` | Skip the staged-changes safety check (like `git rm -f`)          |

To delete the file from disk as well (like plain `git rm`), delete it through your adapter, for example `await fs.unlink('/my-repo/old.txt')`.

### Errors

Nothing is changed when any of these is thrown:

- `NotFoundError` if a pathspec matches no index entry ("pathspec 'x' did not match any files").
- `IsADirectoryError` if a pathspec names a directory and `recursive` isn't set ("not removing 'x' recursively without -r"). Globs don't need `recursive`.
- `TsGitError` if a file's staged content differs from both the working tree file and `HEAD`, so removing it would lose the staged version ("the following file has staged content different from both the file and the HEAD"). Pass `force` to remove it anyway.

## Standalone function

```typescript
import { remove } from '@keydown-app/ts-git';

await remove({ fs, dir, filepath, recursive?, force? }): Promise<void>
```

| Option      | Type                 | Default      | Description                                  |
| ----------- | -------------------- | ------------ | -------------------------------------------- |
| `fs`        | `FSAdapter`          | **required** | Filesystem adapter                           |
| `dir`       | `string`             | **required** | Working tree root                            |
| `gitdir`    | `string`             | `<dir>/.git` | Git directory                                |
| `filepath`  | `string \| string[]` | **required** | One or more pathspecs to remove              |
| `recursive` | `boolean`            | `false`      | Allow removing directories                   |
| `force`     | `boolean`            | `false`      | Skip the staged-changes safety check         |

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

// Directories need recursive, like git rm -r --cached
await fs.writeFile('/my-repo/logs/a.log', 'a');
await git.add('logs');
await git.remove('logs', { recursive: true });
```

## See also

- [add](/commands/add/): stage files
- [reset](/commands/reset/): unstage changes but keep the path tracked
