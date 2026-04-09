import type { FSAdapter } from '@keydown-app/ts-git';
import type { CommandResult } from '@keydown-app/ts-git/cli';
import { FileEditor } from './terminal/FileEditor.js';
import { getIcon } from '../lib/icons.js';

export type { CommandResult };

export interface TerminalOptions {
  container: HTMLElement;
  fs: FSAdapter;
  currentDir: string;
  gitdir?: string;
  onCommandExecuted: (result: CommandResult) => void;
  /** Run one terminal line (e.g. embedded CommandParser); `currentDir` is managed by App + cd handling. */
  runCommand: (commandLine: string) => Promise<CommandResult>;
  onDirectoryChange?: (newDir: string) => void;
  title?: string;
  welcomeMessage?: string;
  isReady?: boolean;
}

export class Terminal {
  private container: HTMLElement;
  private currentDir: string;
  private gitdir: string | null;

  private outputElement!: HTMLElement;
  private inputElement!: HTMLInputElement;
  private promptElement!: HTMLElement;
  private inputArea!: HTMLElement;
  private editorContainer!: HTMLElement;
  private suggestionElement!: HTMLElement;

  private commandHistory: string[];
  private commandHistoryIndex: number;
  private onCommandExecuted: (result: CommandResult) => void;
  private runCommand: (commandLine: string) => Promise<CommandResult>;
  private onDirectoryChange: ((newDir: string) => void) | null;
  private title: string;
  private welcomeMessage: string;
  private fs: FSAdapter;
  private isReady: boolean;

  constructor(options: TerminalOptions) {
    this.container = options.container;
    this.currentDir = options.currentDir;
    this.gitdir = options.gitdir ?? null;
    this.fs = options.fs;
    this.commandHistory = [];
    this.commandHistoryIndex = -1;
    this.onCommandExecuted = options.onCommandExecuted;
    this.runCommand = options.runCommand;
    this.onDirectoryChange = options.onDirectoryChange ?? null;
    this.title = options.title ?? 'Terminal';
    this.welcomeMessage =
      options.welcomeMessage ?? "Type 'help' for available commands.";
    this.isReady = options.isReady ?? true;

    this.render();
    this.setupKeyboardHandlers();
  }

  updateReadyState(isReady: boolean) {
    this.isReady = isReady;
    this.render();
    if (isReady) {
      this.setupKeyboardHandlers();
    }
  }

