---
title: commit
description: Record the staged changes as a new commit.
---

Write a tree from the current index, create a commit object pointing at it and advance the current branch.

## GitClient method

```typescript
await git.commit(message: string, author: Author): Promise<string>
```

| Parameter | Type     | Description                                    |
| --------- | -------- | ---------------------------------------------- |
| `message` | `string` | Commit message                                 |
| `author`  | `Author` | Author identity. Also used as the committer.   |

Returns the 40-character SHA-1 of the new commit.

### Author

```typescript
interface Author {
  name: string;
  email: string;
  timestamp?: number; // seconds since the Unix epoch, defaults to now
  timezoneOffset?: number; // minutes, defaults to the local offset
}
```

## Standalone function

```typescript
import { commit } from '@keydown-app/ts-git';

const oid = await commit({ fs, dir, message, author });
```

| Option           | Type       | Default              | Description                                                          |
| ---------------- | ---------- | -------------------- | -------------------------------------------------------------------- |
| `fs`             | `FSAdapter`| **required**         | Filesystem adapter                                                   |
| `dir`            | `string`   | **required**         | Working tree root                                                    |
| `gitdir`         | `string`   | `<dir>/.git`         | Git directory                                                        |
| `message`        | `string`   | **required**         | Commit message                                                       |
| `author`         | `Author`   | **required**         | Author identity                                                      |
| `committer`      | `Author`   | `author`             | Committer identity, if different from the author                     |
| `ref`            | `string`   | current branch       | Branch to update instead, e.g. `'release'` or `'refs/heads/release'` |
| `parent`         | `string[]` | `HEAD` commit        | Explicit parent commit OIDs                                          |
| `dryRun`         | `boolean`  | `false`              | Write the commit object but don't move any ref                       |
| `noUpdateBranch` | `boolean`  | `false`              | Don't update the branch or `HEAD` after committing                   |

## Empty commits

If the tree hasn't changed since the parent commit, `commit` throws `EmptyCommitError` ("nothing to commit, working tree clean"). An initial commit with an empty index throws the same error. Passing explicit `parent` OIDs skips the "unchanged tree" check.

```typescript
import { EmptyCommitError } from '@keydown-app/ts-git';

try {
  await git.commit('WIP', author);
} catch (err) {
  if (!(err instanceof EmptyCommitError)) throw err;
}
```

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });
const author = { name: 'John Doe', email: 'john@example.com' };

await git.init();

await fs.writeFile('/my-repo/README.md', '# My Project\n');
await git.add('README.md');
const first = await git.commit('Initial commit', author);

await fs.writeFile('/my-repo/src/index.ts', 'console.log("hello");\n');
await git.add('src/index.ts');
await git.commit('Add index.ts', author);

const commits = await git.log();
console.log(commits.length); // 2
console.log(commits[1].oid === first); // true
```

## See also

- [add](/commands/add/): stage files
- [log](/commands/log/): read commit history
