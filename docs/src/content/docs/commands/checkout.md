---
title: checkout
description: Switch HEAD to another branch.
---

Point `HEAD` at an existing branch, so that subsequent commits land on it.

:::caution[HEAD only, for now]
`checkoutBranch` currently updates `HEAD` only. It does **not** rewrite files in the working tree or reset the index to match the target branch. Files that differ between branches stay as they are on disk, and `status` compares them against the new `HEAD`. Full working-tree checkout is on the [roadmap](/roadmap/).
:::

## GitClient method

```typescript
await git.checkoutBranch(ref: string): Promise<void>
```

| Parameter | Type     | Description                                 |
| --------- | -------- | ------------------------------------------- |
| `ref`     | `string` | Branch name to switch to (without `refs/heads/`) |

Throws `NotFoundError` if the branch doesn't exist.

You can also create and switch in one step with [`git.branch(name, true)`](/commands/branch/).

## Standalone function

```typescript
import { checkoutBranch } from '@keydown-app/ts-git';

await checkoutBranch({ fs, dir, ref }): Promise<void>
```

| Option   | Type        | Default      | Description               |
| -------- | ----------- | ------------ | ------------------------- |
| `fs`     | `FSAdapter` | **required** | Filesystem adapter        |
| `dir`    | `string`    | **required** | Working tree root         |
| `gitdir` | `string`    | `<dir>/.git` | Git directory             |
| `ref`    | `string`    | **required** | Branch name to switch to  |

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
await git.branch('feature');
await git.checkoutBranch('feature');

await fs.writeFile('/my-repo/feature.txt', 'New feature');
await git.add('feature.txt');
await git.commit('Add feature', author);

// Switch back to main
await git.checkoutBranch('main');
console.log((await git.listBranches()).current); // 'main'

// The working tree and index were not rewritten:
console.log(await fs.exists('/my-repo/feature.txt')); // true
console.log(await git.status('feature.txt')); // 'added' (relative to main)
```

## See also

- [branch](/commands/branch/): create and manage branches
- [How TS-Git works](/concepts/architecture/#the-working-tree-is-yours): who owns the working tree