  private render() {
    this.container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'panel__header';
    header.innerHTML = `
      <h3 class="terminal__title">${getIcon('terminal', 16, 'panel__header-icon')}${this.title}</h3>
      <div class="panel__header-actions">
        <button type="button" class="panel__icon-btn" id="copy-logs-btn" title="Copy all logs to clipboard">${getIcon('copy', 16)}</button>
      </div>
    `;
    this.container.appendChild(header);

    // Copy button handler
    const copyBtn = header.querySelector('#copy-logs-btn') as HTMLButtonElement;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.copyLogsToClipboard();
    });

    // Single scroll region: output and prompt/input scroll together
    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'terminal__window';

    this.outputElement = document.createElement('div');
    this.outputElement.className = 'terminal__output';
    this.outputElement.innerHTML = `
      <span class="terminal__welcome">${this.welcomeMessage}</span><br>
    `;
    scrollContainer.appendChild(this.outputElement);

    this.inputArea = document.createElement('div');
    this.inputArea.className = 'terminal__input-area';

    this.promptElement = document.createElement('span');
    this.promptElement.className = 'terminal__prompt';
    this.updatePrompt();

    const inputContainer = document.createElement('div');
    inputContainer.className = 'terminal__input-wrap';

    this.suggestionElement = document.createElement('span');
    this.suggestionElement.className = 'terminal__suggestion';

    this.inputElement = document.createElement('input');
    this.inputElement.type = 'text';
    this.inputElement.className = 'terminal__input';
    this.inputElement.spellcheck = false;
    this.inputElement.autocomplete = 'off';

    inputContainer.appendChild(this.suggestionElement);
    inputContainer.appendChild(this.inputElement);

    this.inputArea.appendChild(this.promptElement);
    this.inputArea.appendChild(inputContainer);
    scrollContainer.appendChild(this.inputArea);
    this.container.appendChild(scrollContainer);

    // Editor container (hidden by default) - positioned as overlay
    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'terminal__editor';
    this.editorContainer.style.display = 'none';
    this.container.appendChild(this.editorContainer);

    if (!this.isReady) {
      this.inputElement.disabled = true;
      scrollContainer.classList.add('terminal__window--disabled');
    } else {
      // Focus input when ready
      this.inputElement.focus();
    }
  }

  private updatePrompt() {
    // Show the full relative path, not just the folder name
    const promptPath = this.currentDir === '/' ? '/' : this.currentDir;
    this.promptElement.textContent = `${promptPath} > `;
  }

  private setupKeyboardHandlers() {
    this.inputElement.addEventListener('keydown', async (e) => {
      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          await this.executeCommand();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.navigateHistory(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          this.navigateHistory(1);
          break;
        case 'Tab':
          e.preventDefault();
          this.autocomplete();
          break;
      }
    });

    // Update suggestion as user types
    this.inputElement.addEventListener('input', () => {
      this.updateSuggestion();
    });

    // Keep focus on input (but allow text selection)
    this.container.addEventListener('mouseup', () => {
      const selection = window.getSelection();
      if (!selection || selection.toString().length === 0) {
        this.inputElement.focus();
      }
    });
  }

  private async executeCommand() {
    const command = this.inputElement.value.trim();
    if (!command) return;

    // Add to history
    this.commandHistory.push(command);
    this.commandHistoryIndex = this.commandHistory.length;

    // Show command in output
    this.appendOutput(`${this.promptElement.textContent}${command}`, 'command');

    // Clear input and suggestion
    this.inputElement.value = '';
    this.suggestionElement.textContent = '';

    try {
      const result = await this.runCommand(command);

      // Handle directory change from cd command
      if (result.newDirectory !== undefined) {
        this.updateDirectory(result.newDirectory);
        // Notify parent about directory change
        if (this.onDirectoryChange) {
          this.onDirectoryChange(result.newDirectory);
        }
      }

      if (result.output === '__CLEAR__') {
        this.outputElement.innerHTML = '';
      } else if (result.output?.startsWith('__EDIT__:')) {
        // Handle edit command - open vim editor
        const parts = result.output.split(':');
        const filepath = parts[1];
        const content = decodeURIComponent(parts[2] || '');
        this.openEditor(filepath, content, (saved) => {
          if (saved) {
            this.appendOutput(`File saved: ${filepath}`, 'output');
          }
          // Refresh git status after editing
          this.onCommandExecuted({ ...result, shouldRefreshGit: saved });
        });
      } else if (result.output) {
        this.appendOutput(result.output, result.success ? 'output' : 'error');
      }

      // Notify parent (skip for edit command as it's handled above)
      if (!result.output?.startsWith('__EDIT__:')) {
        this.onCommandExecuted(result);
      }
    } catch (error) {
      this.appendOutput(`Unexpected error: ${error}`, 'error');
    }
  }

  private navigateHistory(direction: number) {
    if (this.commandHistory.length === 0) return;

    this.commandHistoryIndex += direction;

    if (this.commandHistoryIndex < 0) {
      this.commandHistoryIndex = 0;
    } else if (this.commandHistoryIndex >= this.commandHistory.length) {
      this.commandHistoryIndex = this.commandHistory.length;
      this.inputElement.value = '';
      return;
    }

    this.inputElement.value = this.commandHistory[this.commandHistoryIndex];
    // Move cursor to end
    setTimeout(() => {
      this.inputElement.selectionStart = this.inputElement.selectionEnd =
        this.inputElement.value.length;
    }, 0);
  }

  private async updateSuggestion() {
    const input = this.inputElement.value;
    const suggestion = await this.getSuggestion(input);
    // Prefix with current input so the suggestion aligns properly
    this.suggestionElement.textContent = suggestion ? input + suggestion : '';
  }

  private async getSuggestion(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) return '';

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    // Handle "git" prefix
    let actualCmd = cmd;
    let argsStart = 1;
    if (cmd === 'git' && parts.length > 1) {
      actualCmd = parts[1]?.toLowerCase();
      argsStart = 2;
    }

    // Commands that support file autocomplete
    const fileCommands = [
      'add',
      'cat',
      'edit',
      'rm',
      'touch',
      'mkdir',
      'ls',
      'cd',
      'reset',
    ];

    if (!fileCommands.includes(actualCmd)) {
      // Command autocomplete
      const commands = [
        'git',
        'cd',
        'pwd',
        'init',
        'add',
        'commit',
        'status',
        'log',
        'branch',
        'checkout',
        'reset',
        'rm',
        'diff',
        'tag',
        'delete',
        'rename',
        'edit',
        'mkdir',
        'touch',
        'ls',
        'cat',
        'help',
        'clear',
      ];
      const matches = commands.filter((c) =>
        c.startsWith(trimmed.toLowerCase()),
      );
      if (matches.length === 1 && matches[0] !== trimmed.toLowerCase()) {
        // Return only the completion part (will be prefixed with input in updateSuggestion)
        return matches[0].slice(trimmed.length);
      }
      return '';
    }

    // File autocomplete
    const partialPath = parts.slice(argsStart).join(' ');
    if (!partialPath) return '';

    const matches = await this.getFileMatches(partialPath);
    if (matches.length === 0) return '';

    const firstMatch = matches[0];
    const lastSlashIndex = partialPath.lastIndexOf('/');
    const filter =
      lastSlashIndex >= 0 ? partialPath.slice(lastSlashIndex + 1) : partialPath;

    // Return only the completion part (will be prefixed with input in updateSuggestion)
    return firstMatch.slice(filter.length);
  }

  private async getFileMatches(partialPath: string): Promise<string[]> {
    // Determine directory and filter
    const lastSlashIndex = partialPath.lastIndexOf('/');
    let dirPath: string;
    let filter: string;

    if (lastSlashIndex >= 0) {
      dirPath = partialPath.slice(0, lastSlashIndex) || '/';
      filter = partialPath.slice(lastSlashIndex + 1);
    } else {
      dirPath = this.currentDir;
      filter = partialPath;
    }

    // Resolve relative paths
    if (!dirPath.startsWith('/')) {
      dirPath =
        this.currentDir === '/'
          ? `/${dirPath}`
          : `${this.currentDir}/${dirPath}`;
    }

    try {
      const entries = await this.fs.readdir(dirPath);
      const filterLower = filter.toLowerCase();

      // Get the git directory name if gitdir is set and we're in the parent directory
      let gitDirName: string | null = null;
      if (this.gitdir) {
        const gitDirParent =
          this.gitdir.slice(0, this.gitdir.lastIndexOf('/')) || '/';
        if (dirPath === gitDirParent) {
          gitDirName = this.gitdir.slice(this.gitdir.lastIndexOf('/') + 1);
        }
      }

      // Filter entries
      const matches = entries.filter((entry) => {
        // Exclude git directory from suggestions
        if (gitDirName && entry.name === gitDirName) {
          return false;
        }
        // Show hidden files only if filter starts with '.'
        if (entry.name.startsWith('.') && !filter.startsWith('.')) {
          return false;
        }
        return entry.name.toLowerCase().startsWith(filterLower);
      });

      // Sort: directories first, then files
      matches.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      // Return names with trailing slash for directories
      return matches.map((entry) =>
        entry.isDirectory ? `${entry.name}/` : entry.name,
      );
    } catch {
      return [];
    }
  }

  private async autocomplete() {
    const input = this.inputElement.value;
    const trimmed = input.trim();
    if (!trimmed) return;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    // Handle "git" prefix
    let actualCmd = cmd;
    let argsStart = 1;
    if (cmd === 'git' && parts.length > 1) {
      actualCmd = parts[1]?.toLowerCase();
      argsStart = 2;
    }

    // Commands that support file autocomplete
    const fileCommands = [
      'add',
      'cat',
      'edit',
      'rm',
      'touch',
      'mkdir',
      'ls',
      'cd',
      'reset',
    ];

    if (!fileCommands.includes(actualCmd)) {
      // Command autocomplete (existing behavior)
      const commands = [
        'git',
        'cd',
        'pwd',
        'init',
        'add',
        'commit',
        'status',
        'log',
        'branch',
        'checkout',
        'reset',
        'rm',
        'diff',
        'tag',
        'delete',
        'rename',
        'edit',
        'mkdir',
        'touch',
        'ls',
        'cat',
        'help',
        'clear',
      ];

      const matches = commands.filter((c) =>
        c.startsWith(trimmed.toLowerCase()),
      );
      if (matches.length === 1) {
        this.inputElement.value = matches[0];
      } else if (matches.length > 1) {
        this.appendOutput(matches.join('  '), 'suggestion');
      }
      return;
    }

    // File autocomplete
    const partialPath = parts.slice(argsStart).join(' ');
    const matches = await this.getFileMatches(partialPath);

    if (matches.length === 0) return;

    if (matches.length === 1) {
      // Complete with the single match
      const lastSlashIndex = partialPath.lastIndexOf('/');
      const prefix =
        lastSlashIndex >= 0 ? partialPath.slice(0, lastSlashIndex + 1) : '';
      const newPath = prefix + matches[0];
      const newParts = [...parts.slice(0, argsStart), newPath];
      this.inputElement.value = newParts.join(' ');
      this.suggestionElement.textContent = '';
    } else {
      // Show all matches
      this.appendOutput(matches.join('  '), 'suggestion');
    }
  }

  private appendOutput(
    text: string,
    type: 'command' | 'output' | 'error' | 'suggestion',
  ) {
    const line = document.createElement('div');
    line.className = `terminal__line terminal__line--${type}`;

    if (type === 'output') {
      // Preserve whitespace for output
      line.style.whiteSpace = 'pre-wrap';
      // Apply diff syntax highlighting if this looks like diff output
      if (this.isDiffOutput(text)) {
        line.innerHTML = this.highlightDiffOutput(text);
      } else {
        line.textContent = text;
      }
    } else {
      line.textContent = text;
    }

    this.outputElement.appendChild(line);

    // Focus input and scroll to bottom of scroll container
    this.inputElement.focus();

    const scrollContainer = this.container.querySelector(
      '.terminal__window',
    ) as HTMLElement;
    if (scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }

  /**
   * Check if text appears to be diff output
   */
  private isDiffOutput(text: string): boolean {
    // Look for diff indicators in the first few lines
    const lines = text.split('\n').slice(0, 10);
    return lines.some(
      (line) =>
        line.startsWith('diff --git') ||
        line.startsWith('@@ ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ '),
    );
  }

  /**
   * Apply syntax highlighting to diff output
   */
  private highlightDiffOutput(text: string): string {
    return text
      .split('\n')
      .map((line) => {
        // Hunk headers: @@ -1,2 +1,3 @@
        if (line.startsWith('@@')) {
          return `<span class="diff-snippet__header">${this.escapeHtml(line)}</span>`;
        }
        // Removed lines
        if (line.startsWith('-')) {
          return `<span class="diff-snippet__removed">${this.escapeHtml(line)}</span>`;
        }
        // Added lines
        if (line.startsWith('+')) {
          return `<span class="diff-snippet__added">${this.escapeHtml(line)}</span>`;
        }
        // Context and other lines
        return this.escapeHtml(line);
      })
      .join('\n');
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  focus() {
    this.inputElement.focus();
  }

  clear() {
    this.outputElement.innerHTML = '';
  }

  updateDirectory(newDir: string) {
    this.currentDir = newDir;
    this.updatePrompt();
  }

  appendMessage(message: string, type: 'output' | 'error' = 'output') {
    this.appendOutput(message, type);
  }

  /**
   * Append a prompt line and output as if the user had run `commandLine` in the terminal.
   * Does not invoke `onCommandExecuted`.
   */
  appendSimulatedCommand(
    commandLine: string,
    output: string,
    success: boolean,
  ): void {
    this.appendOutput(
      `${this.promptElement.textContent}${commandLine}`,
      'command',
    );
    if (output.length > 0) {
      this.appendOutput(output, success ? 'output' : 'error');
    }
  }

  openEditor(
    filepath: string,
    content: string,
    onClose: (saved: boolean) => void,
  ): void {
    // Show editor overlay (it covers the scroll container)
    this.editorContainer.style.display = 'flex';

    // Create and initialize the vim editor
    new FileEditor({
      container: this.editorContainer,
      fs: this.fs,
      filepath,
      initialContent: content,
      onClose: (saved) => {
        // Hide editor overlay when editor closes
        this.editorContainer.style.display = 'none';

        // Focus input and scroll to end
        this.inputElement.focus();
        const scrollContainer = this.container.querySelector(
          '.terminal__window',
        ) as HTMLElement;
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }

        onClose(saved);
      },
    });
  }

  private copyLogsToClipboard(): void {
    const lines = Array.from(
      this.outputElement.querySelectorAll('.terminal__line'),
    );
    const logs = lines.map((line) => line.textContent || '').join('\n');

    navigator.clipboard
      .writeText(logs)
      .then(() => {
        this.appendOutput('Logs copied to clipboard!', 'output');
      })
      .catch((err) => {
        this.appendOutput(`Failed to copy logs: ${err}`, 'error');
      });
  }
}
