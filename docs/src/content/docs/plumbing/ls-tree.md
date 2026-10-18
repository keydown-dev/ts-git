---
title: ls-tree
description: List the entries of a tree object, recursively or by path.
---

List the entries (files and subdirectories) of a tree, like `git ls-tree`. The tree can be named by any tree-ish: a tree, commit or annotated tag OID, or a [revision](/plumbing/cat-file/#revision-syntax) such as `HEAD`, `main~1` or `HEAD:src`. [`formatLsTree`](#formatlstree) turns the result into exactly what `git ls-tree` prints.

Plumbing commands are standalone functions only. They have no `GitClient` methods.

```typescript
import { lsTree, formatLsTree } from '@keydown-app/ts-git';

await lsTree({ fs, dir, tree, recursive?, showTrees?, treesOnly?, long?, paths? }): Promise<LsTreeResult>
```

## Options

| Option      | Type        | Default      | Description                                                           |
| ----------- | ----------- | ------------ | --------------------------------------------------------------------- |
| `fs`        | `FSAdapter` | **required** | Filesystem adapter                                                    |
| `dir`       | `string`    | **required** | Working tree root                                                     |
| `gitdir`    | `string`    | `<dir>/.git` | Git directory                                                         |
| `tree`      | `string`    | **required** | Tree-ish: OID (full or abbreviated) or revision. Commits and tags are peeled to their tree |
| `recursive` | `boolean`   | `false`      | Recurse into subtrees, listing files with their full paths (`-r`)      |
| `showTrees` | `boolean`   | `false`      | With `recursive`, also list the trees being recursed into (`-t`)       |
| `treesOnly` | `boolean`   | `false`      | List only trees (and submodules), not blobs (`-d`). With `recursive`, implies `showTrees` |
| `long`      | `boolean`   | `false`      | Include each blob's size in bytes (`-l` / `--long`)                    |
| `paths`     | `string[]`  | whole tree   | Only list entries matching these paths (`git ls-tree <tree-ish> <path>...`) |
| `nameOnly`  | `boolean`   | `false`      | Accepted for compatibility; has no effect on the result. Pass `nameOnly` to `formatLsTree` instead |

A name that can't be resolved throws `ObjectNotFoundError`; one that doesn't lead to a tree (a blob, for example) throws `not a tree object`.

### Paths

`paths` are literal paths relative to the root of the listed tree (no globbing):

- `'src/index.ts'` lists that entry.
- `'src'` lists the `src` tree entry itself. Add a trailing slash, `'src/'`, to list its contents instead.
- Naming a path inside a subtree, such as `'src/lib/util.ts'`, descends into the trees on the way even without `recursive`.
- `'.'` means the whole tree.

## Return value

```typescript
interface LsTreeResult {
  entries: {
    mode: string; // six octal digits as git prints them: '100644', '100755', '120000', '160000' or '040000'
    type: 'blob' | 'tree' | 'commit'; // symlinks are blobs; submodules (gitlinks) are commits
    oid: string;
    path: string; // relative to the root of the listed tree, e.g. 'src/index.ts'
    size?: number; // blobs only, when `long` is set
  }[];
}
```

Entries come out in tree order, which is Git's order.

## formatLsTree

```typescript
formatLsTree(result: LsTreeResult, options?: { nameOnly?, long?, zeroTerminated? }): string
```

Renders a result exactly as `git ls-tree` prints it: one `<mode> SP <type> SP <oid> TAB <path>` line per entry.

| Option           | Type      | Default | Description                                                         |
| ---------------- | --------- | ------- | ------------------------------------------------------------------- |
| `nameOnly`       | `boolean` | `false` | Print only paths (`--name-only`)                                    |
| `long`           | `boolean` | `false` | Add the size column, right-aligned to 7 characters, `-` for non-blobs (`-l`). Use with `lsTree({ long: true })` |
| `zeroTerminated` | `boolean` | `false` | End entries with NUL instead of newline, and don't quote paths (`-z`) |

Without `zeroTerminated`, paths that contain control characters, `"`, `\` or non-ASCII bytes are quoted with C-style and octal escapes, as Git does with `core.quotePath=true`. The same quoting function is exported as `quoteGitPath(path)`.

## Example

```typescript
import { GitClient, MemoryFS, lsTree, formatLsTree } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const dir = '/repo';
const git = new GitClient({ fs, dir });

await git.init();
await fs.writeFile('/repo/README.md', '# Hello\n');
await fs.writeFile('/repo/src/index.ts', 'export {};\n');
await git.addAll();
await git.commit('Initial commit', { name: 'Ada', email: 'ada@example.com' });

const { entries } = await lsTree({ fs, dir, tree: 'HEAD' });
for (const e of entries) {
  console.log(e.mode, e.type, e.oid.slice(0, 7), e.path);
}
// 100644 blob fec5601 README.md
// 040000 tree fed41f1 src

// git ls-tree -r HEAD
console.log(formatLsTree(await lsTree({ fs, dir, tree: 'HEAD', recursive: true })));
// 100644 blob fec56017dc1b1ac87ad6e54e3cb3a20bb8dcc5ab	README.md
// 100644 blob cb0ff5c3b541f646105198ee23ac0fc3d805023e	src/index.ts

// git ls-tree -r -t HEAD
await lsTree({ fs, dir, tree: 'HEAD', recursive: true, showTrees: true });
// README.md, src, src/index.ts

// git ls-tree -l HEAD
const long = await lsTree({ fs, dir, tree: 'HEAD', long: true });
console.log(formatLsTree(long, { long: true }));
// 100644 blob fec56017dc1b1ac87ad6e54e3cb3a20bb8dcc5ab       8	README.md
// 040000 tree fed41f1f7930e950775bef1dee347e695bf21c27       -	src

// git ls-tree --name-only HEAD src/
const src = await lsTree({ fs, dir, tree: 'HEAD', paths: ['src/'] });
console.log(formatLsTree(src, { nameOnly: true }));
// src/index.ts

// git ls-tree -d HEAD
await lsTree({ fs, dir, tree: 'HEAD', treesOnly: true });
// only the src entry
```

## See also

- [cat-file](/plumbing/cat-file/): read individual objects (`pretty` prints trees in this format)
- [log](/commands/log/): find commit and tree OIDs
