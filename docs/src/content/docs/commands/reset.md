---
title: reset
description: Unstage changes by restoring index entries from HEAD.
---

Restore index entries to match `HEAD`, which unstages changes. This is equivalent to `git reset [-- <paths>]` (the default `--mixed` mode, limited to the index). The working tree is never modified.

- Tracked files with staged modifications go back to their `HEAD` version in the index.
- Staged new files are removed from the index (they become untracked again).
- Staged deletions are restored from `HEAD`.

## GitClient method

```typescript
await git.reset(filepath?: string | string[]): Promise<string[]>
```

| Parameter  | Type                 | Description                                              |
| ---------- | -------------------- | -------------------------------------------------------- |
| `filepath` | `string \| string[]` | Path(s) to unstage. If omitted, the whole index is reset. |

Returns the paths that were unstaged.

## Standalone function

```typescript
import { reset } from '@keydown-app/ts-git';

await reset({ fs, dir, filepath? }): Promise<{ unstaged: string[] }>
```

| Option     | Type                 | Default      | Description              |
| ---------- | -------------------- | ------------ | ------------------------ |
| `fs`       | `FSAdapter`          | **required** | Filesystem adapter       |
| `dir`      | `string`             | **required** | Working tree root        |
| `gitdir`   | `string`             | `<dir>/.git` | Git directory            |
| `filepath` | `string \| string[]` | all paths    | Path(s) to unstage       |

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });

await git.init();

await fs.writeFile('/my-repo/README.md', '# Project');
await git.add('README.md');
await git.commit('Initial commit', {
  name: 'John Doe',
  email: 'john@example.com',
});

// Stage a modification and a new file
await fs.writeFile('/my-repo/README.md', '# Updated Project');
await fs.writeFile('/my-repo/new.txt', 'new file');
await git.add('README.md');
await git.add('new.txt');

console.log(await git.status('README.md')); // 'modified'

// Unstage one file
console.log(await git.reset('README.md')); // ['README.md']
console.log(await git.status('README.md')); // '*modified'
console.log(await git.status('new.txt')); // 'added' (still staged)

// Unstage everything
await git.reset();
console.log(await git.status('new.txt')); // '*added'
```

## See also

- [add](/commands/add/): stage files
- [remove](/commands/remove/): stop tracking a path
