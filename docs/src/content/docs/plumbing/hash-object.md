---
title: hash-object
description: Compute an object's ID from content or a file, and optionally write it to the object database.
---

Compute the Git object ID of some content, like `git hash-object`. The content can be passed in directly (like `--stdin`) or read from a file (like `git hash-object <file>`). With `write: true` the object is also stored in `.git/objects`, like `git hash-object -w`.

`hashObject` never touches the index. To stage the result, use [`updateIndex`](/plumbing/update-index/) or [`add`](/commands/add/).

Plumbing commands are standalone functions only. They have no `GitClient` methods.

```typescript
import { hashObject, hashObjectString } from '@keydown-dev/ts-git';
```

## hashObject

```typescript
await hashObject({ fs, dir, object?, filepath?, type?, write?, literally? }): Promise<HashObjectResult>
```

| Option      | Type                                    | Default      | Description                                                         |
| ----------- | --------------------------------------- | ------------ | ------------------------------------------------------------------- |
| `fs`        | `FSAdapter`                             | **required** | Filesystem adapter                                                  |
| `dir`       | `string`                                | **required** | Working tree root                                                   |
| `gitdir`    | `string`                                | `<dir>/.git` | Git directory                                                       |
| `object`    | `Uint8Array`                            | none         | Raw content to hash                                                 |
| `filepath`  | `string`                                | none         | File to read when `object` is omitted, relative to `dir` (or absolute) |
| `type`      | `'blob' \| 'tree' \| 'commit' \| 'tag'` | `'blob'`     | Object type, like `-t <type>`                                       |
| `write`     | `boolean`                               | `false`      | Also write the object to the object database (`-w`)                 |
| `literally` | `boolean`                               | `false`      | Skip the format checks for non-blob types (`--literally`)           |

One of `object` or `filepath` is required. File contents are hashed as they are, with no line-ending conversion or filters.

```typescript
interface HashObjectResult {
  oid: string; // 40-character SHA-1
  written: boolean; // true when the object was stored
}
```

### Format checks

Like Git, hashing a `tree`, `commit` or `tag` checks that the content is well formed before computing the ID, and throws otherwise (for example `invalid format - expected 'tree' line`):

- **tree**: a sequence of `<octal mode> <name>\0<20-byte OID>` entries
- **commit**: `tree`, then any `parent` lines, then `author` and `committer` with valid identities
- **tag**: `object`, `type`, `tag` and `tagger` lines

Blobs are never checked. Pass `literally: true` to hash malformed objects anyway. The same checks are exported as `validateObject(type, content)`.

## hashObjectString

Convenience wrapper that UTF-8 encodes a string and calls `hashObject`. It takes the same options, with `content: string` in place of `object`.

```typescript
const { oid } = await hashObjectString({ fs, dir, content: 'hello world\n' });
// '3b18e512dba79e4c8300dd08aeb37f8e728b8dad', the same as `echo 'hello world' | git hash-object --stdin`
```

## Example

```typescript
import { MemoryFS, init, hashObject, hashObjectString, catFile } from '@keydown-dev/ts-git';

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

// Hash a working-tree file, like `git hash-object -w README.md`
await fs.writeFile('/repo/README.md', '# Hello\n');
await hashObject({ fs, dir, filepath: 'README.md', write: true });
// { oid: 'fec56017dc1b1ac87ad6e54e3cb3a20bb8dcc5ab', written: true }

// Other object types are validated unless `literally` is set
await hashObjectString({ fs, dir, content: 'garbage', type: 'commit' });
// throws: invalid format - expected 'tree' line
await hashObjectString({ fs, dir, content: 'garbage', type: 'commit', literally: true });
// { oid: '4fa7f4e4a001931b2461ca12ef78ce3c5cac8e27', written: false }
```

## See also

- [cat-file](/plumbing/cat-file/): read objects back
- [update-index](/plumbing/update-index/): stage files or point index entries at blobs
