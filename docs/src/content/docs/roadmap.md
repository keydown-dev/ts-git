---
title: Roadmap & Limitations
description: What TS-Git implements today, what's coming next, and known limitations.
---

TS-Git is in **alpha** and under active development. APIs may change between releases. This page tracks what's implemented, what's planned and the known limitations.

## Implemented

### Everyday commands

| Command                           | Notes                                                                    |
| --------------------------------- | ------------------------------------------------------------------------ |
| [`init`](/commands/init/)         | Custom default branch and Git directory, bare repos, safe re-init        |
| [`add`](/commands/add/)           | Pathspecs and globs, deletions, modes, symlinks, `.gitignore`, `addAll` (`-A`) |
| [`remove`](/commands/remove/)     | Index only, like `git rm --cached` (with `-r` / `-f`)                    |
| [`commit`](/commands/commit/)     | Message cleanup, `allowEmpty`, explicit parents, dry runs, concludes merges |
| [`status`](/commands/status/)     | Output identical to `git status --porcelain=v1 --no-renames` (untracked modes, ignored, unmerged codes), status matrix and per-file strings; racy-git safe |
| [`log`](/commands/log/)           | All parents in `git log` order from any revision, `firstParent`, shallow boundaries, plus `readCommit` |
| [`branch`](/commands/branch/)     | Create at any revision, name validation, list, delete with merge check   |
| [`checkout`](/commands/checkout/) | Updates index and working tree like `git switch`; `force` and `detach`   |
| [`reset`](/commands/reset/)       | Unstage paths; `soft` / `mixed` / `hard` to any revision, `ORIG_HEAD`    |
| [`diff`](/commands/diff/)         | Worktree, index, commits and trees, `A..B` and `A...B`; patch, stat, name-only and name-status output byte-identical to `git diff` |

### Remote commands

| Command                       | Notes                                                                     |
| ----------------------------- | ------------------------------------------------------------------------- |
| [`clone`](/remote/clone/)     | Branch / tag / single-branch / no-checkout; matches `git clone`'s refs and config |
| [`remote`](/remote/remote/)   | Add, remove, list, set-url (incl. push URL), set upstream                 |
| [`fetch`](/remote/fetch/)     | Refspecs, tag following, prune, git-format `FETCH_HEAD`                   |
| [`push`](/remote/push/)       | Fast-forward checks, force, delete, tags, atomic, set-upstream            |
| [`pull`](/remote/pull/)       | Fetch + merge of the upstream, honours `pull.ff`                          |
| [`merge`](/remote/merge/)     | Fast-forward, three-way merge with git's conflict state, `abortMerge`     |

Transports: smart HTTP(S) via `fetch` (auth callbacks, CORS proxy) and local repositories through any `FSAdapter`. See [Working with remotes](/remote/overview/) for details and current limitations (no shallow clones, SSH or `pull --rebase` yet).

### Plumbing

| Command                                   | Notes                                                       |
| ----------------------------------------- | ----------------------------------------------------------- |
| [`cat-file`](/plumbing/cat-file/)         | `-t` / `-s` / `-e` / `-p` and parsed objects, including tags; revision syntax (`v1^{}`, `HEAD~2`, `rev:path`, `:path`, abbreviated OIDs) |
| [`hash-object`](/plumbing/hash-object/)   | Content or files, `-t` with format checks, `--literally`, `-w`; never touches the index |
| [`ls-tree`](/plumbing/ls-tree/)           | Any tree-ish; `-r` / `-t` / `-d` / `-l`, pathspecs, and `formatLsTree` for `--name-only` / `-z` output |
| [`update-index`](/plumbing/update-index/) | `--add` / `--remove` / `--force-remove` / `--cacheinfo`; writes blobs, honours modes and symlinks |

### Platform

- **Pluggable filesystem adapters**: `MemoryFS` built in; a [Node adapter](/filesystem/node/) to copy, and Tauri and File System Access adapters in the [examples](https://github.com/keydown-dev/ts-git/tree/master/examples)
- **Reads and writes existing repositories**: loose objects, packfiles, packed refs, index v2/v3
- **Embedded CLI**: [`CommandParser`](/cli/command-parser/) for in-app terminals
- **Pluggable line diff**: bring your own `LineDiffAlgorithm`, or use `@keydown-dev/ts-git-diff-myers`

## Planned

- `rebase` and `cherry-pick`
- Shallow clones and protocol v2
- `stash`
- `tag` (lightweight and annotated)
- `config` get/set
- `show`
- Exporting a Node.js filesystem adapter from the package

## Known limitations

### Config

- Writing `.git/config` (adding a remote, setting an upstream, …) re-serializes the whole file: every value is preserved, but comments and custom formatting are not.

### Index

- **Index version 4** is rejected. Use index version 2 or 3 (for example, `git config core.indexVersion 3` and re-index).
- **Unmerged (multi-stage) entries** are reported with Git's conflict codes by `statusPorcelain`, but `statusMatrix` collapses them to a single representative stage and `diff` leaves them out. `commit` and `checkoutBranch` refuse to run while unmerged entries exist (`UnmergedPathsError`); stage the resolved files with `add` first.
- **assume-unchanged / skip-worktree** flags are parsed, but status may not match Git's behaviour in every case.

### Diff

- **Rename and copy detection** (`-M`, `-C`): moves appear as a deletion plus an addition.
- **Binary files**: detected, but not content-diffed.
- **Function context**: only Git's default rule; `diff` attributes and custom `xfuncname` patterns aren't applied.
- **No-index mode** (`--no-index`), **range notation** (`A^!`, `A^@`), **word diff**, **colour output** and **`diff.*` config** aren't supported.

### Other

- **Submodules**: not supported
- **Hooks**: not executed
- **Signed commits**: GPG signing isn't supported
- **Embedded CLI**: covers the [supported commands](/cli/command-parser/#supported-commands) only; `git tag`, for example, isn't available yet

## Contributing

TS-Git is open source and contributions are welcome. Visit the [GitHub repository](https://github.com/keydown-dev/ts-git) to report issues, suggest features or open a pull request.

## API stability

As alpha software, TS-Git's APIs may change. Breaking changes will be called out in release notes.
