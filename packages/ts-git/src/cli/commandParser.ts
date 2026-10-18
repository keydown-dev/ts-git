/**
 * @fileoverview Optional embedded terminal / REPL command surface for TS-Git.
 * Includes git-style commands and demo shell helpers (cd, ls, touch, …).
 * Host apps may supply `CommandContext.copy` to replace default prompts/help text.
 */

import type { Author } from '../types.js';
import type { FSAdapter } from '../fs/types.js';
import type { GitClient } from '../client/index.js';
import { classifyStatusRow } from '../commands/status.js';
import { formatDiff } from '../commands/diff/index.js';
import {
  defaultEmbeddedCliCopy,
  type EmbeddedCliCopy,
} from './embeddedCopy.js';
import { resolveDiffInvocation } from './resolveDiffInvocation.js';

export interface CommandResult {
  success: boolean;
  output: string;
  shouldRefreshGit: boolean;
  newDirectory?: string;
}

export interface CommandContext {
  currentDir: string;
  fs: FSAdapter;
  git: GitClient;
  author: Author;
  /** Override default help strings / prompts for your host app. */
  copy?: EmbeddedCliCopy;
}

/**
 * Split a command line into arguments the way a POSIX shell does for the
 * common cases: whitespace separates words, single quotes are literal,
 * double quotes allow `\"` and `\\` escapes, and a backslash outside
 * quotes escapes the next character.
 */
export function tokenizeCommand(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else current += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
        current += line[++i];
      } else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < line.length) {
      current += line[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(current);
      current = '';
      inWord = false;
    } else {
      current += c;
      inWord = true;
    }
  }
  if (inWord) out.push(current);
  return out;
}

export class CommandParser {
  private copy(ctx: CommandContext): Required<EmbeddedCliCopy> {
    return { ...defaultEmbeddedCliCopy, ...ctx.copy };
  }

