---
title: update-index
description: Add, refresh or remove index entries directly.
---

Manipulate index entries directly, like `git update-index`. Supports the common modes: `[--add] [--remove | --force-remove] <file>...` and `[--add] --cacheinfo <mode>,<object>,<path>`.

Plumbing commands are standalone functions only. They have no `GitClient` methods.

```typescript
import { updateIndex } from '@keydown-app/ts-git';

await updateIndex({ fs, dir, filepath?, cacheinfo?, add?, remove?, forceRemove? }): Promise<UpdateIndexResult>
```

## Options

| Option        | Type                 | Default      | Description                                                          |
| ------------- | -------------------- | ------------ | -------------------------------------------------------------------- |
| `fs`          | `FSAdapter`          | **required** | Filesystem adapter                                                   |
| `dir`         | `string`             | **required** | Working tree root                                                    |
| `gitdir`      | `string`             | `<dir>/.git` | Git directory                                                        |
| `filepath`    | `string \| string[]` | none         | Working-tree path(s) to update, relative to `dir`                    |
| `cacheinfo`   | `CacheInfo[]`        | none         | Entries to record directly, like `--cacheinfo <mode>,<object>,<path>` |
| `add`         | `boolean`            | `false`      | Allow paths that aren't in the index yet (`--add`)                   |
| `remove`      | `boolean`            | `false`      | Remove entries whose file is missing from the working tree (`--remove`) |
| `forceRemove` | `boolean`            | `false`      | Remove the entries even if the files still exist (`--force-remove`)  |
| `force`       | `boolean`            | `false`      | Deprecated alias of `add`                                            |

```typescript
interface CacheInfo {
  mode: string | number; // octal string such as '100644', or a number such as 0o100755
  oid: string; // 40-character object ID
  path: string; // repo-relative path
}
```

`cacheinfo` entries are applied first, then `filepath` entries, and the index is written once at the end.

## Behaviour

For each path in `filepath`, `updateIndex` does what `git update-index` does:

| Situation                                  | Result                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| File exists and is in the index            | Entry refreshed: content written as a blob, OID, mode and stat data updated |
| File exists, not in the index              | Added with `add`; otherwise throws `cannot add to the index - missing --add option?` |
| File missing, entry in the index           | Removed with `remove` (or `forceRemove`); otherwise throws `does not exist and --remove not passed` |
| Path is a directory                        | Throws `is a directory - add individual files instead`                  |
| `forceRemove`                              | Entry removed whether or not the file exists                            |

When a file is written to the index:

- Its content is **written to the object database** as a blob, so the index never points at a missing object.
- The **executable bit** sets mode `100755` or `100644` when `core.fileMode` is true (the default). With `core.fileMode=false`, an existing entry's mode is kept.
- **Symlinks** are stored as mode `120000` blobs containing the link target; they are never followed.
- The file's **stat data** (size, mtime, ctime, inode, ...) is recorded, so [`status`](/commands/status/#how-changes-are-detected) can skip re-hashing unchanged files.
- A new stage-0 entry replaces any conflict stages for the same path, which marks a conflict as resolved.

`cacheinfo` entries are recorded with the given mode and OID and zeroed stat data. The object isn't checked for existence, but the OID must be 40 hex characters. A path that isn't in the index yet still requires `add`.

## Return value

```typescript
interface UpdateIndexResult {
  added: string[]; // paths new to the index
  removed: string[]; // paths removed from the index
  updated: string[]; // paths that were already in the index and were rewritten
}
```

## Example

```typescript
import { MemoryFS, init, updateIndex, hashObjectString, statusPorcelain } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const dir = '/repo';
await init({ fs, dir });

await fs.writeFile('/repo/notes.txt', 'remember the milk\n');

// Like `git update-index --add notes.txt`: writes the blob and stages it
await updateIndex({ fs, dir, add: true, filepath: 'notes.txt' });
// { added: ['notes.txt'], removed: [], updated: [] }

// Refresh after an edit (no --add needed for a tracked path)
await fs.writeFile('/repo/notes.txt', 'remember the eggs\n');
await updateIndex({ fs, dir, filepath: 'notes.txt' });
// { added: [], removed: [], updated: ['notes.txt'] }

// Record an object that isn't in the working tree, like
// `git update-index --add --cacheinfo 100644,<oid>,gen/out.txt`
const { oid } = await hashObjectString({ fs, dir, content: 'generated\n', write: true });
await updateIndex({
  fs,
  dir,
  add: true,
  cacheinfo: [{ mode: '100644', oid, path: 'gen/out.txt' }],
});

console.log(await statusPorcelain({ fs, dir }));
// AD gen/out.txt
// A  notes.txt

// Drop an entry but keep the file, like `git update-index --force-remove`
const { removed } = await updateIndex({ fs, dir, forceRemove: true, filepath: 'notes.txt' });
console.log(removed); // ['notes.txt']
```

## See also

- [add](/commands/add/) and [remove](/commands/remove/): the everyday equivalents, with pathspecs and `.gitignore`
- [hash-object](/plumbing/hash-object/): write objects for use with `cacheinfo`
