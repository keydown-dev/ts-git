import type { FSAdapter } from '@keydown-dev/ts-git';
import { NotAGitRepoError } from '@keydown-dev/ts-git';
import { getIcon } from '../lib/icons.js';
import {
  GIT_SIDEBAR_NOT_A_REPO,
  GIT_SIDEBAR_REPO_STATE,
  GIT_SIDEBAR_STATUS_ERROR,
  GIT_SIDEBAR_WORKSPACE_UNREADY,
  dispatchGitSidebarEvent,
  type GitRepoStateDetail,
} from './sidebar/gitEvents.js';
import {
  countWorkingTreeFiles,
  type GitOperations,
} from './sidebar/gitPanelShared.js';
import { FileTree, type FileTreeOptions } from './sidebar/FileTree.js';
import { FileChanges } from './sidebar/FileChanges.js';
import { FileHistory } from './sidebar/FileHistory.js';

export type SidebarTabId = 'explorer' | 'changes' | 'history';

export interface SidebarOptions {
  /** Dispatches git sidebar custom events; same target listeners use. */
  eventTarget: HTMLElement;
  /** Tab strip is appended to this header (after brand / actions). */
  folderHeaderEl: HTMLElement;
  /** Three tabpanels are appended here. */
  sidebarBodyEl: HTMLElement;
  git: GitOperations;
  fs: FSAdapter;
  currentDir: string;
  onFileSelect: (path: string) => void;
  isWorkspaceReady: () => boolean;
  onShowDiff?: (request: { path: string; cached: boolean }) => void;
  onShowCommitDiff?: (commitOid: string) => void | Promise<void>;
  onGitFooterMeta?: (meta: {
    repoOpen: boolean;
    branch: string | null;
    dirty: boolean;
  }) => void;
  onRepositoryInitialized?: () => void | Promise<void>;
}

type TabEntry = {
  id: SidebarTabId;
  button: HTMLButtonElement;
  panel: HTMLElement;
};

export class Sidebar {
  private readonly eventTarget: HTMLElement;
  private readonly git: GitOperations;
  private readonly onGitFooterMeta?: SidebarOptions['onGitFooterMeta'];
  private tabEntries: TabEntry[];
  private activeTab: SidebarTabId = 'explorer';
  private fileTree: FileTree;
  private fileChanges: FileChanges;
  private fileHistory: FileHistory;
  private changesTabBadge: HTMLSpanElement;

