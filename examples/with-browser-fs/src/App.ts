// Type declarations for File System Access API
declare global {
  interface Window {
    showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
  }

  interface DataTransferItem {
    getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
  }
}

import { GitClient, type Author, type FSAdapter } from '@keydown-app/ts-git';
import { myersLineDiff } from '@keydown-app/ts-git-diff-myers';
import { App as SharedApp, NullAdapter } from '@ts-git/ui';

import { FileSystemAccessAdapter } from './lib/FileSystemAccessAdapter.js';

import '@ts-git/ui/styles.css';

export class App {
  private fs: FSAdapter;
  private git: GitClient;
  private author: Author;
  private currentDir: string = '/';
  private selectedFolderHandle: FileSystemDirectoryHandle | null = null;
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
      workspaceDisplayPath: this.selectedFolderHandle?.name ?? null,
      onOpenFolder: () => this.selectFolder(),
      onCloseFolder: () => this.closeFolder(),
      welcomeMessage: this.selectedFolderHandle
        ? `Current folder: ${this.selectedFolderHandle.name}`
        : 'Welcome to TS-Git Browser! Select a folder to get started.',
      isTerminalReady: !!this.selectedFolderHandle,
    });
  }

  private closeFolder() {
    this.selectedFolderHandle = null;
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
      // Check if File System Access API is supported
      if (!('showDirectoryPicker' in window)) {
        this.showStatus(
          'Your browser does not support the File System Access API. Please use Chrome, Edge, or Opera.',
          'error',
        );
        return;
      }

      const dirHandle = await window.showDirectoryPicker();
      await this.initializeWithFolder(dirHandle);
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        // User cancelled the picker
        return;
      }
      this.showStatus(`Error selecting folder: ${error}`, 'error');
    }
  }

  private async initializeWithFolder(dirHandle: FileSystemDirectoryHandle) {
    this.selectedFolderHandle = dirHandle;

    try {
      this.showStatus(`Opening "${dirHandle.name}"...`, 'info');

      // Create the filesystem adapter with the folder as base
      this.fs = new FileSystemAccessAdapter(dirHandle);
      // Use virtual root path - the fs adapter will resolve it to the actual folder
      this.currentDir = '/';

      // Request permission to access the directory
      // This is needed for persistent access across page reloads
      const permission = await dirHandle.requestPermission({
        mode: 'readwrite',
      });
      if (permission !== 'granted') {
        this.showStatus(
          'Permission denied. Cannot access the selected folder.',
          'error',
        );
        return;
      }

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
        this.showStatus(
          `Opened git repository: "${dirHandle.name}"`,
          'success',
        );
      } else {
        this.showStatus(
          `Opened folder: "${dirHandle.name}" (not a git repository)`,
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

// Register service worker for PWA functionality
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        console.log('ServiceWorker registered:', registration);
      })
      .catch((error) => {
        console.log('ServiceWorker registration failed:', error);
      });
  });
}
