---
title: Working with remotes
description: How TS-Git talks to other repositories — transports, authentication, CORS and what is supported.
---

TS-Git can clone, fetch, push and pull. It speaks git's **smart HTTP protocol** (v0/v1) directly using `fetch`, so the same code works in browsers, Node 18+, Deno, Bun and Tauri webviews.

```typescript
import { GitClient, createMemoryFS } from '@keydown-app/ts-git';

const git = new GitClient({ fs: createMemoryFS(), dir: '/repo' });
await git.clone('https://github.com/keydown-dev/ts-git.git', {
  corsProxy: 'https://cors.isomorphic-git.org', // only needed in browsers
});
```

## Transports

| URL | Transport | Notes |
| --- | --- | --- |
| `https://…`, `http://…` | `HttpTransport` | Smart HTTP. Dumb HTTP servers are rejected with a clear error. |
| `/path/to/repo`, `file:///path` | `LocalTransport` | A repository reachable through the same `FSAdapter` — another folder, a bare repo, a second in-memory repo. |
| `ssh://`, `git@host:path`, `git://` | — | Not supported: they need raw sockets, which browsers don't provide. |

Every remote command also accepts a `transport` option, so you can talk to a repository on a **different** filesystem, or plug in your own channel:

```typescript
import { LocalTransport, fetch } from '@keydown-app/ts-git';

const hub = new LocalTransport({ fs: otherFs, path: '/hub.git', url: 'mem://hub' });
await fetch({ fs, dir: '/repo', remote: 'mem://hub', transport: hub });
```

`GitTransport` is a three-method interface (`listRefs`, `fetchPack`, `pushPack`) if you want to bridge over WebSockets, a native plugin or a test double.

## Authentication

Pass credentials up front, embed them in the URL, or answer a callback when the server replies `401`:

```typescript
const git = new GitClient({
  fs,
  dir: '/repo',
  remote: {
    // Called on 401; return credentials to retry, or nothing to give up.
    onAuth: async (url) => ({ username: 'x-access-token', password: token }),
    onAuthFailure: (url) => console.warn('rejected credentials for', url),
  },
});

// Or per call / up front:
await git.push({ auth: { username: 'alice', password: token } });
await git.fetch({ auth: { headers: { Authorization: `Bearer ${token}` } } });
```

Credentials embedded in a URL (`https://user:token@host/repo.git`) are used for requests and stripped from `FETCH_HEAD` and merge messages, like git does.

## Browsers and CORS

Most git hosts don't send CORS headers, so browsers block direct requests. Route them through a CORS proxy with `corsProxy` (same URL convention as isomorphic-git, so `https://cors.isomorphic-git.org` or a self-hosted `@isomorphic-git/cors-proxy` works). Tauri and Node apps don't need a proxy. You can also supply your own `http` client (any object with `request(req) => Promise<res>`) to route through a native HTTP layer.

## Progress

`onProgress` receives the server's progress messages (`Counting objects…`, `Compressing objects…`) and local phases:

```typescript
await git.fetch({ onProgress: ({ phase, message }) => console.log(phase, message) });
```

## Compatibility

Everything here is tested against canonical git: the test suite runs `git http-backend` as the server and checks results with `git fsck --strict`, `git for-each-ref`, `git status` and friends. Packfiles TS-Git indexes produce `.idx` files byte-identical to `git index-pack`, `FETCH_HEAD` matches git's format, and merge commits are byte-identical to `git merge`'s.

### Not supported yet

- Shallow clones (`depth`), partial clone filters and protocol v2
- `pull --rebase`, octopus merges and rename detection during merges (renames merge as delete + add)
- Criss-cross merges use the first merge base rather than git's recursive virtual base
- SSH and `git://` transports
