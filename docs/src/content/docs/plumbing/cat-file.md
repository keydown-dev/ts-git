---
title: cat-file
description: Read an object from the object database by OID.
---

Read a blob, tree or commit by its object ID, like `git cat-file`. Works with both loose objects and packfiles.

Plumbing commands are standalone functions only. They have no `GitClient` methods.

```typescript
import { catFile } from '@keydown-app/ts-git';

await catFile({ fs, dir, oid, typeOnly?, pretty? }): Promise<string | ReadObjectResult | null>
```

## Options

| Option     | Type        | Default      | Description                                     |
| ---------- | ----------- | ------------ | ----------------------------------------------- |
| `fs`       | `FSAdapter` | **required** | Filesystem adapter                              |
| `dir`      | `string`    | **required** | Working tree root                               |
| `gitdir`   | `string`    | `<dir>/.git` | Git directory                                   |
| `oid`      | `string`    | **required** | Full 40-character object ID                     |
| `typeOnly` | `boolean`   | `false`      | Return only the type, like `git cat-file -t`    |
| `pretty`   | `boolean`   | `false`      | Return a printable string, like `git cat-file -p` |

Throws if the object doesn't exist.

## Return value

| Mode         | Blob                          | Commit                                       | Tree       |
| ------------ | ----------------------------- | -------------------------------------------- | ---------- |
| `typeOnly`   | `'blob'`                      | `'commit'`                                   | `'tree'`   |
| `pretty`     | File contents as a string     | `'commit <short-oid>\n<message>'`            | `'tree'`   |
| default      | `{ oid, type: 'blob', blob }` | `{ oid, type: 'commit', message, ... }`      | `{ oid, type: 'tree', entries: [] }` |

The default (structured) result is typed as `ReadObjectResult`:

```typescript
type ReadObjectResult =
  | { oid: string; type: 'blob'; blob: Uint8Array }
  | { oid: string; type: 'tree'; entries: { mode: string; path: string; oid: string; type: string }[] }
  | {
      oid: string;
      type: 'commit';
      tree: string;
      parent: string[];
      author: { name: string; email: string; timestamp: number; timezoneOffset: number };
      committer: { name: string; email: string; timestamp: number; timezoneOffset: number };
      message: string;
    };
```

:::caution[Alpha limitations]
For trees and commits, the structured result isn't fully parsed yet. Tree `entries` is always empty, and for commits only `message` is filled in (it contains the **raw** commit object text, including the `tree`, `author` and `committer` headers). Until that's finished:

- use [`lsTree`](/plumbing/ls-tree/) to list a tree's entries
- use [`readCommit`](/commands/log/#readcommit) to get a fully parsed commit
:::

## Example

```typescript
import { MemoryFS, init, hashObjectString, catFile } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const dir = '/repo';
await init({ fs, dir });

// Write a blob into the object database
const { oid } = await hashObjectString({ fs, dir, content: 'hello world\n', write: true });
// oid === '3b18e512dba79e4c8300dd08aeb37f8e728b8dad'

await catFile({ fs, dir, oid, typeOnly: true }); // 'blob'
await catFile({ fs, dir, oid, pretty: true }); // 'hello world\n'

const obj = await catFile({ fs, dir, oid });
if (obj && typeof obj !== 'string' && obj.type === 'blob') {
  console.log(new TextDecoder().decode(obj.blob)); // 'hello world\n'
}
```

## See also

- [hash-object](/plumbing/hash-object/): write objects
- [ls-tree](/plumbing/ls-tree/): list tree entries
- [log](/commands/log/): `readCommit` for parsed commits
