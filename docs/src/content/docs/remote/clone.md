---
title: clone
description: Clone a repository into a new directory.
---

Equivalent to `git clone <url> <dir>`: initialises the repository, adds the `origin` remote, fetches every branch and the tags pointing into them, creates the local branch for the remote's `HEAD`, records its upstream, and checks it out.

## GitClient

```typescript
await git.clone(url: string, options?: {
  remote?: string;        // remote name, default 'origin'
  ref?: string;           // branch or tag to check out instead of the remote HEAD
  singleBranch?: boolean; // only fetch that branch (--single-branch)
  noCheckout?: boolean;   // don't write files (--no-checkout)
  tags?: 'auto' | boolean;
  // plus the shared remote options: auth, onAuth, corsProxy, http, headers, onProgress, transport
}): Promise<CloneResult>
```

```typescript
const git = new GitClient({ fs, dir: '/project' });
const { branch, head } = await git.clone('https://example.com/team/project.git');
// branch === 'main', head === '<commit id>'
```

`CloneResult` is `{ fetch: FetchResult; branch: string | null; head: string | null }`. `branch` is `null` when a tag was checked out (detached `HEAD`) or the remote is empty; `head` is `null` for an empty remote.

## Behaviour

- The target directory must not exist or must be empty (`AlreadyExistsError` otherwise).
- `refs/remotes/origin/HEAD` is set to the remote's default branch, as git does.
- `ref: 'v1.0'` (a tag) checks out a detached `HEAD` at the tagged commit.
- `singleBranch` narrows `remote.origin.fetch` to that branch, so later fetches stay narrow.
- Cloning an empty repository succeeds with `head: null`.

## Standalone function

```typescript
import { clone } from '@keydown-dev/ts-git';

await clone({ fs, dir: '/project', url, ref: 'develop', singleBranch: true });
```
