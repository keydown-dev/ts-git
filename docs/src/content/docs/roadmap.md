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
| [`status`](/commands/status/)     | Per-file status strings and the status matrix, honouring `.gitignore`    |
| [`log`](/commands/log/)           | First-parent history from `HEAD`, plus `readCommit`                      |
| [`branch`](/commands/branch/)     | Create at any revision, name validation, list, delete with merge check   |
| [`checkout`](/commands/checkout/) | Updates index and working tree like `git switch`; `force` and `detach`   |
| [`reset`](/commands/reset/)       | Unstage paths; `soft` / `mixed` / `hard` to any revision, `ORIG_HEAD`    |
| [`diff`](/commands/diff/)         | Worktree, index, commits and trees; patch, stat, name-only, name-status  |

### Plumbing

| Command                                   | Notes                                                       |
| ----------------------------------------- | ----------------------------------------------------------- |
| [`cat-file`](/plumbing/cat-file/)         | Type and pretty modes; structured tree/commit parsing is partial |
| [`hash-object`](/plumbing/hash-object/)   | Hash and optionally write blobs                             |
| [`ls-tree`](/plumbing/ls-tree/)           | Single level, by tree OID                                   |
| [`update-index`](/plumbing/update-index/) | `--add` / `--remove` (doesn't write blobs)                  |

### Platform

- **Pluggable filesystem adapters**: `MemoryFS` built in; Node, Tauri and File System Access adapters available as reference implementations
- **Reads existing repositories**: loose objects, packfiles, packed refs, index v2/v3
- **Embedded CLI**: [`CommandParser`](/cli/command-parser/) for in-app terminals
- **Pluggable line diff**: bring your own `LineDiffAlgorithm`, or use `@keydown-app/ts-git-diff-myers`

## In progress

### Remote support

Remote operations over Git's smart HTTP protocol are being implemented now:

- `remote`: manage remotes
- `clone`: clone a repository
- `fetch`: download objects and refs
- `push`: update remote refs
- `pull`: fetch and integrate

<!-- TODO(remote): link the remote command pages here and move them to "Implemented" once they land. -->

Follow progress in the [GitHub repository](https://github.com/keydown-dev/ts-git).

## Planned

- `merge`, `rebase` and `cherry-pick`
- `stash`
- `tag` (lightweight and annotated)
- `config` get/set
- `show`
- Exporting a Node.js filesystem adapter from the package
- Recursive `ls-tree` and ref resolution for plumbing commands

## Known limitations

### Index

- **Index version 4** is rejected. Use index version 2 or 3 (for example, `git config core.indexVersion 3` and re-index).
- **Unmerged (multi-stage) entries** are collapsed to a single representative stage for status and diff. `commit` and `checkoutBranch` refuse to run while unmerged entries exist (`UnmergedPathsError`); stage the resolved files with `add` first.
- **assume-unchanged / skip-worktree** flags are parsed, but status may not match Git's behaviour in every case.

### Diff

- **Rename and copy detection** (`-M`, `-C`): moves appear as a deletion plus an addition.
- **Merge-base diffs** (`A...B`): treated like `A..B`.
- **Binary files**: detected, but not content-diffed.
- **No-index mode** (`--no-index`), **range notation** (`A^!`, `A^@`), **word diff**, **colour output** and **`diff.*` config** aren't supported.

### Other

- **Submodules**: not supported
- **Hooks**: not executed
- **Signed commits**: GPG signing isn't supported
- **Embedded CLI parsing**: quoted arguments aren't interpreted (see [CommandParser](/cli/command-parser/))

## Contributing

TS-Git is open source and contributions are welcome. Visit the [GitHub repository](https://github.com/keydown-dev/ts-git) to report issues, suggest features or open a pull request.

## API stability

As alpha software, TS-Git's APIs may change. Breaking changes will be called out in release notes.
