---
title: hash-object
description: Compute a blob's object ID and optionally write it to the object database.
---

Compute the Git object ID of some content as a blob, like `git hash-object`. With `write: true` the blob is also stored in `.git/objects`, like `git hash-object -w`.

Plumbing commands are standalone functions only. They have no `GitClient` methods.

```typescript
import { hashObject, hashObjectString } from '@keydown-app/ts-git';
```

## hashObject

```typescript
await hashObject({ fs, dir, object, write? }): Promise<HashObjectResult>
```

| Option     | Type         | Default      | Description                                                    |
| ---------- | ------------ | ------------ | -------------------------------------------------------------- |
| `fs`       | `FSAdapter`  | **required** | Filesystem adapter                                             |
| `dir`      | `string`     | **required** | Working tree root                                              |
| `gitdir`   | `string`     | `<dir>/.git` | Git directory                                                  |
| `object`   | `Uint8Array` | **required** | Raw content to hash as a blob                                  |
| `write`    | `boolean`    | `false`      | Also write the blob to the object database                     |
| `filepath` | `string`     | none         | With `write`, also record an index entry for this path (see below) |

```typescript
interface HashObjectResult {
  oid: string; // 40-character SHA-1
  written: boolean; // true when the blob was stored
}
```

## hashObjectString

Convenience wrapper that UTF-8 encodes a string and calls `hashObject`. It takes the same options, with `content: string` in place of `object`.

```typescript
const { oid } = await hashObjectString({ fs, dir, content: 'hello world\n' });
// '3b18e512dba79e4c8300dd08aeb37f8e728b8dad', the same as `echo 'hello world' | git hash-object --stdin`
```

## Recording an index entry

When both `write` and `filepath` are given, `hashObject` also adds or replaces an index entry for `filepath` (mode `100644`). `filepath` is passed to the adapter's `stat` **as is** and stored in the index under that same string, so give a path that both your adapter can resolve and that makes sense as a repo-relative path. For staging working-tree files, [`add`](/commands/add/) is usually simpler.

## Example

```typescript
import { MemoryFS, init, hashObject, catFile } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const dir = '/repo';
await init({ fs, dir });

const bytes = new TextEncoder().encode('export const answer = 42;\n');

// Just compute the ID
const dry = await hashObject({ fs, dir, object: bytes });
console.log(dry.written); // false

// Compute and store
const { oid, written } = await hashObject({ fs, dir, object: bytes, write: true });
console.log(written); // true
console.log(await catFile({ fs, dir, oid, typeOnly: true })); // 'blob'
```

## See also

- [cat-file](/plumbing/cat-file/): read objects back
- [update-index](/plumbing/update-index/): point index entries at blobs
