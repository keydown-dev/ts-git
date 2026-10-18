---
title: CommandParser
description: An embeddable, Git-like command line for TS-Git, for terminals and REPLs in your app.
---

`@keydown-app/ts-git/cli` exports `CommandParser`, which turns command strings such as `git status` or `git diff --cached --stat` into results you can render. It's designed for embedded terminals in web and desktop apps, and also includes a few shell-style helpers (`ls`, `cd`, `cat`, ...) for demo environments.

It's part of the main package, so there's nothing extra to install:

```typescript
import { CommandParser, type CommandContext } from '@keydown-app/ts-git/cli';
```

## Usage

`execute` takes the command string and a `CommandContext` describing where and as whom to run it:

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';
import { CommandParser, type CommandContext } from '@keydown-app/ts-git/cli';
import { myersLineDiff } from '@keydown-app/ts-git-diff-myers';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/workspace', lineDiffAlgorithm: myersLineDiff });
const parser = new CommandParser();

const context: CommandContext = {
  currentDir: '/workspace',
  fs,
  git,
  author: { name: 'Ada Lovelace', email: 'ada@example.com' },
};

const result = await parser.execute('git init main', context);
console.log(result.output);
// Initialized empty Git repository with default branch 'main'
```

A shared instance is also exported as `commandParser`.

### CommandContext

```typescript
interface CommandContext {
  currentDir: string; // used by shell helpers (cd, ls, cat, ...)
  fs: FSAdapter; // the same adapter the GitClient uses
  git: GitClient; // runs the git commands
  author: Author; // identity used by `git commit`
  copy?: EmbeddedCliCopy; // optional text overrides, see below
}
```

### CommandResult

```typescript
interface CommandResult {
  success: boolean;
  output: string; // text to print; '__CLEAR__' for the `clear` command
  shouldRefreshGit: boolean; // true when repository state changed (refresh your UI)
  newDirectory?: string; // set by `cd`: update context.currentDir
}
```

Errors are caught and returned as `{ success: false, output: 'Error: ...' }`, so `execute` doesn't throw for ordinary command failures.

## Supported commands

The `git` prefix is optional: `git status` and `status` are equivalent. `git` on its own prints Git-style help.

| Command                                | Description                                                     |
| -------------------------------------- | --------------------------------------------------------------- |
| `init [branch]`                        | Initialize a repository (default branch `master`)               |
| `add <file>`, `add -A`, `add .`        | Stage a file, or all changes                                    |
| `rm <file>...`                         | Remove paths from the index                                     |
| `commit -m <message>`                  | Commit staged changes as `context.author`                       |
| `status`                               | Branch plus staged, unstaged and untracked files                |
| `log`                                  | The last 10 commits                                             |
| `branch`, `branch <name>`              | List branches, or create one                                    |
| `branch -d <name>`, `branch -D <name>` | Delete a branch (`-D` forces)                                   |
| `checkout <branch>`                    | Switch `HEAD` to a branch                                       |
| `reset [<file>...]`                    | Unstage everything, or specific paths                           |
| `diff [options] [<commit>[..<commit>]] [-- <path>...]` | Show changes (see below)                        |
| `merge <commit>`                       | Merge into the current branch (`--ff-only`, `--no-ff`, `-m <msg>`, `--abort`) |
| `clone <url> [<dir>]`                  | Clone into `<dir>` (default: name from the URL); `-b <branch>`, `--single-branch`, `--no-checkout` |
| `remote`, `remote -v`                  | List remotes; also `add <name> <url>`, `remove <name>`, `set-url [--push]`, `get-url` |
| `fetch [<remote>] [<refspec>...]`      | Fetch with git-style ref update output; `--prune`, `--tags`, `--no-tags` |
| `pull [<remote>] [<branch>]`           | Fetch and merge the upstream; `--ff-only`, `--no-ff`, `--prune`   |
| `push [<remote>] [<refspec>...]`       | Push; `-u`, `--force`, `--delete`, `--tags`, `--atomic`           |

`diff` accepts `--cached` / `--staged`, `--name-only`, `--name-status` and `--stat`, plus `<commit>`, `<a>..<b>` and `-- <paths>`. It requires the `GitClient` to have a `lineDiffAlgorithm`.

Shell helpers for demo terminals: `ls`/`dir`, `cd`, `pwd`, `cat`/`type`, `touch`, `mkdir`, `edit` (prints a file), `rename`/`mv`, `delete`, `clear` and `help`.

Arguments are split like a shell would: single and double quotes group words (`git commit -m "Initial commit"`), and a backslash escapes the next character. The exported `tokenizeCommand()` does the splitting if you need it elsewhere.

Remote commands use the `GitClient`'s remote defaults (`new GitClient({ remote: { corsProxy, onAuth, … } })`), so set those once for your terminal.

## Customizing text

Help text and a few prompts can be replaced per host app through `context.copy`. Unspecified keys fall back to `defaultEmbeddedCliCopy`.

```typescript
import { defaultEmbeddedCliCopy, type EmbeddedCliCopy } from '@keydown-app/ts-git/cli';

const copy: EmbeddedCliCopy = {
  noFolderSelectedPrompt: 'Open a project from the sidebar to get started.',
  unknownCommandHint: "Type 'help' to see what this terminal can do.",
  fullHelpText: defaultEmbeddedCliCopy.fullHelpText + '\n\nTip: press ↑ for history.',
  // gitHelpText: shown for a bare `git`
};

await parser.execute('help', { ...context, copy });
```

## Example: a minimal web terminal

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';
import { CommandParser, type CommandContext } from '@keydown-app/ts-git/cli';

const fs = new MemoryFS();
const parser = new CommandParser();
const context: CommandContext = {
  currentDir: '/workspace',
  fs,
  git: new GitClient({ fs, dir: '/workspace' }),
  author: { name: 'Web User', email: 'user@example.com' },
};

const lines: string[] = [];

async function run(command: string) {
  lines.push(`$ ${command}`);
  const result = await parser.execute(command, context);

  if (result.output === '__CLEAR__') lines.length = 0;
  else if (result.output) lines.push(result.output);

  if (result.newDirectory) context.currentDir = result.newDirectory;
  if (result.shouldRefreshGit) {
    // e.g. re-render a file tree or status panel
  }

  render();
}

function render() {
  document.querySelector('#terminal')!.textContent = lines.join('\n');
}

await run('git init main');
await fs.writeFile('/workspace/README.md', '# Hello\n');
await run('git add README.md');
await run('git commit -m first');
await run('git log');
```

The [examples in the repository](https://github.com/keydown-dev/ts-git/tree/master/examples) include complete terminal UIs built on `CommandParser`.

## See also

- [GitClient](/concepts/git-client/): what the parser calls under the hood
- [diff](/commands/diff/): diff options and formats