  constructor(options: SidebarOptions) {
    this.eventTarget = options.eventTarget;
    this.git = options.git;
    this.onGitFooterMeta = options.onGitFooterMeta;

    const mkTab = (
      id: SidebarTabId,
      leadingHtml: string,
      label: string,
      selected: boolean,
    ): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sidebar__tab sidebar__tab--compact';
      btn.id = `sidebar-tab-${id}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      btn.setAttribute('tabindex', selected ? '0' : '-1');
      btn.setAttribute('aria-label', label);
      btn.dataset.sidebarTab = id;
      btn.dataset.sidebarTooltip = label;
      btn.innerHTML = `
        ${leadingHtml}
        <span class="sidebar__tab-trailing"></span>
      `;
      return btn;
    };

    const tabExplorer = mkTab(
      'explorer',
      getIcon('folderTree', 14, 'sidebar__tab-icon'),
      'Explorer',
      true,
    );
    const tabChanges = mkTab(
      'changes',
      getIcon('gitBranch', 14, 'sidebar__tab-icon'),
      'Changes',
      false,
    );
    const tabHistory = mkTab(
      'history',
      getIcon('gitCommitVertical', 14, 'sidebar__tab-icon'),
      'History',
      false,
    );

    this.changesTabBadge = document.createElement('span');
    this.changesTabBadge.className = 'sidebar__tab-badge';
    this.changesTabBadge.textContent = '0';
    this.changesTabBadge.hidden = true;
    tabChanges
      .querySelector('.sidebar__tab-trailing')
      ?.appendChild(this.changesTabBadge);

    const tabstrip = document.createElement('div');
    tabstrip.className = 'sidebar__tabstrip';
    tabstrip.setAttribute('role', 'tablist');
    tabstrip.setAttribute('aria-label', 'Sidebar');
    tabstrip.append(tabExplorer, tabChanges, tabHistory);
    options.folderHeaderEl.appendChild(tabstrip);

    const fileTreePanel = document.createElement('div');
    fileTreePanel.className = 'panel sidebar__pane sidebar__pane--explorer file-tree';
    fileTreePanel.id = 'filetree-panel';
    fileTreePanel.setAttribute('role', 'tabpanel');
    fileTreePanel.setAttribute('aria-labelledby', 'sidebar-tab-explorer');

    const gitChangesPanel = document.createElement('div');
    gitChangesPanel.className = 'panel sidebar__pane sidebar__pane--git';
    gitChangesPanel.id = 'git-changes-panel';
    gitChangesPanel.setAttribute('role', 'tabpanel');
    gitChangesPanel.setAttribute('aria-labelledby', 'sidebar-tab-changes');
    gitChangesPanel.hidden = true;

    const gitHistoryPanel = document.createElement('div');
    gitHistoryPanel.className = 'panel sidebar__pane sidebar__pane--git';
    gitHistoryPanel.id = 'git-history-panel';
    gitHistoryPanel.setAttribute('role', 'tabpanel');
    gitHistoryPanel.setAttribute('aria-labelledby', 'sidebar-tab-history');
    gitHistoryPanel.hidden = true;

    options.sidebarBodyEl.append(
      fileTreePanel,
      gitChangesPanel,
      gitHistoryPanel,
    );

    this.tabEntries = [
      { id: 'explorer', button: tabExplorer, panel: fileTreePanel },
      { id: 'changes', button: tabChanges, panel: gitChangesPanel },
      { id: 'history', button: tabHistory, panel: gitHistoryPanel },
    ];

    for (const entry of this.tabEntries) {
      entry.button.addEventListener('click', () => this.selectTab(entry.id));
    }

    const requestRefresh = () => {
      void this.refreshGitState();
    };

    this.fileTree = new FileTree({
      container: fileTreePanel,
      rootPath: options.currentDir,
      fs: options.fs,
      onFileSelect: options.onFileSelect,
      title: 'Files',
      hideHeader: true,
      isWorkspaceReady: options.isWorkspaceReady,
      gitEventTarget: this.eventTarget,
    } satisfies FileTreeOptions);

    this.fileChanges = new FileChanges({
      container: gitChangesPanel,
      git: options.git,
      gitEventTarget: this.eventTarget,
      onShowDiff: options.onShowDiff,
      onRepositoryInitialized: options.onRepositoryInitialized,
      requestRefresh,
    });

    this.fileHistory = new FileHistory({
      container: gitHistoryPanel,
      git: options.git,
      gitEventTarget: this.eventTarget,
      requestRefresh,
      onRepositoryInitialized: options.onRepositoryInitialized,
      onShowCommitDiff: options.onShowCommitDiff,
    });

    void this.refreshGitState();
    this.selectTab('explorer');
  }

  getActiveTab(): SidebarTabId {
    return this.activeTab;
  }

  selectTab(tab: SidebarTabId): void {
    this.activeTab = tab;
    for (const entry of this.tabEntries) {
      const on = entry.id === tab;
      entry.panel.hidden = !on;
      entry.button.classList.toggle('sidebar__tab--active', on);
      entry.button.setAttribute('aria-selected', on ? 'true' : 'false');
      entry.button.setAttribute('tabindex', on ? '0' : '-1');
    }
  }

  getFileTree(): FileTree {
    return this.fileTree;
  }

  /** Refresh directory listing; git decorations come from `refreshGitState`. */
  async refreshFileTree(): Promise<void> {
    await this.fileTree.refresh();
  }

  async refreshGitState(): Promise<void> {
    if (this.git.isWorkspaceReady?.() === false) {
      dispatchGitSidebarEvent(
        this.eventTarget,
        GIT_SIDEBAR_WORKSPACE_UNREADY,
        {},
      );
      this.emitFooterMeta({ repoOpen: false, branch: null, dirty: false });
      this.updateChangesBadge(0);
      return;
    }

    try {
      const status = await this.git.statusMatrix();
      const log = await this.git.log(20);
      const { current } = await this.git.listBranches();
      const detail: GitRepoStateDetail = {
        status,
        log,
        branch: current,
      };
      dispatchGitSidebarEvent(this.eventTarget, GIT_SIDEBAR_REPO_STATE, detail);
      this.applyRepoStateChrome(detail);
    } catch (error) {
      console.error('Error refreshing git sidebar:', error);
      if (this.isDirectoryNotSetError(error)) {
        dispatchGitSidebarEvent(
          this.eventTarget,
          GIT_SIDEBAR_WORKSPACE_UNREADY,
          {},
        );
        this.emitFooterMeta({ repoOpen: false, branch: null, dirty: false });
        this.updateChangesBadge(0);
        return;
      }
      if (
        error instanceof NotAGitRepoError ||
        (error instanceof Error && error.name === 'NotAGitRepoError')
      ) {
        dispatchGitSidebarEvent(this.eventTarget, GIT_SIDEBAR_NOT_A_REPO, {});
        this.emitFooterMeta({ repoOpen: false, branch: null, dirty: false });
        this.updateChangesBadge(0);
        return;
      }
      dispatchGitSidebarEvent(this.eventTarget, GIT_SIDEBAR_STATUS_ERROR, {});
      this.emitFooterMeta({
        repoOpen: true,
        branch: null,
        dirty: false,
      });
      this.updateChangesBadge(0);
    }
  }

  /** Full refresh: git events + file tree directory reload. */
  async refresh(): Promise<void> {
    await this.refreshGitState();
    await this.fileTree.refresh();
  }

  destroy(): void {
    this.fileTree.destroy();
    this.fileChanges.destroy();
    this.fileHistory.destroy();
  }

  private applyRepoStateChrome(detail: GitRepoStateDetail): void {
    const { stagedCount, unstagedCount } = countWorkingTreeFiles(detail.status);
    const dirty = stagedCount + unstagedCount > 0;
    this.emitFooterMeta({
      repoOpen: true,
      branch: detail.branch,
      dirty,
    });
    this.updateChangesBadge(stagedCount + unstagedCount);
  }

  private updateChangesBadge(total: number): void {
    this.changesTabBadge.textContent = String(total);
    this.changesTabBadge.hidden = total === 0;
  }

  private emitFooterMeta(meta: {
    repoOpen: boolean;
    branch: string | null;
    dirty: boolean;
  }): void {
    this.onGitFooterMeta?.(meta);
  }

  private isDirectoryNotSetError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.message === 'Directory not set.' ||
        error.message.includes('Directory not set'))
    );
  }
}

export { FileTree, type FileTreeOptions } from './sidebar/FileTree.js';
export { FileChanges, type FileChangesOptions } from './sidebar/FileChanges.js';
export { FileHistory, type FileHistoryOptions } from './sidebar/FileHistory.js';
export {
  GIT_SIDEBAR_NOT_A_REPO,
  GIT_SIDEBAR_REPO_STATE,
  GIT_SIDEBAR_STATUS_ERROR,
  GIT_SIDEBAR_WORKSPACE_UNREADY,
  dispatchGitSidebarEvent,
  type GitRepoStateDetail,
} from './sidebar/gitEvents.js';
export { type GitOperations } from './sidebar/gitPanelShared.js';
