---
title: cat-file
description: Read an object from the object database by OID or revision.
---

Read a blob, tree, commit or tag, like `git cat-file`. Objects can be named by full or abbreviated OID or by any supported [revision](#revision-syntax), such as `HEAD`, `v1.0^{}` or `main:src/index.ts`. Works with both loose objects and packfiles.

Plumbing commands are standalone functions only. They have no `GitClient` methods.

```typescript
import { catFile } from '@keydown-app/ts-git';

await catFile({ fs, dir, oid, typeOnly?, sizeOnly?, exists?, pretty? }): Promise<string | ReadObjectResult>
```

## Options

| Option     | Type        | Default      | Description                                                  |
| ---------- | ----------- | ------------ | ------------------------------------------------------------ |
| `fs`       | `FSAdapter` | **required** | Filesystem adapter                                           |
| `dir`      | `string`    | **required** | Working tree root                                            |
| `gitdir`   | `string`    | `<dir>/.git` | Git directory                                                |
| `oid`      | `string`    | **required** | Object name: full or abbreviated OID, or a [revision](#revision-syntax) |
| `typeOnly` | `boolean`   | `false`      | Return only the type, like `git cat-file -t`                 |
| `sizeOnly` | `boolean`   | `false`      | Return only the size in bytes, like `git cat-file -s`        |
| `exists`   | `boolean`   | `false`      | Return `'true'` or `'false'` instead of throwing, like `git cat-file -e` |
| `pretty`   | `boolean`   | `false`      | Return exactly what `git cat-file -p` prints                 |

Without `exists`, a name that can't be resolved or an object that doesn't exist throws `ObjectNotFoundError` (`Not a valid object name <oid>`).

## Return value

| Mode       | Blob                          | Tree                                       | Commit                              | Tag                                 |
| ---------- | ----------------------------- | ------------------------------------------ | ----------------------------------- | ----------------------------------- |
| `typeOnly` | `'blob'`                      | `'tree'`                                   | `'commit'`                          | `'tag'`                             |
| `sizeOnly` | Size as a decimal string, e.g. `'12'` | Same                               | Same                                | Same                                |
| `exists`   | `'true'` / `'false'`          | Same                                       | Same                                | Same                                |
| `pretty`   | File contents as a string     | `ls-tree` lines (`<mode> <type> <oid>\t<name>`) | Raw commit object text         | Raw tag object text                 |
| default    | `{ oid, type: 'blob', blob }` | `{ oid, type: 'tree', entries }`           | `{ oid, type: 'commit', tree, parent, ... }` | `{ oid, type: 'tag', object, objectType, ... }` |

The `oid` in a structured result is always the full, resolved 40-character OID. The `pretty` output for trees is the same as [`formatLsTree`](/plumbing/ls-tree/#formatlstree): six-digit modes, quoted names, one entry per line.

The default (structured) result is typed as `ReadObjectResult`:

```typescript
type ReadObjectResult =
  | { oid: string; type: 'blob'; blob: Uint8Array }
  | {
      oid: string;
      type: 'tree';
      entries: { mode: string; path: string; oid: string; type: string }[]; // mode like '100644' or '040000'
    }
  | {
      oid: string;
      type: 'commit';
      tree: string;
      parent: string[];
      author: GitIdentity;
      committer: GitIdentity;
      message: string; // verbatim
      gpgsig?: string;
      extraHeaders?: { key: string; value: string }[]; // e.g. encoding, mergetag
    }
  | {
      oid: string;
      type: 'tag';
      object: string; // OID of the tagged object
      objectType: string; // 'commit', 'tree', 'blob' or 'tag'
      tag: string; // tag name
      tagger?: GitIdentity; // absent on some very old tags
      message: string; // verbatim, including any signature
      gpgsig?: string; // trailing signature block, if any
    };

interface GitIdentity {
  name: string;
  email: string;
  timestamp: number; // seconds since the Unix epoch
  timezoneOffset: number; // minutes behind UTC, like Date#getTimezoneOffset()
}
```

Commits and tags are parsed byte-exactly. Re-serializing a parsed commit with `serializeCommit` (or a tag with `serializeTag`) gives back identical bytes, and therefore the same OID.

## Revision syntax

Every read-side command that takes an object name (`catFile`, [`lsTree`](/plumbing/ls-tree/), [`log`](/commands/log/)'s `ref`, [`readCommit`](/commands/log/#readcommit) and [`diff`](/commands/diff/) sides) resolves it with the same subset of [gitrevisions(7)](https://git-scm.com/docs/gitrevisions):

| Syntax                | Example              | Meaning                                                    |
| --------------------- | -------------------- | ---------------------------------------------------------- |
| Full OID              | `3b18e512…`          | That object                                                |
| Abbreviated OID       | `3b18e51`            | The unique object starting with these hex digits (at least 4). Ambiguous prefixes throw |
| Ref name              | `main`, `v1.0`, `origin/main` | Looked up in Git's order: `<name>`, `refs/<name>`, `refs/tags/<name>`, `refs/heads/<name>`, `refs/remotes/<name>`, `refs/remotes/<name>/HEAD` |
| Pseudo-refs           | `HEAD`, `@`, `ORIG_HEAD`, `FETCH_HEAD` | Read from the Git directory; `@` is `HEAD` |
| `<rev>^{}`            | `v1.0^{}`            | Peel tags until a non-tag object                           |
| `<rev>^{type}`        | `v1.0^{tree}`        | Peel to a `commit`, `tree`, `blob` or `tag` (commits peel to their tree); `^{object}` only checks existence |
| `<rev>~<n>`           | `HEAD~2`             | The `n`th first-parent ancestor (`~` alone means `~1`)      |
| `<rev>^<n>`           | `HEAD^2`             | The `n`th parent (`^` alone means `^1`, `^0` is the commit itself) |
| `<rev>:<path>`        | `HEAD:src/index.ts`  | The blob or tree at `path` in that commit's tree           |
| `:<path>`             | `:src/index.ts`      | The blob staged in the index (stage 0)                      |
| `:<n>:<path>`         | `:2:file.txt`        | Stage `n` of a conflicted path (1 base, 2 ours, 3 theirs)   |

Operators can be chained, for example `main~2^2:docs`. Reflog syntax (`@{1}`, `@{upstream}`), `:/<text>` searches and range notation aren't supported here.

The resolver is also exported:

```typescript
import { resolveRevision, resolveRefName, expandOid, peelTo } from '@keydown-app/ts-git';

const oid = await resolveRevision(fs, gitdir, 'v1.0^{commit}'); // full OID, or throws ObjectNotFoundError
await resolveRefName(fs, gitdir, 'main'); // OID or null, using the ref lookup order above
await expandOid(fs, gitdir, '3b18e5'); // full OID or null; throws if ambiguous
await peelTo(fs, gitdir, oid, 'tree'); // peel tags (and commits, for 'tree')
```

## catFileRaw

Returns an object's raw content bytes and type, like `git cat-file <type> <object>`. Takes the same `fs`, `dir`, `gitdir` and `oid` options.

```typescript
import { catFileRaw } from '@keydown-app/ts-git';

const { oid, type, content } = await catFileRaw({ fs, dir, oid: 'HEAD' });
```

## Example

```typescript
import { GitClient, MemoryFS, catFile, hashObjectString } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const dir = '/repo';
const git = new GitClient({ fs, dir });
await git.init();

// Write a blob into the object database
const { oid } = await hashObjectString({ fs, dir, content: 'hello world\n', write: true });
// oid === '3b18e512dba79e4c8300dd08aeb37f8e728b8dad'

await catFile({ fs, dir, oid, typeOnly: true }); // 'blob'
await catFile({ fs, dir, oid: '3b18e51', sizeOnly: true }); // '12'
await catFile({ fs, dir, oid, pretty: true }); // 'hello world\n'
await catFile({ fs, dir, oid: 'deadbeef', exists: true }); // 'false'

const obj = await catFile({ fs, dir, oid });
if (typeof obj !== 'string' && obj.type === 'blob') {
  console.log(new TextDecoder().decode(obj.blob)); // 'hello world\n'
}

// Commits, trees and paths by revision
await fs.writeFile('/repo/README.md', '# Hello\n');
await fs.writeFile('/repo/src/index.ts', 'export {};\n');
await git.addAll();
await git.commit('Initial commit', {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1700000000,
  timezoneOffset: 0,
});

await catFile({ fs, dir, oid: 'HEAD', pretty: true });
// tree 56be35251e5639250e55eb8dd16b3c1beac0c6af
// author Ada <ada@example.com> 1700000000 +0000
// committer Ada <ada@example.com> 1700000000 +0000
//
// Initial commit

await catFile({ fs, dir, oid: 'HEAD^{tree}', pretty: true });
// 100644 blob fec56017dc1b1ac87ad6e54e3cb3a20bb8dcc5ab	README.md
// 040000 tree fed41f1f7930e950775bef1dee347e695bf21c27	src

await catFile({ fs, dir, oid: 'HEAD:README.md', pretty: true }); // '# Hello\n'
await catFile({ fs, dir, oid: ':src/index.ts', pretty: true }); // 'export {};\n'

const commit = await catFile({ fs, dir, oid: 'HEAD' });
if (typeof commit !== 'string' && commit.type === 'commit') {
  console.log(commit.message); // 'Initial commit\n'
}
```

Annotated tags are read the same way. With a tag `v1.0` pointing at `HEAD`, `catFile({ fs, dir, oid: 'v1.0', typeOnly: true })` returns `'tag'`, `oid: 'v1.0^{}'` names the commit, and the structured result has the tag's `object`, `objectType`, `tag`, `tagger` and `message`.

## See also

- [hash-object](/plumbing/hash-object/): write objects
- [ls-tree](/plumbing/ls-tree/): list tree entries
- [log](/commands/log/): `readCommit` for parsed commits
