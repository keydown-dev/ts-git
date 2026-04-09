import type { FSAdapter, Author } from '@keydown-app/ts-git';
import { formatDiff, GitClient } from '@keydown-app/ts-git';
import {
  commandParser,
  resolveDiffInvocation,
  type CommandResult,
  type EmbeddedCliCopy,
} from '@keydown-app/ts-git/cli';
import { Terminal } from './Terminal.js';
import { Sidebar, type FileTree } from './sidebar/index.js';
import { ContentPreview } from './ContentPreview.js';
import { getIcon } from '../lib/icons.js';

const SIDEBAR_WIDTH_KEY = 'tsgit-sidebar-width-px';
const SIDEBAR_MIN_PX = 250;

function folderBasename(absPath: string): string {
  const trimmed = absPath.replace(/\/$/, '') || '/';
  if (trimmed === '/') return '/';
  const last = trimmed.lastIndexOf('/');
  return last < 0 ? trimmed : trimmed.slice(last + 1);
}

export interface AppConfig {
  container: HTMLElement;
  fs: FSAdapter;
  /** Full client — required for the embedded terminal (CommandParser). */
  git: GitClient;
  author: Author;
  currentDir: string;
  gitdir?: string;
  /** Optional overrides for default embedded CLI strings (prompts, help text). */
  embeddedCliCopy?: EmbeddedCliCopy;

  /**
   * Host path or label for the open workspace (e.g. real filesystem path from the OS).
   * When `currentDir` is a virtual root (`/`), this is used for the sidebar folder title.
   */
  workspaceDisplayPath?: string | null;

  // UI customization
  onOpenFolder?: () => void;
  onCloseFolder?: () => void;

  // Lifecycle
  onInitialize?: () => Promise<void>;

  // Status/welcome
  welcomeMessage?: string;

  // Terminal state
  isTerminalReady?: boolean;
}

export class App {
  private config: AppConfig;
  private sidebar: Sidebar | null = null;
  private terminal: Terminal | null = null;
  private contentPreview: ContentPreview | null = null;
  private currentDir: string;
  private viewMode: 'terminal' | 'preview' = 'terminal';
  private previewFilePath: string | null = null;

  private sidebarEl: HTMLElement | null = null;
  private sidebarFolderTitleEl: HTMLElement | null = null;
  private sidebarGitFooterEl: HTMLElement | null = null;
  private sidebarGitBranchEl: HTMLElement | null = null;
  private gitFooterMeta: {
    repoOpen: boolean;
    branch: string | null;
    dirty: boolean;
  } = { repoOpen: false, branch: null, dirty: false };

  constructor(config: AppConfig) {
    this.config = config;
    this.currentDir = config.currentDir;
    this.render();
    this.initializeComponents();

    // Run optional initialization
    if (config.onInitialize) {
      config.onInitialize().catch(console.error);
    }
  }

  private render() {
    const { container } = this.config;

    container.innerHTML = '';
    container.className = 'app-container';

    // Main: resizable sidebar dock + editor/terminal
    const main = document.createElement('main');
    main.className = 'app-main';

    const dock = document.createElement('div');
    dock.className = 'app-sidebar-dock';

    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar';

    const storedW = (() => {
      try {
        const v = localStorage.getItem(SIDEBAR_WIDTH_KEY);
        if (v) return parseInt(v, 10);
      } catch {
        /* ignore */
      }
      return NaN;
    })();
    const initialW = Number.isFinite(storedW)
      ? storedW
      : Math.min(300, Math.floor(window.innerWidth * 0.35));
    sidebar.style.width = `${this.clampSidebarWidth(initialW)}px`;

    const folderHeader = document.createElement('div');
    folderHeader.className = 'sidebar-top-header panel-header';

    const { onOpenFolder } = this.config;
    const folderIconWrap = document.createElement('span');
    folderIconWrap.className = 'sidebar-top-header__folder-icon';
    folderIconWrap.setAttribute('aria-hidden', 'true');
    folderIconWrap.innerHTML = getIcon(
      'folderInput',
      16,
      'sidebar-top-header__folder-svg',
    );

    const folderBrand = onOpenFolder
      ? (() => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.id = 'open-folder-btn';
          btn.className = 'sidebar-top-header__brand';
          btn.setAttribute('aria-label', 'Open or change folder');
          btn.dataset.sidebarTooltip = 'Open or change folder';
          btn.addEventListener('click', () => onOpenFolder());
          const titleSpan = document.createElement('span');
          titleSpan.className = 'sidebar-folder-title';
          btn.append(folderIconWrap, titleSpan);
          return { el: btn as HTMLElement, titleEl: titleSpan };
        })()
      : (() => {
          const div = document.createElement('div');
          div.className = 'sidebar-top-header__brand';
          const h3 = document.createElement('h3');
          h3.className = 'sidebar-folder-title';
          div.append(folderIconWrap, h3);
          return { el: div, titleEl: h3 };
        })();

