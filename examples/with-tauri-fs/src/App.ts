import { open } from '@tauri-apps/plugin-dialog';
import { App as SharedApp, NullAdapter } from '@ts-git/ui';
import type { Author, FSAdapter } from '@keydown-dev/ts-git';
import { GitClient } from '@keydown-dev/ts-git';
import { myersLineDiff } from '@keydown-dev/ts-git-diff-myers';

import { TauriFSAdapter } from './lib/TauriFSAdapter.js';

export class App {
  private fs: FSAdapter;
  private git: GitClient;
  private author: Author;
  private currentDir: string = '/'; // Virtual root representing the opened folder
  private selectedFolderPath: string | null = null;
  private sharedApp: SharedApp | null = null;
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.author = {
      name: 'TS-Git User',
      email: 'user@ts-git.local',
    };

    // Initialize with NullAdapter (no folder selected)
    this.fs = new NullAdapter();
    this.git = new GitClient({
      fs: this.fs,
      dir: null,
      gitdir: '.git',
      defaultBranch: 'master',
      lineDiffAlgorithm: myersLineDiff,
    });

    // Create the shared app
    this.createSharedApp();
  }

  private createSharedApp() {
    this.sharedApp = new SharedApp({
      container: this.container,
      fs: this.fs,
      git: this.git,
      author: this.author,
      currentDir: this.currentDir,
      workspaceDisplayPath: this.selectedFolderPath,
      onOpenFolder: () => this.selectFolder(),
      onCloseFolder: () => this.closeFolder(),
      welcomeMessage: this.selectedFolderPath
        ? `Current folder: ${this.selectedFolderPath}`
        : 'Welcome to TS-Git Desktop! Select a folder to get started.',
      isTerminalReady: !!this.selectedFolderPath,
    });
  }

  private closeFolder() {
    this.selectedFolderPath = null;
    this.fs = new NullAdapter();
    this.git = new GitClient({
      fs: this.fs,
      dir: null,
      gitdir: '.git',
      defaultBranch: 'master',
      lineDiffAlgorithm: myersLineDiff,
    });
    this.currentDir = '/';
    this.createSharedApp();
  }

  private async selectFolder() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select a folder to open',
      });

      if (selected && typeof selected === 'string') {
        await this.initializeWithFolder(selected);
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        // User cancelled the picker
        return;
      }
      this.showStatus(`Error selecting folder: ${error}`, 'error');
    }
  }

  private async initializeWithFolder(folderPath: string) {
    this.selectedFolderPath = folderPath;

    try {
      this.showStatus(`Opening "${folderPath}"...`, 'info');

      // Create the filesystem adapter with the folder as base
      this.fs = new TauriFSAdapter(folderPath);
      // Use virtual root path - the fs adapter will resolve it to the actual folder
      this.currentDir = '/';

      // Initialize git operations
      this.git = new GitClient({
        fs: this.fs,
        dir: this.currentDir,
        lineDiffAlgorithm: myersLineDiff,
      });

      // Check if this is already a git repository
      const isGitRepo = await this.git.isGitRepository();

      // Recreate the shared app with new fs and git
      this.createSharedApp();

      // Show appropriate message
      if (isGitRepo) {
        this.showStatus(`Opened git repository: "${folderPath}"`, 'success');
      } else {
        this.showStatus(
          `Opened folder: "${folderPath}" (not a git repository)`,
          'info',
        );
      }

      // Initial git refresh
      await this.refreshGitStatus();
    } catch (error) {
      this.showStatus(`Error opening folder: ${error}`, 'error');
      console.error('Error initializing app:', error);
    }
  }

  private async refreshGitStatus() {
    if (!this.sharedApp) return;
    await this.sharedApp.refresh();
  }

  private showStatus(
    message: string,
    type: 'info' | 'error' | 'success' = 'info',
  ) {
    if (this.sharedApp) {
      this.sharedApp.showStatus(message, type);
    }
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('root');
  if (root) {
    new App(root);
  }
});
