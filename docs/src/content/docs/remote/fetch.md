---
title: fetch
description: Download objects and refs from another repository.
---

Equivalent to `git fetch [<remote>] [<refspec>...]`.

## GitClient

```typescript
await git.fetch(options?: {
  remote?: string;           // name, URL or path; default: upstream remote of the current branch, else 'origin'
  refspecs?: string[];       // override remote.<name>.fetch, e.g. ['main'] or ['+refs/heads/*:refs/remotes/origin/*']
  tags?: 'auto' | boolean;   // 'auto' (default) follows tags into fetched history; true = all tags; false = none
  prune?: boolean;           // delete remote-tracking refs that no longer exist (--prune)
  // shared remote options: auth, onAuth, corsProxy, http, headers, onProgress, transport
}): Promise<FetchResult>
```

```typescript
const result = await git.fetch({ prune: true });
for (const u of result.updates) {
  console.log(u.status, u.remoteRef, '->', u.localRef);
}
```

### FetchResult

```typescript
interface FetchResult {
  remote: string | null;      // null when fetching from a bare URL
  url: string;
  remoteHead: string | null;  // e.g. 'refs/heads/main'
  updates: RefUpdate[];
  fetchHead: FetchHeadEntry[];
  objectCount: number;        // objects received (0 when up to date)
}

interface RefUpdate {
  remoteRef: string | null;
  localRef: string;
  oldOid: string | null;
  newOid: string | null;
  status: 'new' | 'fast-forward' | 'forced' | 'up-to-date' | 'rejected' | 'pruned';
  reason?: string;            // e.g. 'non-fast-forward', 'would clobber existing tag'
}
```

## Behaviour

- Refspecs follow git's rules: a leading `+` allows non-fast-forward updates, `*` globs, `^` excludes. Without `+`, a non-fast-forward update is reported as `rejected` and the local ref is left alone.
- Short names (`main`, `v1.0`) are resolved against the remote's refs in git's order. Fetching an explicit ref also updates its remote-tracking ref ("opportunistic update").
- Existing tags are never moved unless the refspec is forced.
- `FETCH_HEAD` is written in git's format, marking the current branch's upstream (or the explicitly requested refs) as the merge candidates.
- Only missing objects are requested; the received pack is stored under `objects/pack/` with a git-compatible `.idx`.

## Standalone function

```typescript
import { fetch } from '@keydown-dev/ts-git';

await fetch({ fs, dir: '/repo', remote: 'upstream', refspecs: ['main'] });
```
