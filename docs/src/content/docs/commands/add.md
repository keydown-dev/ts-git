---
title: add
description: Stage files, directories or all changes in the index.
---

Write file contents to the object database and record them in the index (staging area).

## GitClient methods

### Stage a path

```typescript
await git.add(filepath: string): Promise<void>
```

`filepath` is relative to the repository root. If it names a directory, every file inside it is staged recursively (the `.git` directory is skipped).

### Stage all changes

```typescript
await git.addAll(): Promise<void>
```

Stages every new or modified file reported by [`statusMatrix()`](/commands/status/#status-matrix). Files matched by `.gitignore` are skipped. Unlike the standalone `addAll` function below, `GitClient.addAll()` does **not** stage deletions. Use `git.remove(path)` for those.

### Example

```typescript
// Stage a single file
await git.add('README.md');

// Stage a whole directory
await git.add('src');

// Stage all new and modified files
await git.addAll();
```

## Standalone functions

```typescript
import { add, addAll } from '@keydown-app/ts-git';
```

### add

```typescript
await add({ fs, dir, filepath }): Promise<AddResult>
```

| Option     | Type                 | Default      | Description                               |
| ---------- | -------------------- | ------------ | ----------------------------------------- |
| `fs`       | `FSAdapter`          | **required** | Filesystem adapter                        |
| `dir`      | `string`             | **required** | Working tree root                         |
| `gitdir`   | `string`             | `<dir>/.git` | Git directory                             |
| `filepath` | `string \| string[]` | **required** | One or more files or directories to stage |

Returns which paths were newly added to the index and which existing entries were updated:

```typescript
interface AddResult {
  added: string[];
  updated: string[];
  removed?: string[]; // only set by addAll
}
```

### addAll

Stages all changes, like `git add -A`: new and modified files are added, and files deleted from the working tree are removed from the index.

```typescript
const result = await addAll({ fs, dir });
console.log(result.added, result.updated, result.removed);
```

| Option   | Type        | Default      | Description        |
| -------- | ----------- | ------------ | ------------------ |
| `fs`     | `FSAdapter` | **required** | Filesystem adapter |
| `dir`    | `string`    | **required** | Working tree root  |
| `gitdir` | `string`    | `<dir>/.git` | Git directory      |

## Complete example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo' });

await git.init();

// Create some files (MemoryFS creates parent directories as needed)
await fs.writeFile('/my-repo/README.md', '# Hello\n');
await fs.writeFile('/my-repo/src/index.ts', 'console.log("hi");\n');

await git.add('README.md');
await git.add('src/index.ts');
// or: await git.addAll();

await git.commit('Add initial files', {
  name: 'John Doe',
  email: 'john@example.com',
});
```

## See also

- [remove](/commands/remove/): remove paths from the index
- [reset](/commands/reset/): unstage changes
- [update-index](/plumbing/update-index/): the low-level index command
