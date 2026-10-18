---
title: ls-tree
description: List the entries of a tree object.
---

List the entries (files and subdirectories) of a tree object, like `git ls-tree <tree>`.

Plumbing commands are standalone functions only. They have no `GitClient` methods.

```typescript
import { lsTree } from '@keydown-app/ts-git';

await lsTree({ fs, dir, tree, nameOnly? }): Promise<LsTreeResult>
```

## Options

| Option      | Type        | Default      | Description                                                       |
| ----------- | ----------- | ------------ | ----------------------------------------------------------------- |
| `fs`        | `FSAdapter` | **required** | Filesystem adapter                                                |
| `dir`       | `string`    | **required** | Working tree root                                                 |
| `gitdir`    | `string`    | `<dir>/.git` | Git directory                                                     |
| `tree`      | `string`    | **required** | 40-character **tree** OID                                         |
| `nameOnly`  | `boolean`   | `false`      | Only populate `path` (other fields are blanked), like `--name-only` |
| `recursive` | `boolean`   | `false`      | Accepted but **not implemented yet**; only direct children are listed |

## Return value

```typescript
interface LsTreeResult {
  entries: {
    mode: string; // e.g. '100644', '100755', '120000', or '40000' / '040000' for trees
    type: string; // 'blob', 'tree' or 'symlink'
    oid: string;
    path: string; // entry name within this tree
  }[];
}
```

Subdirectories appear as entries with `type: 'tree'`. Call `lsTree` again with their `oid` to descend.

:::note
`tree` must be a tree OID. Refs such as `HEAD` or branch names, and commit OIDs, are rejected for now. Get a commit's tree OID from [`readCommit`](/commands/log/#readcommit) or [`log`](/commands/log/).
:::

## Example

```typescript
import { GitClient, MemoryFS, lsTree } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const dir = '/repo';
const git = new GitClient({ fs, dir });

await git.init();
await fs.writeFile('/repo/README.md', '# Hello\n');
await fs.writeFile('/repo/src/index.ts', 'export {};\n');
await git.addAll();
await git.commit('Initial commit', { name: 'Ada', email: 'ada@example.com' });

// Resolve HEAD to its tree
const [head] = await git.log(1);
const { entries } = await lsTree({ fs, dir, tree: head.commit.tree });

for (const e of entries) {
  console.log(e.mode, e.type, e.oid.slice(0, 7), e.path);
}
// 100644 blob fec5601 README.md
// 040000 tree fed41f1 src

// Recurse manually
async function walk(tree: string, prefix = ''): Promise<string[]> {
  const { entries } = await lsTree({ fs, dir, tree });
  const files: string[] = [];
  for (const e of entries) {
    if (e.type === 'tree') files.push(...(await walk(e.oid, `${prefix}${e.path}/`)));
    else files.push(prefix + e.path);
  }
  return files;
}
console.log(await walk(head.commit.tree)); // ['README.md', 'src/index.ts']
```

## See also

- [cat-file](/plumbing/cat-file/): read individual objects
- [log](/commands/log/): find commit and tree OIDs
