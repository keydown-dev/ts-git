---
title: checkout
description: Switch branches, updating the index and working tree like git switch.
---

Switch to another branch, like `git switch <branch>` / `git checkout <branch>`. The index and working tree are updated to the branch's commit, then `HEAD` is pointed at the branch so that subsequent commits land on it.

The switch follows Git's two-way merge rules:

- Files that are identical in the current commit and the target commit are left alone, so **unrelated local changes (staged or not) are carried across the switch**.
- Files that differ between the two commits are rewritten (or removed) only when they have no local changes. File modes (executable bit), symlinks and file/directory transitions are handled, and directories left empty are pruned.
- If a local change or an untracked file would be overwritten, the switch is refused with `CheckoutConflictError` and **nothing is modified**: not the working tree, not the index, not `HEAD`. Untracked files that are ignored are overwritten, as in Git.
- Untracked files elsewhere in the working tree are never touched.

## GitClient method

```typescript
await git.checkoutBranch(
  ref: string,
  options?: { force?: boolean; detach?: boolean },
): Promise<CheckoutTreeResult>
```

| Parameter        | Type      | Default | Description                                                                                  |
| ---------------- | --------- | ------- | -------------------------------------------------------------------------------------------- |
| `ref`            | `string`  |         | Branch name to switch to (a leading `refs/heads/` is accepted)                               |
| `options.force`  | `boolean` | `false` | Discard local changes, like `git checkout -f`: the index and tracked files are made to match the target exactly, and untracked files in the way are replaced |
| `options.detach` | `boolean` | `false` | Detach `HEAD` at `ref`, which may then be any revision (OID, tag, `HEAD~1`, ...), like `git checkout --detach` |

Returns the paths that were written to and removed from the working tree:

```typescript
interface CheckoutTreeResult {
  updated: string[]; // created or changed files
  removed: string[]; // deleted files
}
```

You can also create and switch in one step with [`git.branch(name, true)`](/commands/branch/).

### Errors

| Situation                                                    | Error                   |
| ------------------------------------------------------------ | ----------------------- |
| The branch doesn't exist (or, with `detach`, the revision doesn't resolve) | `NotFoundError` |
| Local changes or untracked files would be overwritten        | `CheckoutConflictError` |
| The index has unmerged entries (and `force` isn't set)       | `UnmergedPathsError`    |

`CheckoutConflictError` lists the offending paths in two properties, mirroring Git's two messages:

```typescript
import { CheckoutConflictError } from '@keydown-app/ts-git';

try {
  await git.checkoutBranch('main');
} catch (err) {
  if (!(err instanceof CheckoutConflictError)) throw err;
  err.paths; // tracked files with local changes in the way
  err.untracked; // untracked files that would be overwritten
}
```

## Standalone functions

```typescript
import { checkoutBranch, checkoutTree } from '@keydown-app/ts-git';
```

### checkoutBranch

```typescript
await checkoutBranch({ fs, dir, ref, force?, detach? }): Promise<CheckoutTreeResult>
```

| Option   | Type        | Default      | Description                              |
| -------- | ----------- | ------------ | ---------------------------------------- |
| `fs`     | `FSAdapter` | **required** | Filesystem adapter                       |
| `dir`    | `string`    | **required** | Working tree root                        |
| `gitdir` | `string`    | `<dir>/.git` | Git directory                            |
| `ref`    | `string`    | **required** | Branch name (or revision with `detach`)  |
| `force`  | `boolean`   | `false`      | Discard local changes                    |
| `detach` | `boolean`   | `false`      | Detach `HEAD` at the revision            |

### checkoutTree

The building block behind `checkoutBranch`, `branch({ checkout: true })` and `reset({ mode: 'hard' })`. It switches the index and working tree from one tree to another and **doesn't move any ref**: call it, then update `HEAD` or a branch yourself. Use it for things like fast-forwarding a branch to a descendant commit.

```typescript
await checkoutTree({ fs, dir, from?, to, force?, dryRun? }): Promise<CheckoutTreeResult>
```

| Option   | Type             | Default      | Description                                                                                  |
| -------- | ---------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `fs`     | `FSAdapter`      | **required** | Filesystem adapter                                                                           |
| `dir`    | `string`         | **required** | Working tree root                                                                            |
| `gitdir` | `string`         | `<dir>/.git` | Git directory                                                                                |
| `from`   | `string \| null` | `HEAD`'s tree | Commit or tree OID the current index and working tree are based on. `null` means the empty tree |
| `to`     | `string`         | **required** | Commit or tree OID to switch to                                                              |
| `force`  | `boolean`        | `false`      | Discard local changes (one-way merge, like `git reset --hard`)                               |
| `dryRun` | `boolean`        | `false`      | Run the conflict checks and report what would change, without touching anything              |

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });
const author = { name: 'John Doe', email: 'john@example.com' };

await git.init();

await fs.writeFile('/my-repo/README.md', '# Main Branch');
await git.add('README.md');
await git.commit('Initial commit', author);

// Create a feature branch and switch to it
await git.branch('feature', true);

await fs.writeFile('/my-repo/feature.txt', 'New feature');
await git.add('feature.txt');
await git.commit('Add feature', author);

// Switch back to main: feature.txt is removed from disk and index
const { removed } = await git.checkoutBranch('main');
console.log(removed); // ['feature.txt']
console.log(await fs.exists('/my-repo/feature.txt')); // false

// Unrelated local changes survive a switch
await fs.writeFile('/my-repo/README.md', '# Edited locally');
await git.checkoutBranch('feature');
console.log(await fs.readFileString('/my-repo/README.md')); // '# Edited locally'

// Inspect an older commit with a detached HEAD
await git.checkoutBranch('HEAD~1', { detach: true });
console.log((await git.listBranches()).current); // null
```

## See also

- [branch](/commands/branch/): create and manage branches
- [reset](/commands/reset/): move a branch and optionally reset the working tree
- [How TS-Git works](/concepts/architecture/#the-working-tree-is-yours): who owns the working tree
