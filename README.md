<div align="center">
  <img src="icon-macos.png" alt="TS-Git Logo" width="128" height="128">
  
  # TS-Git
  
  <p><strong>Pure TypeScript Git with pluggable filesystems and smart-HTTP remotes</strong></p>
  
  [![Alpha](https://img.shields.io/badge/status-alpha-orange?style=for-the-badge)](https://github.com/keydown/ts-git)
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  
  <p><em>⚠️ <strong>Warning:</strong> This project is in early alpha. APIs may change, and not all Git features are implemented yet.</em></p>
</div>

---

## About

TS-Git is a pure TypeScript implementation of Git that runs entirely in the browser or Node.js environment. It provides a Git-compatible API with pluggable filesystem adapters, allowing you to work with Git repositories using various storage backends.

### Key Features

- 🔧 **Pluggable Filesystem** - Works with in-memory, browser storage, or native filesystems
- 📦 **Zero Dependencies** - Lightweight implementation with minimal external dependencies
- 🧪 **Well Tested** - Comprehensive test suite with 470+ tests
- 🌐 **Browser Native** - Run Git operations directly in the browser
- 💪 **Type Safe** - Fully typed with TypeScript

## Installation

```bash
npm install @keydown-app/ts-git
```

The package also exports an optional embedded terminal command surface as `@keydown-app/ts-git/cli` (`CommandParser`, prompts overridable via `CommandContext.copy`).

## Quick Start

```typescript
import { GitClient, MemoryFSAdapter } from '@keydown-app/ts-git';

// Create a filesystem adapter (in-memory for this example)
const fs = new MemoryFSAdapter();

// Initialize Git client
const git = new GitClient({ fs, dir: '/my-repo' });

// Initialize a repository
await git.init({ defaultBranch: 'main' });

// Stage and commit files
await git.add('README.md');
await git.commit('Initial commit', {
  name: 'John Doe',
  email: 'john@example.com',
});

// View commit history
const commits = await git.log();
```

## Supported Git Commands

| Command             | Status           | Description                            |
| ------------------- | ---------------- | -------------------------------------- |
| `init`              | ✅ Supported     | Initialize a new Git repository        |
| `add <file>`        | ✅ Supported     | Stage file(s) for commit               |
| `add -A`            | ✅ Supported     | Stage all changes                      |
| `rm <file>`         | ✅ Supported     | Remove file(s) from index              |
| `commit -m`         | ✅ Supported     | Create a new commit                    |
| `status`            | ✅ Supported     | Show working tree status               |
| `log`               | ✅ Supported     | Show commit history                    |
| `branch`            | ✅ Supported     | List branches                          |
| `branch <name>`     | ✅ Supported     | Create new branch                      |
| `branch -d/-D`      | ✅ Supported     | Delete branch                          |
| `checkout <branch>` | ✅ Supported     | Switch branches                        |
| `reset [file]`      | ✅ Supported     | Unstage file(s)                        |
| `diff`              | ✅ Supported     | Show changes between commits/index/worktree |
| `diff --cached`     | ✅ Supported     | Show staged changes (index vs HEAD)      |
| `diff --name-only`  | ✅ Supported     | Show only names of changed files         |
| `diff --name-status`| ✅ Supported     | Show names and status of changed files |
| `diff --stat`       | ✅ Supported     | Show diffstat summary                  |

### Plumbing Commands (Low-Level API)

These commands provide direct access to Git's underlying object model. They are useful for building advanced tools or implementing custom version control workflows.

| Command              | Status           | Description                             |
| -------------------- | ---------------- | --------------------------------------- |
| `cat-file`           | ✅ Supported     | Read object content by OID              |
| `cat-file -t`        | ✅ Supported     | Show object type                        |
| `cat-file -p`        | ✅ Supported     | Pretty-print object content             |
| `hash-object`        | ✅ Supported     | Hash content and return OID             |
| `hash-object -w`     | ✅ Supported     | Hash and write to object store          |
| `ls-tree`            | ✅ Supported     | List tree entries by OID or ref         |
| `ls-tree -r`         | ✅ Supported     | Recursive tree listing                  |
| `update-index`       | ✅ Supported     | Manually update index entries           |
| `update-index --add` | ✅ Supported     | Stage file to index                     |
| `update-index --remove` | ✅ Supported   | Unstage file from index                 |

| `tag`               | ❌ Not Supported | Create, list, or delete tags           |
| `merge`             | ❌ Not Supported | Join development histories             |
| `rebase`            | ❌ Not Supported | Reapply commits on top of another base |
| `cherry-pick`       | ❌ Not Supported | Apply changes from specific commits    |
| `stash`             | ❌ Not Supported | Stash changes                          |
| `clone`             | ❌ Not Supported | Clone a repository                     |
| `fetch`             | ❌ Not Supported | Download objects from remote           |
| `pull`              | ❌ Not Supported | Fetch and merge                        |
| `push`              | ❌ Not Supported | Update remote refs                     |
| `remote`            | ❌ Not Supported | Manage tracked repositories            |
| `config`            | ❌ Not Supported | Get/set repository options             |
| `show`              | ❌ Not Supported | Show various types of objects          |

## Examples

### Web UI Example

Run the interactive web-based Git terminal:

```bash
npm run dev
```

This starts a development server with a terminal interface for testing Git commands.

### With Tauri (Desktop App)

```bash
npm run dev:tauri
```

### With ZenFS (Browser Filesystem)

```bash
npm run dev:zen
```

## Filesystem Adapters

TS-Git supports multiple filesystem adapters:

- **MemoryFSAdapter** - In-memory storage (great for testing)
- **TauriFSAdapter** - Native filesystem via Tauri
- **ZenFSAdapter** - Browser-based persistent storage
- **FileSystemAccessAdapter** - Native File System Access API
- **CustomFSAdapter** - Create your own custom filesystem adapter

To create your own filesystem adapter, you can extend the `FSAdapter` interface and implement the methods. See the [examples](examples) for more details.

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
npm run build

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint

# Format code
npm run format
```

## Project Structure

```
ts-git/
├── packages/
│   └── ts-git/          # Core Git implementation
│       ├── src/
│       │   ├── commands/  # Git command implementations
│       │   ├── core/      # Core Git objects (blob, tree, commit)
│       │   ├── client/    # GitClient wrapper class
│       │   ├── cli/       # Optional CommandParser (embedded terminal)
│       │   └── fs/        # Filesystem adapters
│       └── package.json
│   └── ts-git-ui/         # Web UI example
│       ├── src/
│       │   ├── components/ # Web UI components
│       │   ├── styles.css # Web UI styles
│       │   └── package.json
│   └── ts-git-diff-myers/ # Myers line diff implementation
│       ├── src/
│       │   ├── myers.ts
│       │   └── package.json
│   └── ts-git-diff-words/ # Prose/word diff implementation (placeholder)
│       ├── src/
│       │   ├── word.ts
│       │   └── package.json
├── examples/
│   ├── with-memory-fs/   # In-memory filesystem example
│   ├── with-tauri-fs/    # Desktop app example
│   └── with-zen-fs/      # Browser filesystem example
└── package.json
```

## Contributing

Contributions are welcome! This project is in early alpha, so please expect API changes as we stabilize the codebase.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Diff Command Implementation

The `diff` command is now implemented with the following capabilities:

### Supported Features

- **Worktree vs Index** (`git diff`): Shows unstaged changes in tracked files
- **Index vs HEAD** (`git diff --cached` or `--staged`): Shows staged changes
- **Commit comparisons** (`git diff A B`): Shows differences between two commits
- **Path filtering** (`git diff -- <path>`): Limits diff to specific paths
- **Output formats**:
  - Default unified diff with patch format
  - `--name-only`: Lists only changed filenames
  - `--name-status`: Shows status (A/M/D) and filenames
  - `--stat`: Shows diffstat summary

### Known Limitations

**Index and status**

- **Index version 4** is rejected; use Git index version 2 or 3 (e.g. `git config core.indexVersion 3` and re-index).
- **Unmerged (multi-stage) index entries** are collapsed to a single representative stage for status and diff (not full `UU` / conflict semantics).
- **assume-unchanged / skip-worktree** flags are parsed from CLI-produced indices but behavior may not match Git’s status rules in all cases.

The following `git diff` features are not yet implemented:

- **Rename detection** (`-M`, `-C`, `--find-renames`, `--find-copies`): Files moved or copied appear as separate deletions and additions
- **Merge-base diffs** (`--merge-base`, `A...B` syntax): Triple-dot notation treats both sides as regular commits
- **Binary file handling**: Binary files are detected but content diffing is not fully supported
- **No-index mode** (`--no-index`): Comparing paths outside a git repository
- **Range notation** (`A^!`, `A^@`): Special revision range syntaxes
- **Word diff** (`--word-diff`): Word-level diffs instead of line-level
- **Color output**: ANSI color codes in diff output
- **Config-driven defaults**: Respecting `diff.*` configuration options

### Output Compatibility

The unified diff output format follows Git's standard conventions:
- `diff --git a/<path> b/<path>` headers
- `index <oid>..<oid>` lines for modified files
- `new file mode` / `deleted file mode` indicators
- `--- a/<path>` / `+++ b/<path>` markers (with `/dev/null` for add/delete)
- Unified hunk headers with `@@ -l,s +l,s @@`
- Context lines prefixed with space, additions with `+`, deletions with `-`

Minor formatting differences from canonical Git output may exist in edge cases.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
