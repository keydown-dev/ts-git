---
title: Introduction
description: What TS-Git is, what it supports today, and where it fits.
---

TS-Git is a pure TypeScript implementation of Git. It reads and writes standard `.git` repositories without native code or a `git` binary, so it runs anywhere JavaScript does: browsers, web workers, Node.js and desktop shells such as Tauri or Electron.

Storage is pluggable. Every read and write goes through a small [filesystem adapter](/filesystem/overview/) interface, so the same repository logic can work against an in-memory filesystem, the real disk, the browser's File System Access API or any other backend you can wrap.

## Key features

- **Pluggable filesystem**: ships an in-memory `MemoryFS`; bring your own adapter for anything else.
- **Remotes over HTTPS**: clone, fetch, push and pull using Git's smart HTTP protocol, plus local three-way merges.
- **Small footprint**: one runtime dependency ([`fflate`](https://github.com/101arrowz/fflate) for zlib). SHA-1 hashing uses the Web Crypto API.
- **Git compatible**: uses Git's on-disk formats (loose objects, packfiles, refs, index v2/v3). An interoperability test suite checks behaviour against the canonical Git CLI.
- **Browser native**: no Node-only APIs in the core.
- **Type safe**: strict TypeScript throughout, with typed options and results.

## Quick example

```typescript
import { GitClient, MemoryFS } from '@keydown-dev/ts-git';

// An in-memory filesystem. Swap in any FSAdapter.
const fs = new MemoryFS();

const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });
await git.init();

// Write a file through the adapter, then stage and commit it
await fs.writeFile('/my-repo/README.md', '# My Project\n');
await git.add('README.md');
await git.commit('Initial commit', {
  name: 'John Doe',
  email: 'john@example.com',
});

// View commit history (newest first)
const commits = await git.log();
console.log(commits[0].commit.message); // 'Initial commit'
```

## What's supported

### Everyday commands

| Command                           | Description                                         |
| --------------------------------- | --------------------------------------------------- |
| [`init`](/commands/init/)         | Initialize a new repository                         |
| [`add`](/commands/add/)           | Stage files, directories or all changes             |
| [`remove`](/commands/remove/)     | Remove paths from the index (`git rm --cached`)     |
| [`commit`](/commands/commit/)     | Record staged changes                               |
| [`status`](/commands/status/)     | Per-file status and the full status matrix          |
| [`log`](/commands/log/)           | Walk commit history from `HEAD`                     |
| [`branch`](/commands/branch/)     | List, create and delete branches                    |
| [`checkout`](/commands/checkout/) | Switch `HEAD` to another branch                     |
| [`reset`](/commands/reset/)       | Unstage paths, or move `HEAD` (`soft` / `mixed` / `hard`) |
| [`diff`](/commands/diff/)         | Compare worktree, index, commits and trees          |

### Remotes

| Command                       | Description                                              |
| ----------------------------- | -------------------------------------------------------- |
| [`clone`](/remote/clone/)     | Clone a repository over smart HTTP or from a local path  |
| [`remote`](/remote/remote/)   | Add, remove and list remotes; set URLs and upstreams     |
| [`fetch`](/remote/fetch/)     | Download objects and update remote-tracking branches     |
| [`push`](/remote/push/)       | Update remote refs and send the objects they need        |
| [`pull`](/remote/pull/)       | Fetch and merge the upstream branch                      |
| [`merge`](/remote/merge/)     | Fast-forward or three-way merge, with conflict state     |

See [Working with remotes](/remote/overview/) for transports, authentication and CORS.

### Plumbing

Low-level access to the object database and index: [`cat-file`](/plumbing/cat-file/), [`hash-object`](/plumbing/hash-object/), [`ls-tree`](/plumbing/ls-tree/) and [`update-index`](/plumbing/update-index/).

### Not yet

TS-Git is in **alpha**, and APIs may still change. Rebase, cherry-pick, tags, stash, shallow clones and SSH are not implemented yet. See the [roadmap](/roadmap/) for details and known limitations.

## Next steps

- [Installation](/getting-started/installation/): add TS-Git to your project
- [Quick Start](/getting-started/quickstart/): a step-by-step first repository
- [How TS-Git works](/concepts/architecture/): adapters, `GitClient` and the command functions
