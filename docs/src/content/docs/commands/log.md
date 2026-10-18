---
title: log
description: Read commit history starting from HEAD.
---

Walk the commit history from `HEAD`, newest first.

## GitClient method

```typescript
await git.log(depth?: number): Promise<LogEntry[]>
```

| Parameter | Type     | Default     | Description                         |
| --------- | -------- | ----------- | ----------------------------------- |
| `depth`   | `number` | all commits | Maximum number of commits to return |

Returns an empty array if the repository has no commits yet.

### LogEntry

```typescript
interface LogEntry {
  oid: string;
  commit: CommitObject;
}

interface CommitObject {
  message: string;
  tree: string; // tree OID
  parent: string[]; // parent commit OIDs
  author: {
    name: string;
    email: string;
    timestamp: number; // seconds since the Unix epoch
    timezoneOffset: number;
  };
  committer: {
    name: string;
    email: string;
    timestamp: number;
    timezoneOffset: number;
  };
  gpgsig?: string;
}
```

:::note
History is followed through **first parents** only, like `git log --first-parent`. Log always starts at `HEAD`. To read a commit from somewhere else, use [`readCommit`](#readcommit).
:::

## Standalone function

```typescript
import { log } from '@keydown-app/ts-git';

await log({ fs, dir, depth? }): Promise<LogEntry[]>
```

| Option   | Type        | Default      | Description                  |
| -------- | ----------- | ------------ | ---------------------------- |
| `fs`     | `FSAdapter` | **required** | Filesystem adapter           |
| `dir`    | `string`    | **required** | Working tree root            |
| `gitdir` | `string`    | `<dir>/.git` | Git directory                |
| `depth`  | `number`    | all commits  | Maximum commits to return    |

## readCommit

Read a single commit by its OID. Returns the same `LogEntry` shape.

```typescript
import { readCommit } from '@keydown-app/ts-git';

const { oid, commit } = await readCommit({ fs, dir, oid: 'a1b2c3...' });
console.log(commit.message, commit.parent);
```

Throws `ObjectNotFoundError` if the object doesn't exist.

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });
const author = { name: 'John Doe', email: 'john@example.com' };

await git.init();

await fs.writeFile('/my-repo/file1.txt', 'content1');
await git.add('file1.txt');
await git.commit('First commit', author);

await fs.writeFile('/my-repo/file2.txt', 'content2');
await git.add('file2.txt');
await git.commit('Second commit', author);

const commits = await git.log();
console.log(commits.length); // 2
console.log(commits[0].commit.message); // 'Second commit'
console.log(commits[1].commit.message); // 'First commit'

// Only the most recent commit
const [latest] = await git.log(1);
console.log(new Date(latest.commit.author.timestamp * 1000));
```

## See also

- [commit](/commands/commit/): create commits
- [cat-file](/plumbing/cat-file/): inspect any object by OID