    const folderTitle: HTMLElement = folderBrand.titleEl;
    folderHeader.appendChild(folderBrand.el);

    const sidebarBody = document.createElement('div');
    sidebarBody.className = 'sidebar-body';

    const gitFooter = document.createElement('div');
    gitFooter.className = 'sidebar-git-footer';
    gitFooter.hidden = true;
    gitFooter.innerHTML = `
      <div class="sidebar-git-footer-inner">
        <span class="sidebar-git-footer-branch" aria-hidden="true">${getIcon('gitBranch', 14, 'sidebar-git-footer-icon')}</span>
        <span class="sidebar-git-branch" id="sidebar-git-branch-label"></span>
        <button type="button" class="sidebar-git-footer-btn" disabled title="Sync (not available)">${getIcon('refreshCw', 14)}</button>
        <span class="sidebar-git-remote sidebar-git-remote--placeholder" aria-disabled="true">0↓</span>
        <span class="sidebar-git-remote sidebar-git-remote--placeholder" aria-disabled="true">0↑</span>
      </div>
    `;

    sidebar.append(folderHeader, sidebarBody, gitFooter);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'sidebar-resize-handle';
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-orientation', 'vertical');
    resizeHandle.setAttribute('aria-label', 'Resize sidebar');
    resizeHandle.tabIndex = 0;

    dock.append(sidebar, resizeHandle);
    main.appendChild(dock);

    const terminalPanel = document.createElement('div');
    terminalPanel.className = 'panel terminal-panel panel--editor';
    terminalPanel.id = 'terminal-panel';
    main.appendChild(terminalPanel);

    container.appendChild(main);

    this.sidebarEl = sidebar;
    this.sidebarFolderTitleEl = folderTitle;
    this.sidebarGitFooterEl = gitFooter;
    this.sidebarGitBranchEl = gitFooter.querySelector(
      '#sidebar-git-branch-label',
    ) as HTMLSpanElement;

