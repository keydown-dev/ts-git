---
title: update-index
description: Add, refresh or remove index entries directly.
---

Manipulate index entries directly, like `git update-index --add` and `git update-index --remove`.

Plumbing commands are standalone functions only. They have no `GitClient` methods.

```typescript
import { updateIndex } from '@keydown-app/ts-git';

await updateIndex({ fs, dir, filepath, add?, remove? }): Promise<UpdateIndexResult>
```

## Options

| Option     | Type                 | Default      | Description                                                         |
| ---------- | -------------------- | ------------ | ------------------------------------------------------------------- |
| `fs`       | `FSAdapter`          | **required** | Filesystem adapter                                                  |
| `dir`      | `string`             | **required** | Working tree root                                                   |
| `gitdir`   | `string`             | `<dir>/.git` | Git directory                                                       |
| `filepath` | `string \| string[]` | **required** | Path(s), relative to `dir` (absolute adapter paths also work for reading) |
| `add`      | `boolean`            | `false`      | Add or refresh the entry from the working-tree file (`--add`)       |
| `remove`   | `boolean`            | `false`      | Remove the entry from the index (`--remove`)                        |
| `force`    | `boolean`            | `false`      | Behaves like `add`                                                  |

If neither `add`, `remove` nor `force` is set, nothing is changed. With `add`, a missing working-tree file throws `File not found`.

## Return value

```typescript
interface UpdateIndexResult {
  added: string[];
  removed: string[];
  updated: string[];
}
```

In the current alpha, paths written with `add` are always reported in `updated`, even when they were new to the index.

:::caution[Write the blob first]
`updateIndex({ add: true })` records the file's hash in the index but does **not** write the blob to the object database, unlike `git update-index --add`. If you commit afterwards, the tree will reference a blob that doesn't exist. Store the content first with [`hashObject`](/plumbing/hash-object/) and `write: true`, or use [`add`](/commands/add/), which does both.
:::

## Example

```typescript
import { MemoryFS, init, updateIndex, hashObject, status } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const dir = '/repo';
await init({ fs, dir });

await fs.writeFile('/repo/notes.txt', 'remember the milk\n');

// 1. Store the blob, 2. point the index at it
await hashObject({ fs, dir, object: await fs.readFile('/repo/notes.txt'), write: true });
await updateIndex({ fs, dir, add: true, filepath: 'notes.txt' });

console.log(await status({ fs, dir, filepath: 'notes.txt' })); // 'added'

// Drop it from the index again
const { removed } = await updateIndex({ fs, dir, remove: true, filepath: 'notes.txt' });
console.log(removed); // ['notes.txt']
```

## See also

- [add](/commands/add/) and [remove](/commands/remove/): the everyday equivalents
- [hash-object](/plumbing/hash-object/): write blobs
