import type { FSAdapter } from '@keydown-app/ts-git';

export interface FileEditorOptions {
  container: HTMLElement;
  fs: FSAdapter;
  filepath: string;
  initialContent: string;
  onClose: (saved: boolean) => void;
}

export class FileEditor {
  private container: HTMLElement;
  private fs: FSAdapter;
  private filepath: string;
  private initialContent: string;
  private currentContent: string;
  private textareaElement!: HTMLTextAreaElement;
  private commandInputElement!: HTMLInputElement;
  private statusElement!: HTMLElement;
  private onClose: (saved: boolean) => void;
  private isModified: boolean = false;

  constructor(options: FileEditorOptions) {
    this.container = options.container;
    this.fs = options.fs;
    this.filepath = options.filepath;
    this.initialContent = options.initialContent;
    this.currentContent = options.initialContent;
    this.onClose = options.onClose;

    this.render();
    this.setupKeyboardHandlers();
    this.focusEditor();
  }

  private render() {
    this.container.innerHTML = `
      <div class="vim-editor">
        <div class="vim-status-bar">
          <span class="vim-filename">${this.filepath}</span>
          <span class="vim-modified">${this.isModified ? '[modified]' : ''}</span>
        </div>
        <textarea class="vim-textarea">${this.escapeHtml(this.currentContent)}</textarea>
        <div class="vim-command-line">
          <span class="vim-colon">:</span>
          <input type="text" class="vim-command-input" />
          <span class="vim-status"></span>
        </div>
      </div>
    `;

    this.textareaElement = this.container.querySelector(
      '.vim-textarea',
    ) as HTMLTextAreaElement;
    this.commandInputElement = this.container.querySelector(
      '.vim-command-input',
    ) as HTMLInputElement;
    this.statusElement = this.container.querySelector(
      '.vim-status',
    ) as HTMLElement;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private setupKeyboardHandlers() {
    // Focus command input when ':' is pressed in textarea
    this.textareaElement.addEventListener('keydown', (e) => {
      if (e.key === ':' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.commandInputElement.focus();
      }
    });

    // Handle command input
    this.commandInputElement.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.clearCommandInput();
        this.focusEditor();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const command = this.commandInputElement.value.trim();
        await this.executeCommand(command);
      }
    });

    // Track content changes
    this.textareaElement.addEventListener('input', () => {
      this.currentContent = this.textareaElement.value;
      this.isModified = this.currentContent !== this.initialContent;
      this.updateStatusBar();
    });

    // Keep editor focused when clicking in it
    this.container.addEventListener('click', () => {
      if (document.activeElement !== this.commandInputElement) {
        this.focusEditor();
      }
    });
  }

  private async executeCommand(command: string) {
    this.clearCommandInput();
    this.focusEditor();

    switch (command) {
      case 'w':
      case 'write':
        await this.saveFile();
        break;
      case 'q':
      case 'quit':
        if (this.isModified) {
          this.showStatus(
            'E37: No write since last change (add ! to override)',
            'error',
          );
        } else {
          this.close(false);
        }
        break;
      case 'q!':
      case 'quit!':
        this.close(false);
        break;
      case 'wq':
      case 'x':
        await this.saveFile();
        this.close(true);
        break;
      default:
        if (command.startsWith('w ')) {
          // :w filename - save as different file
          const newPath = command.slice(2).trim();
          if (newPath) {
            await this.saveFile(newPath);
          }
        } else {
          this.showStatus(`E492: Not an editor command: ${command}`, 'error');
        }
    }
  }

  private async saveFile(filepath?: string) {
    const targetPath = filepath || this.filepath;
    try {
      await this.fs.writeFile(targetPath, this.currentContent);
      if (!filepath || filepath === this.filepath) {
        this.initialContent = this.currentContent;
        this.isModified = false;
        this.updateStatusBar();
      }
      this.showStatus(
        `"${targetPath}" ${filepath ? 'written' : 'saved'}`,
        'success',
      );
    } catch (error) {
      this.showStatus(
        `E45: 'readonly' option is set (add ! to override) or error: ${error}`,
        'error',
      );
    }
  }

  private close(saved: boolean) {
    this.container.innerHTML = '';
    this.onClose(saved);
  }

  private focusEditor() {
    this.textareaElement.focus();
  }

  private clearCommandInput() {
    this.commandInputElement.value = '';
  }

  private updateStatusBar() {
    const modifiedSpan = this.container.querySelector(
      '.vim-modified',
    ) as HTMLElement;
    if (modifiedSpan) {
      modifiedSpan.textContent = this.isModified ? '[modified]' : '';
    }
  }

  private showStatus(message: string, type: 'success' | 'error') {
    this.statusElement.textContent = message;
    this.statusElement.className = `vim-status ${type}`;

    // Clear status after 3 seconds for success messages
    if (type === 'success') {
      setTimeout(() => {
        if (this.statusElement.textContent === message) {
          this.statusElement.textContent = '';
        }
      }, 3000);
    }
  }

  focus() {
    this.focusEditor();
  }
}