  async execute(
    command: string,
    context: CommandContext,
  ): Promise<CommandResult> {
    const trimmed = command.trim();
    if (!trimmed) {
      return { success: true, output: '', shouldRefreshGit: false };
    }

    const parts = tokenizeCommand(trimmed);
    let cmd = parts[0].toLowerCase();
    let args = parts.slice(1);

    // Handle "git <command>" format (e.g., "git init", "git add", etc.)
    if (cmd === 'git') {
      if (args.length === 0) {
        return this.handleGitHelp(context);
      }
      cmd = args[0].toLowerCase();
      args = args.slice(1);
    }

    try {
      switch (cmd) {
        case 'init':
          return await this.handleInit(context, args);
        case 'add':
          return await this.handleAdd(context, args);
        case 'commit':
          return await this.handleCommit(context, args);
        case 'status':
          return await this.handleStatus(context);
        case 'log':
          return await this.handleLog(context);
        case 'branch':
          return await this.handleBranch(context, args);
        case 'checkout':
          return await this.handleCheckout(context, args);
        case 'reset':
          return await this.handleReset(context, args);
        case 'rm':
          return await this.handleRm(context, args);
        case 'diff':
          return await this.handleDiff(context, args);
        case 'tag':
          return await this.handleTag();
        case 'rename':
        case 'mv':
          return await this.handleRename(context, args);
        case 'delete':
          return await this.handleDelete(context, args);
        case 'edit':
          return await this.handleEdit(context, args);
        case 'mkdir':
          return await this.handleMkdir(context, args);
        case 'touch':
          return await this.handleTouch(context, args);
        case 'ls':
        case 'dir':
          return await this.handleList(context, args);
        case 'cat':
        case 'type':
          return await this.handleCat(context, args);
        case 'cd':
          return await this.handleCd(context, args);
        case 'pwd':
          return await this.handlePwd(context);
        case 'help':
          return this.handleHelp(context);
        case 'clear':
          return {
            success: true,
            output: '__CLEAR__',
            shouldRefreshGit: false,
          };
        default:
          return {
            success: false,
            output: `Unknown command: ${cmd}. ${this.copy(context).unknownCommandHint}`,
            shouldRefreshGit: false,
          };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Check if this is a "No folder selected" error
      if (errorMessage.includes('No folder selected')) {
        console.error('No folder selected.');
        return {
          success: false,
          output: this.copy(context).noFolderSelectedPrompt,
          shouldRefreshGit: false,
        };
      }

      return {
        success: false,
        output: `Error: ${errorMessage}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleInit(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    try {
      const defaultBranch = args[0] || 'master';
      await context.git.init({ defaultBranch });
      return {
        success: true,
        output: `Initialized empty Git repository with default branch '${defaultBranch}'`,
        shouldRefreshGit: true,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleAdd(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        output: 'Usage: add <file> or add -A',
        shouldRefreshGit: false,
      };
    }

    try {
      if (args[0] === '-A' || args[0] === '.') {
        // Add all files
        await context.git.addAll();
        return {
          success: true,
          output: 'Added all changes to staging area',
          shouldRefreshGit: true,
        };
      } else {
        const filepath = args[0];
        await context.git.add(filepath);
        return {
          success: true,
          output: `Added '${filepath}' to staging area`,
          shouldRefreshGit: true,
        };
      }
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleCommit(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    const messageIndex = args.indexOf('-m');
    if (messageIndex === -1 || !args[messageIndex + 1]) {
      return {
        success: false,
        output: 'Usage: commit -m "<message>"',
        shouldRefreshGit: false,
      };
    }

    try {
      const message = args[messageIndex + 1];
      const oid = await context.git.commit(message, context.author);
      return {
        success: true,
        output: `Created commit: ${oid.slice(0, 7)}`,
        shouldRefreshGit: true,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleStatus(context: CommandContext): Promise<CommandResult> {
    try {
      const matrix = await context.git.statusMatrix();

      // Get current branch info
      let branchName = 'master';
      try {
        const { current } = await context.git.listBranches();
        if (current) {
          branchName = current;
        }
      } catch {
        // If we can't get branch info, default to 'master'
      }

      // Filter out clean files and classify the rest
      const changedFiles = matrix.filter((row) => {
        const classification = classifyStatusRow(row);
        return !classification.isClean;
      });

      // If no changed files, show clean status
      if (changedFiles.length === 0) {
        return {
          success: true,
          output: `On branch ${branchName}\nnothing to commit, working tree clean`,
          shouldRefreshGit: false,
        };
      }

      // Categorize files
      const staged: Array<{ filepath: string; status: string }> = [];
      const unstaged: Array<{ filepath: string; status: string }> = [];
      const untracked: string[] = [];

      for (const row of changedFiles) {
        const [filepath] = row;
        const classification = classifyStatusRow(row);

        // A staged deletion can coexist with an untracked file of the same
        // name, so these are not mutually exclusive.
        if (classification.isStaged) {
          staged.push({ filepath, status: classification.stagedStatus });
        }
        if (classification.isUnstaged) {
          unstaged.push({ filepath, status: classification.unstagedStatus });
        }
        if (classification.isUntracked) {
          untracked.push(filepath);
        }
      }

      // Build output in Git long-format style
      let output = `On branch ${branchName}\n`;

      // Staged changes section
      if (staged.length > 0) {
        output += '\nChanges to be committed:\n';
        output += '  (use "git restore --staged <file>..." to unstage)\n';
        for (const file of staged) {
          const statusDesc = this.getStatusDescription(file.status);
          output += `\t${statusDesc}:   ${file.filepath}\n`;
        }
      }

      // Unstaged changes section
      if (unstaged.length > 0) {
        output += '\nChanges not staged for commit:\n';
        output +=
          '  (use "git add <file>..." to update what will be committed)\n';
        for (const file of unstaged) {
          const statusDesc = this.getStatusDescription(file.status);
          output += `\t${statusDesc}:   ${file.filepath}\n`;
        }
      }

      // Untracked files section
      if (untracked.length > 0) {
        output += '\nUntracked files:\n';
        output +=
          '  (use "git add <file>..." to include in what will be committed)\n';
        for (const filepath of untracked) {
          output += `\t${filepath}\n`;
        }
      }

      return {
        success: true,
        output,
        shouldRefreshGit: false,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private getStatusDescription(status: string): string {
    switch (status) {
      case 'A':
        return 'new file';
      case 'M':
        return 'modified';
      case 'D':
        return 'deleted';
      case 'R':
        return 'renamed';
      case 'C':
        return 'copied';
      default:
        return 'modified';
    }
  }

  private async handleLog(context: CommandContext): Promise<CommandResult> {
    try {
      const commits = await context.git.log(10);
      if (commits.length === 0) {
        return {
          success: true,
          output: 'No commits yet.',
          shouldRefreshGit: false,
        };
      }

      let output = 'Commit history:\n';
      for (const commit of commits) {
        const date = new Date(commit.commit.committer.timestamp * 1000);
        output += `\ncommit ${commit.oid.slice(0, 7)}\n`;
        output += `Author: ${commit.commit.author.name} <${commit.commit.author.email}>\n`;
        output += `Date:   ${date.toLocaleString()}\n\n`;
        output += `    ${commit.commit.message}\n`;
      }

      return {
        success: true,
        output,
        shouldRefreshGit: false,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleBranch(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    try {
      // Check for delete flags
      const deleteIndex = args.findIndex((arg) => arg === '-d' || arg === '-D');
      const forceDeleteIndex = args.findIndex((arg) => arg === '-D');

      if (deleteIndex !== -1 || forceDeleteIndex !== -1) {
        // Delete branch mode
        const force = forceDeleteIndex !== -1;
        const branchName = args[args.length - 1]; // Last argument is branch name

        if (!branchName || branchName.startsWith('-')) {
          return {
            success: false,
            output: `usage: git branch [-d | -D] <branchname>`,
            shouldRefreshGit: false,
          };
        }

        try {
          await context.git.deleteBranch(branchName, force);
          return {
            success: true,
            output: `Deleted branch ${branchName}`,
            shouldRefreshGit: true,
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          // Check if it's a "not fully merged" error
          if (errorMessage.includes('not fully merged')) {
            return {
              success: false,
              output: `error: The branch '${branchName}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${branchName}'.`,
              shouldRefreshGit: false,
            };
          }
          return {
            success: false,
            output: `error: ${errorMessage}`,
            shouldRefreshGit: false,
          };
        }
      }

      if (args.length === 0) {
        // List branches
        const { branches, current } = await context.git.listBranches();
        let output = '';
        for (const branch of branches) {
          const prefix = branch === current ? '* ' : '  ';
          output += `${prefix}${branch}\n`;
        }
        return {
          success: true,
          output: output.trimEnd(),
          shouldRefreshGit: false,
        };
      } else {
        // Create branch
        const branchName = args[0];
        await context.git.branch(branchName);
        return {
          success: true,
          output: `Created branch '${branchName}'`,
          shouldRefreshGit: true,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `error: ${errorMessage}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleCheckout(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        output: 'Usage: checkout <branch>',
        shouldRefreshGit: false,
      };
    }

    try {
      const branchName = args[0];
      await context.git.checkoutBranch(branchName);
      return {
        success: true,
        output: `Switched to branch '${branchName}'`,
        shouldRefreshGit: true,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleReset(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    try {
      if (args.length === 0) {
        // Full reset
        const unstaged = await context.git.reset();
        if (unstaged.length === 0) {
          return {
            success: true,
            output: '',
            shouldRefreshGit: true,
          };
        }
        return {
          success: true,
          output: `Unstaged changes after reset:\nM\t${unstaged.join('\nM\t')}`,
          shouldRefreshGit: true,
        };
      } else {
        // Partial reset - handle file paths
        const files = args.filter((arg) => !arg.startsWith('-'));
        if (files.length === 0) {
          return {
            success: false,
            output: 'Usage: reset [<file>...]',
            shouldRefreshGit: false,
          };
        }
        const unstaged = await context.git.reset(files);
        if (unstaged.length === 0) {
          return {
            success: true,
            output: '',
            shouldRefreshGit: true,
          };
        }
        return {
          success: true,
          output: `Unstaged changes after reset:\nM\t${unstaged.join('\nM\t')}`,
          shouldRefreshGit: true,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `error: ${errorMessage}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleRm(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        output: 'Usage: rm <file>...',
        shouldRefreshGit: false,
      };
    }

    try {
      const files: string[] = [];

      for (const arg of args) {
        if (arg.startsWith('-')) {
          // Skip options for now (like -r, -f)
          continue;
        }
        files.push(arg);
      }

      if (files.length === 0) {
        return {
          success: false,
          output: 'Usage: rm <file>...',
          shouldRefreshGit: false,
        };
      }

      const removedFiles: string[] = [];
      for (const filepath of files) {
        try {
          await context.git.remove(filepath);
          removedFiles.push(filepath);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            success: false,
            output: `error: ${errorMessage}`,
            shouldRefreshGit: false,
          };
        }
      }

      if (removedFiles.length === 1) {
        return {
          success: true,
          output: `rm '${removedFiles[0]}'`,
          shouldRefreshGit: true,
        };
      } else {
        return {
          success: true,
          output: removedFiles.map((f) => `rm '${f}'`).join('\n'),
          shouldRefreshGit: true,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `error: ${errorMessage}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleDiff(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    try {
      // Parse options
      let cached = false;
      let outputMode: 'patch' | 'name-only' | 'name-status' | 'stat' = 'patch';
      const diffArgs: string[] = [];

      for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--cached' || arg === '--staged') {
          cached = true;
        } else if (arg === '--name-only') {
          outputMode = 'name-only';
        } else if (arg === '--name-status') {
          outputMode = 'name-status';
        } else if (arg === '--stat') {
          outputMode = 'stat';
        } else {
          diffArgs.push(arg);
        }
      }

      const { dir, gitdir } = context.git.requireRepository();
      const resolved = await resolveDiffInvocation(
        context.fs,
        dir,
        gitdir,
        diffArgs,
        cached,
      );

      const result = await context.git.diff({
        left: resolved.left,
        right: resolved.right,
        cached: resolved.cached || cached,
        paths: resolved.paths,
      });

      const formatted = formatDiff(result, outputMode);

      // Empty diff
      if (!formatted || formatted.length === 0) {
        return {
          success: true,
          output: '',
          shouldRefreshGit: false,
        };
      }

      return {
        success: true,
        output: formatted,
        shouldRefreshGit: false,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `error: ${errorMessage}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleTag(): Promise<CommandResult> {
    return {
      success: false,
      output: `tag: not yet implemented

This command has not been implemented yet in ts-git.
To implement tag, the following changes are needed:
  1. Add tag command to packages/ts-git/src/commands/tag.ts
  2. Export tag from packages/ts-git/src/commands/index.ts
  3. Add tag method to GitClient class
  4. Support listing, creating, and deleting tags
  5. Support lightweight and annotated tags`,
      shouldRefreshGit: false,
    };
  }

  private async handleRename(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        success: false,
        output: 'Usage: rename <old> <new>',
        shouldRefreshGit: false,
      };
    }

    try {
      const oldPath = this.resolvePath(context.currentDir, args[0]);
      const newPath = this.resolvePath(context.currentDir, args[1]);
      await context.fs.rename(oldPath, newPath);
      return {
        success: true,
        output: `Renamed '${args[0]}' to '${args[1]}'`,
        shouldRefreshGit: true,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleDelete(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        output: 'Usage: delete <file>',
        shouldRefreshGit: false,
      };
    }

    try {
      const filepath = this.resolvePath(context.currentDir, args[0]);
      const stats = await context.fs.stat(filepath);

      if (stats.isDirectory) {
        await context.fs.rmdir(filepath, { recursive: true });
      } else {
        await context.fs.unlink(filepath);
      }

      return {
        success: true,
        output: `Deleted '${args[0]}'`,
        shouldRefreshGit: true,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleEdit(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        output: 'Usage: edit <file>',
        shouldRefreshGit: false,
      };
    }

    try {
      const fullPath = this.resolvePath(context.currentDir, args[0]);

      let content = '';
      try {
        content = await context.fs.readFileString(fullPath);
      } catch {
        // File doesn't exist, will create on save
      }

      return {
        success: true,
        output: `__EDIT__:${fullPath}:${encodeURIComponent(content)}`,
        shouldRefreshGit: false,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleMkdir(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        output: 'Usage: mkdir <directory>',
        shouldRefreshGit: false,
      };
    }

    try {
      const dirpath = this.resolvePath(context.currentDir, args[0]);
      await context.fs.mkdir(dirpath, { recursive: true });
      return {
        success: true,
        output: `Created directory '${args[0]}'`,
        shouldRefreshGit: true,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleTouch(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        output: 'Usage: touch <file>',
        shouldRefreshGit: false,
      };
    }

    try {
      const filepath = this.resolvePath(context.currentDir, args[0]);
      const exists = await context.fs.exists(filepath);

      if (!exists) {
        await context.fs.writeFile(filepath, '');
        return {
          success: true,
          output: `Created file '${args[0]}'`,
          shouldRefreshGit: true,
        };
      } else {
        // Update timestamp by writing same content
        const content = await context.fs.readFile(filepath);
        await context.fs.writeFile(filepath, content);
        return {
          success: true,
          output: `Updated timestamp for '${args[0]}'`,
          shouldRefreshGit: true,
        };
      }
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleList(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    const path = args[0]
      ? this.resolvePath(context.currentDir, args[0])
      : context.currentDir;

    try {
      const entries = await context.fs.readdir(path);
      if (entries.length === 0) {
        return {
          success: true,
          output: `Directory '${path}' is empty`,
          shouldRefreshGit: false,
        };
      }

      let output = `Contents of ${path}:\n`;
      for (const entry of entries) {
        const icon = entry.isDirectory ? '📁' : '📄';
        output += `  ${icon} ${entry.name}\n`;
      }

      return {
        success: true,
        output,
        shouldRefreshGit: false,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleCat(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        output: 'Usage: cat <file>',
        shouldRefreshGit: false,
      };
    }

    try {
      const filepath = this.resolvePath(context.currentDir, args[0]);
      const content = await context.fs.readFileString(filepath);
      return {
        success: true,
        output: content,
        shouldRefreshGit: false,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handleCd(
    context: CommandContext,
    args: string[],
  ): Promise<CommandResult> {
    // cd with no args goes to root
    const targetPath = args[0] || '/';

    try {
      // Resolve the path relative to current directory
      const resolvedPath = this.resolveRelativePath(
        context.currentDir,
        targetPath,
      );

      // Validate it's within the root folder (bounds checking)
      if (!resolvedPath.startsWith('/')) {
        return {
          success: false,
          output: `Cannot navigate outside root folder`,
          shouldRefreshGit: false,
        };
      }

      // Check if target is a directory (skip check for root)
      if (resolvedPath !== '/') {
        try {
          const stats = await context.fs.stat(resolvedPath);
          if (!stats.isDirectory) {
            return {
              success: false,
              output: `Not a directory: ${targetPath}`,
              shouldRefreshGit: false,
            };
          }
        } catch {
          return {
            success: false,
            output: `No such file or directory: ${targetPath}`,
            shouldRefreshGit: false,
          };
        }
      }

      return {
        success: true,
        output: '',
        shouldRefreshGit: false,
        newDirectory: resolvedPath,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error}`,
        shouldRefreshGit: false,
      };
    }
  }

  private async handlePwd(context: CommandContext): Promise<CommandResult> {
    return {
      success: true,
      output: context.currentDir,
      shouldRefreshGit: false,
    };
  }

  private resolveRelativePath(currentDir: string, targetPath: string): string {
    // Handle absolute paths
    if (targetPath.startsWith('/')) {
      return this.normalizePath(targetPath);
    }

    // Handle ~ (home) - not allowed in sandbox
    if (targetPath.startsWith('~')) {
      return '~';
    }

    // Handle relative paths
    const currentParts = currentDir.split('/').filter(Boolean);
    const targetParts = targetPath.split('/').filter(Boolean);

    for (const part of targetParts) {
      if (part === '..') {
        currentParts.pop();
      } else if (part !== '.') {
        currentParts.push(part);
      }
    }

    const resolved = '/' + currentParts.join('/');
    return this.normalizePath(resolved);
  }

  private normalizePath(path: string): string {
    // Remove trailing slashes except for root
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return path || '/';
  }

  private resolvePath(currentDir: string, filepath: string): string {
    // If path starts with /, it's absolute
    if (filepath.startsWith('/')) {
      return filepath;
    }
    // Otherwise, resolve relative to current directory
    if (currentDir === '/') {
      return `/${filepath}`;
    }
    return `${currentDir}/${filepath}`;
  }

  private handleHelp(context: CommandContext): CommandResult {
    const output = this.copy(context).fullHelpText;
    return {
      success: true,
      output,
      shouldRefreshGit: false,
    };
  }

  private handleGitHelp(context: CommandContext): CommandResult {
    return {
      success: true,
      output: this.copy(context).gitHelpText,
      shouldRefreshGit: false,
    };
  }
}

export const commandParser = new CommandParser();