    this.wireSidebarResize(resizeHandle, sidebar);
    window.addEventListener('resize', () => this.clampSidebarOnWindowResize());
    this.syncFolderTitleInHeader();
  }

  private clampSidebarWidth(w: number): number {
    const max = Math.floor(window.innerWidth * 0.5);
    return Math.min(Math.max(w, SIDEBAR_MIN_PX), max);
  }

  private clampSidebarOnWindowResize() {
    if (!this.sidebarEl) return;
    const cur = this.sidebarEl.getBoundingClientRect().width;
    const next = this.clampSidebarWidth(cur);
    this.sidebarEl.style.width = `${next}px`;
  }

  private wireSidebarResize(handle: HTMLElement, sidebar: HTMLElement) {
    let startX = 0;
    let startW = 0;
    let capId: number | null = null;

    const onMove = (clientX: number) => {
      const delta = clientX - startX;
      const next = this.clampSidebarWidth(startW + delta);
      sidebar.style.width = `${next}px`;
    };

    const endDrag = () => {
      if (capId !== null) {
        try {
          handle.releasePointerCapture(capId);
        } catch {
          /* already released */
        }
        capId = null;
      }
      document.body.classList.remove('sidebar-resize-active');
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
      try {
        const w = Math.round(sidebar.getBoundingClientRect().width);
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
      } catch {
        /* ignore */
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      e.preventDefault();
      onMove(e.clientX);
    };

    const onPointerUp = () => {
      endDrag();
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startX = e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      capId = e.pointerId;
      document.body.classList.add('sidebar-resize-active');
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
      handle.addEventListener('pointercancel', onPointerUp);
    });
  }

  private syncFolderTitleInHeader() {
    if (!this.sidebarFolderTitleEl) return;
    if (!this.config.git.isWorkspaceReady()) {
      this.sidebarFolderTitleEl.textContent = 'No folder';
      return;
    }
    const v = this.currentDir.replace(/\/$/, '') || '/';
    const host = this.config.workspaceDisplayPath;
    if (v === '/' && host && host.length > 0) {
      this.sidebarFolderTitleEl.textContent = folderBasename(host);
      return;
    }
    this.sidebarFolderTitleEl.textContent = folderBasename(this.currentDir);
  }

  private onGitFooterMeta(meta: {
    repoOpen: boolean;
    branch: string | null;
    dirty: boolean;
  }) {
    this.gitFooterMeta = meta;
    const label = `${meta.branch ?? 'HEAD'}${meta.dirty ? '*' : ''}`;
    if (this.sidebarGitBranchEl) {
      this.sidebarGitBranchEl.textContent = label;
    }
    this.applyGitFooterVisibility();
  }

  private applyGitFooterVisibility() {
    if (!this.sidebarGitFooterEl || !this.sidebarGitBranchEl) return;
    const show = this.gitFooterMeta.repoOpen;
    this.sidebarGitFooterEl.hidden = !show;
  }

  private initializeComponents() {
    const { fs } = this.config;

    const sidebarEl = this.sidebarEl;
    const folderHeader = sidebarEl?.querySelector('.sidebar-top-header');
    const sidebarBody = sidebarEl?.querySelector('.sidebar-body');
    if (
      sidebarEl &&
      folderHeader instanceof HTMLElement &&
      sidebarBody instanceof HTMLElement
    ) {
      this.sidebar = new Sidebar({
        eventTarget: sidebarEl,
        folderHeaderEl: folderHeader,
        sidebarBodyEl: sidebarBody,
        git: this.config.git,
        fs,
        currentDir: this.currentDir,
        onFileSelect: (path: string) => {
          this.showPreview(path);
        },
        isWorkspaceReady: () => this.config.git.isWorkspaceReady(),
        onShowDiff: ({ path, cached }) => {
          void this.showDiffInTerminal(path, cached);
        },
        onShowCommitDiff: (commitOid) => {
          void this.showCommitDiffInTerminal(commitOid);
        },
        onGitFooterMeta: (meta) => this.onGitFooterMeta(meta),
        onRepositoryInitialized: () => this.refresh(),
      });
    }

    this.updateMiddlePanel();
  }

  private updateMiddlePanel(): void {
    const terminalContainer = document.getElementById('terminal-panel');
    if (!terminalContainer) return;

    // Clear existing content
    terminalContainer.innerHTML = '';

    if (this.viewMode === 'preview' && this.previewFilePath) {
      const repoDir = this.config.git.isWorkspaceReady()
        ? this.config.git.requireRepository().dir
        : this.currentDir;
      // Show Content Preview
      this.contentPreview = new ContentPreview({
        container: terminalContainer,
        fs: this.config.fs,
        git: this.config.git,
        filepath: this.previewFilePath,
        repoDir,
        onEdit: (filepath: string) => {
          this.closePreview();
          this.openEditor(filepath);
        },
        onClose: () => {
          this.closePreview();
        },
      });
      this.terminal = null;
    } else {
      // Show Terminal
      this.contentPreview = null;
      const { fs, welcomeMessage, onOpenFolder } = this.config;
      this.terminal = new Terminal({
        container: terminalContainer,
        fs,
        currentDir: this.currentDir,
        gitdir: this.config.gitdir,
        onCommandExecuted: (result: CommandResult) => {
          if (result.shouldRefreshGit) {
            this.refresh();
          }
          // Also refresh file tree on file changes
        },
        runCommand: (commandLine: string) =>
          commandParser.execute(commandLine, {
            currentDir: this.currentDir,
            fs: this.config.fs,
            git: this.config.git,
            author: this.config.author,
            copy: this.config.embeddedCliCopy,
          }),
        onDirectoryChange: (newDir: string) => {
          this.currentDir = newDir;
          this.syncFolderTitleInHeader();
          this.sidebar?.getFileTree().setRootPath(newDir);
        },
        title: 'Terminal',
        welcomeMessage:
          welcomeMessage ??
          'Welcome to TS-Git! Type "help" for available commands.',
        isReady: this.config.isTerminalReady ?? true,
        onOpenFolder: onOpenFolder,
      });

      // Ensure terminal is focused if ready
      if (this.config.isTerminalReady ?? true) {
        this.terminal.focus();
      }
    }
  }

  private showPreview(filepath: string): void {
    this.viewMode = 'preview';
    this.previewFilePath = filepath;
    this.updateMiddlePanel();
  }

  private closePreview(): void {
    this.viewMode = 'terminal';
    this.previewFilePath = null;
    this.updateMiddlePanel();
  }

  private async showDiffInTerminal(
    path: string,
    cached: boolean,
  ): Promise<void> {
    if (this.viewMode === 'preview') {
      this.closePreview();
    }

    const terminal = this.getTerminal();
    if (!terminal) return;

    const quotedForDisplay = /[\s"'\\]/.test(path)
      ? JSON.stringify(path)
      : path;
    const displayCmd = cached
      ? `diff --cached -- ${quotedForDisplay}`
      : `diff -- ${quotedForDisplay}`;

    try {
      const git = this.config.git;
      const { dir, gitdir } = git.requireRepository();
      const resolved = await resolveDiffInvocation(
        this.config.fs,
        dir,
        gitdir,
        [path],
        cached,
      );
      const result = await git.diff({
        left: resolved.left,
        right: resolved.right,
        cached: resolved.cached,
        paths: resolved.paths,
      });
      const formatted = formatDiff(result, 'patch');
      terminal.appendSimulatedCommand(displayCmd, formatted, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      terminal.appendSimulatedCommand(displayCmd, `error: ${msg}`, false);
    }

    terminal.focus();
  }

  private async showCommitDiffInTerminal(commitOid: string): Promise<void> {
    if (this.viewMode === 'preview') {
      this.closePreview();
    }

    const terminal = this.getTerminal();
    if (!terminal) return;

    const shortHash = commitOid.slice(0, 7);
    const displayCmd = `diff ${shortHash}`;

    try {
      const git = this.config.git;
      const result = await git.diff({
        left: { type: 'commit', ref: commitOid },
        right: { type: 'worktree' },
      });
      const formatted = formatDiff(result, 'patch');
      terminal.appendSimulatedCommand(displayCmd, formatted, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      terminal.appendSimulatedCommand(displayCmd, `error: ${msg}`, false);
    }

    terminal.focus();
  }

  private openEditor(filepath: string): void {
    if (!this.terminal) return;

    // Read file content and open in editor
    this.config.fs
      .readFile(filepath)
      .then((content) => {
        const textContent = new TextDecoder().decode(content);
        this.terminal?.openEditor(filepath, textContent, (saved: boolean) => {
          if (saved) {
            void this.sidebar?.getFileTree().refresh();
            void this.refresh();
          }
        });
      })
      .catch((err) => {
        console.error('Error opening file:', err);
      });
  }

  async refresh() {
    this.syncFolderTitleInHeader();
    if (!this.sidebar) return;

    try {
      await this.sidebar.refresh();
    } catch (error) {
      console.error('Error refreshing:', error);
    }
  }

  showStatus(message: string, type: 'info' | 'error' | 'success' = 'info') {
    // Status messages are no longer displayed in the UI
    // This method is kept for backward compatibility
    console.log(`[${type}] ${message}`);
  }

  getTerminal(): Terminal | null {
    return this.terminal;
  }

  getFileTree(): FileTree | null {
    return this.sidebar?.getFileTree() ?? null;
  }

  getSidebar(): Sidebar | null {
    return this.sidebar;
  }

  getContentPreview(): ContentPreview | null {
    return this.contentPreview;
  }
}
