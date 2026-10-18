---
title: add
description: Stage files, directories or all changes in the index.
---

Write file contents to the object database and record them in the index (staging area). `add` follows Git 2.x semantics, which means `git add <pathspec>` behaves like `git add -A <pathspec>`: new, modified **and deleted** files under the pathspec are staged.

- Files are hashed and staged with their mode: `100644`, `100755` (when `core.filemode` is `true`) or `120000` for symlinks. Executable-bit changes are staged; with `core.filemode = false` the mode already in the index is kept.
- Directories (and `'.'`) are added recursively. Files ignored by a `.gitignore` or `.git/info/exclude` are skipped, but tracked files below the directory are always updated, even if they match an ignore rule.
- Tracked files that were deleted from the working tree are removed from the index, whether you name the file itself or a directory containing it.
- Globs (`*`, `?`, `[...]`) are matched against working tree and index paths. As in Git, `*` also matches `/`.
- A file replacing a tracked directory (or the other way round) replaces the old index entries.

## GitClient methods

### Stage paths

```typescript
await git.add(
  filepath: string | string[],
  options?: { force?: boolean },
): Promise<void>
```

`filepath` is one or more pathspecs relative to the repository root: files, directories, `'.'` or globs.

| Option  | Type      | Default | Description                                         |
| ------- | --------- | ------- | --------------------------------------------------- |
| `force` | `boolean` | `false` | Stage ignored files too (like `git add -f`)          |

### Stage all changes

```typescript
await git.addAll(): Promise<void>
```

Like `git add -A`: stages every new, modified and deleted file in the working tree, honouring ignore rules.

### Errors

- **Unmatched pathspec.** If a pathspec matches nothing in the working tree or the index, `add` throws `NotFoundError` ("pathspec 'x' did not match any files") before anything is changed. An existing directory always matches, even when it's empty.
- **Ignored paths.** Naming an ignored, untracked file (or an ignored directory with no tracked files) throws `IgnoredPathsError`, unless `force` is set. As in Git, the *other* paths in the call have still been staged. The error's `paths` lists the ignored paths and `result` holds the `AddResult` for what was staged.

```typescript
import { IgnoredPathsError } from '@keydown-app/ts-git';

try {
  await git.add(['src', 'dist/bundle.js']);
} catch (err) {
  if (!(err instanceof IgnoredPathsError)) throw err;
  console.log(err.paths); // ['dist/bundle.js']. 'src' was staged anyway
}
```

### Example

```typescript
// Stage a single file
await git.add('README.md');

// Stage a whole directory, including deletions inside it
await git.add('src');

// Several pathspecs, including a glob
await git.add(['package.json', 'docs/*.md']);

// Stage an ignored file on purpose
await git.add('build/config.json', { force: true });

// Stage everything, like git add -A
await git.addAll();
```

## Standalone functions

```typescript
import { add, addAll } from '@keydown-app/ts-git';
```

### add

```typescript
await add({ fs, dir, filepath, force? }): Promise<AddResult>
```

| Option     | Type                 | Default      | Description                                 |
| ---------- | -------------------- | ------------ | ------------------------------------------- |
| `fs`       | `FSAdapter`          | **required** | Filesystem adapter                          |
| `dir`      | `string`             | **required** | Working tree root                           |
| `gitdir`   | `string`             | `<dir>/.git` | Git directory                               |
| `filepath` | `string \| string[]` | **required** | One or more pathspecs to stage              |
| `force`    | `boolean`            | `false`      | Stage ignored files too                     |

Returns which paths were newly added to the index, which existing entries changed and which entries were removed because the file was deleted:

```typescript
interface AddResult {
  added: string[];
  updated: string[];
  removed?: string[]; // set only when something was removed
}
```

Files whose content and mode are unchanged appear in neither list (only their stat data is refreshed).

### addAll

`git add -A`: the same as `add({ ..., filepath: '.' })`, except that `removed` is always set.

```typescript
const result = await addAll({ fs, dir });
console.log(result.added, result.updated, result.removed);
```

| Option   | Type        | Default      | Description             |
| -------- | ----------- | ------------ | ----------------------- |
| `fs`     | `FSAdapter` | **required** | Filesystem adapter      |
| `dir`    | `string`    | **required** | Working tree root       |
| `gitdir` | `string`    | `<dir>/.git` | Git directory           |
| `force`  | `boolean`   | `false`      | Stage ignored files too |

## Complete example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo' });

await git.init();

// Create some files (MemoryFS creates parent directories as needed)
await fs.writeFile('/my-repo/README.md', '# Hello\n');
await fs.writeFile('/my-repo/src/index.ts', 'console.log("hi");\n');
await fs.writeFile('/my-repo/.gitignore', 'dist/\n');
await fs.writeFile('/my-repo/dist/index.js', '// build output\n');

await git.add('.'); // README.md, .gitignore, src/index.ts (dist/ is ignored)

await git.commit('Add initial files', {
  name: 'John Doe',
  email: 'john@example.com',
});

// Deleting a file and adding its directory stages the deletion
await fs.unlink('/my-repo/src/index.ts');
await git.add('src');
```

## See also

- [remove](/commands/remove/): remove paths from the index
- [reset](/commands/reset/): unstage changes
- [update-index](/plumbing/update-index/): the low-level index command
