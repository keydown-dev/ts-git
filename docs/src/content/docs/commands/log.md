---
title: log
description: Read commit history from HEAD or any revision, in git log order.
---

Walk the commit history from `HEAD` (or any revision), returning commits in the same order as `git log`.

## GitClient method

```typescript
await git.log(depth?: number): Promise<LogEntry[]>
```

| Parameter | Type     | Default     | Description                                       |
| --------- | -------- | ----------- | ------------------------------------------------- |
| `depth`   | `number` | all commits | Maximum number of commits to return (`git log -n`) |

The client method always starts at `HEAD`. Use the [standalone function](#standalone-function) to start somewhere else or to follow first parents only.

Returns an empty array if the current branch has no commits yet.

### LogEntry

```typescript
interface LogEntry {
  oid: string;
  commit: CommitObject;
}

interface CommitObject {
  message: string; // verbatim, including the trailing newline
  tree: string; // tree OID
  parent: string[]; // parent commit OIDs, in order
  author: {
    name: string;
    email: string;
    timestamp: number; // seconds since the Unix epoch
    timezoneOffset: number; // minutes behind UTC, like Date#getTimezoneOffset()
  };
  committer: {
    name: string;
    email: string;
    timestamp: number;
    timezoneOffset: number;
  };
  gpgsig?: string;
  extraHeaders?: { key: string; value: string }[]; // e.g. encoding, mergetag
}
```

Commits are parsed byte-exactly: headers other than `tree`, `parent`, `author`, `committer` and `gpgsig` are kept in `extraHeaders`, in object order.

## Commit order

The walk matches Git's default revision walk, so the result is the same sequence `git log --format=%H` prints:

- **Every parent is followed**, so commits from merged branches are included. Each commit appears once.
- Pending commits are kept ordered by **committer date**, newest first. On equal dates, the commit queued first comes first, and a commit's parents are queued in parent order. This reproduces Git's output on histories with merges and clock skew.
- **Shallow repositories**: commits listed in `.git/shallow` are treated as roots, so the walk stops there instead of failing on missing parents.
- With `firstParent: true`, only the first parent of each merge is followed, like `git log --first-parent`.

## Standalone function

```typescript
import { log } from '@keydown-dev/ts-git';

await log({ fs, dir, ref?, depth?, firstParent? }): Promise<LogEntry[]>
```

| Option        | Type        | Default      | Description                                                  |
| ------------- | ----------- | ------------ | ------------------------------------------------------------ |
| `fs`          | `FSAdapter` | **required** | Filesystem adapter                                           |
| `dir`         | `string`    | **required** | Working tree root                                            |
| `gitdir`      | `string`    | `<dir>/.git` | Git directory                                                |
| `ref`         | `string`    | `'HEAD'`     | Where to start: any revision, e.g. a branch, tag, OID or `HEAD~2` |
| `depth`       | `number`    | all commits  | Maximum commits to return                                    |
| `firstParent` | `boolean`   | `false`      | Follow only first parents, like `--first-parent`             |

`ref` accepts the same [revision syntax](/plumbing/cat-file/#revision-syntax) as `cat-file`. Annotated tags are peeled to their commit. An unknown revision throws `ObjectNotFoundError`.

## readCommit

Read a single commit. Returns the same `LogEntry` shape.

```typescript
import { readCommit } from '@keydown-dev/ts-git';

const { oid, commit } = await readCommit({ fs, dir, oid: 'main~1' });
console.log(commit.message, commit.parent);
```

`oid` can be a full or abbreviated OID or any revision; tags are peeled to the commit they point at. Throws `ObjectNotFoundError` if it can't be resolved.

## Example

```typescript
import { GitClient, MemoryFS, log, type LogEntry } from '@keydown-dev/ts-git';

const fs = new MemoryFS();
const dir = '/my-repo';
const git = new GitClient({ fs, dir, defaultBranch: 'main' });
const author = { name: 'John Doe', email: 'john@example.com' };

await git.init();

await fs.writeFile('/my-repo/a.txt', '1\n');
await git.add('a.txt');
await git.commit('first', author);

// Work on a branch
await git.branch('feature', true);
await fs.writeFile('/my-repo/b.txt', 'feature\n');
await git.add('b.txt');
await git.commit('feature work', author);

// Meanwhile on main
await git.checkoutBranch('main');
await fs.writeFile('/my-repo/a.txt', '2\n');
await git.add('a.txt');
await git.commit('main work', author);

await git.merge('feature', { message: 'Merge feature', author });

const messages = (entries: LogEntry[]) => entries.map((e) => e.commit.message.trim());

console.log(messages(await git.log()));
// ['Merge feature', 'main work', 'feature work', 'first']

console.log(messages(await log({ fs, dir, firstParent: true })));
// ['Merge feature', 'main work', 'first']

console.log(messages(await log({ fs, dir, ref: 'feature' })));
// ['feature work', 'first']

// Only the most recent commit
const [latest] = await git.log(1);
console.log(new Date(latest.commit.author.timestamp * 1000));
```

## See also

- [commit](/commands/commit/): create commits
- [cat-file](/plumbing/cat-file/): inspect any object by OID or revision
