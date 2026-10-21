import type { StatusRow, FSAdapter } from '@keydown-dev/ts-git';
import { classifyStatusRow } from '@keydown-dev/ts-git';
import { getIcon } from '../../lib/icons.js';
import {
  GIT_SIDEBAR_NOT_A_REPO,
  GIT_SIDEBAR_REPO_STATE,
  GIT_SIDEBAR_WORKSPACE_UNREADY,
  type GitRepoStateDetail,
} from './gitEvents.js';

interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  isExpanded: boolean;
  children: FileTreeNode[];
  gitStatus?: string;
}

export interface FileTreeOptions {
  container: HTMLElement;
  rootPath: string;
  fs: FSAdapter;
  onFileSelect: (path: string) => void;
  onOpenFolder?: () => void;
  onCloseFolder?: () => void;
  title?: string;
  /**
   * When this returns false, no folder is open — the tree body stays blank (no "Empty directory").
   * When omitted, a workspace is assumed (e.g. web demo with a fixed root).
   */
  isWorkspaceReady?: () => boolean;
  /** When false, header shows only toolbar actions (e.g. under a parent "Explorer" tab). Default true. */
  showPanelTitle?: boolean;
  /** When true, no header is rendered (parent supplies folder chrome). */
  hideHeader?: boolean;
  /** Listen for git sidebar events (repo state, workspace, not-a-repo). */
  gitEventTarget?: EventTarget;
}

export class FileTree {
  private container: HTMLElement;
  private rootPath: string;
  private fs: FSAdapter;
  private gitStatus: StatusRow[];
  private onFileSelect: (path: string) => void;
  private onOpenFolder?: () => void;
  private onCloseFolder?: () => void;
  private isWorkspaceReady?: () => boolean;
  private showPanelTitle: boolean;
  private hideHeader: boolean;
  private treeData: FileTreeNode[];
  private title: string;
  private gitEventTarget?: EventTarget;
  private boundRepoState = (ev: Event) => {
    const detail = (ev as CustomEvent<GitRepoStateDetail>).detail;
    this.setGitStatus(detail.status);
  };
  private boundWorkspaceUnready = () => {
    this.setGitStatus([]);
    void this.refresh();
  };
  private boundNotARepo = () => {
    this.setGitStatus([]);
    void this.refresh();
  };

  constructor(options: FileTreeOptions) {
    this.container = options.container;
    this.rootPath = options.rootPath;
    this.fs = options.fs;
    this.gitStatus = [];
    this.onFileSelect = options.onFileSelect;
    this.onOpenFolder = options.onOpenFolder;
    this.isWorkspaceReady = options.isWorkspaceReady;
    this.showPanelTitle = options.showPanelTitle !== false;
    this.hideHeader = options.hideHeader === true;
    this.treeData = [];
    this.title = options.title ?? 'Files';
    this.gitEventTarget = options.gitEventTarget;
    if (this.gitEventTarget) {
      this.gitEventTarget.addEventListener(
        GIT_SIDEBAR_REPO_STATE,
        this.boundRepoState,
      );
      this.gitEventTarget.addEventListener(
        GIT_SIDEBAR_WORKSPACE_UNREADY,
        this.boundWorkspaceUnready,
      );
      this.gitEventTarget.addEventListener(
        GIT_SIDEBAR_NOT_A_REPO,
        this.boundNotARepo,
      );
    }

    this.render();
    this.refresh();
  }

  destroy(): void {
    if (!this.gitEventTarget) return;
    this.gitEventTarget.removeEventListener(
      GIT_SIDEBAR_REPO_STATE,
      this.boundRepoState,
    );
    this.gitEventTarget.removeEventListener(
      GIT_SIDEBAR_WORKSPACE_UNREADY,
      this.boundWorkspaceUnready,
    );
    this.gitEventTarget.removeEventListener(
      GIT_SIDEBAR_NOT_A_REPO,
      this.boundNotARepo,
    );
  }

  private workspaceIsBound(): boolean {
    return this.isWorkspaceReady?.() !== false;
  }

  setGitStatus(status: StatusRow[]) {
    this.gitStatus = status;
    this.refresh();
  }

  setRootPath(path: string) {
    this.rootPath = path;
    this.refresh();
  }

  async refresh() {
    if (!this.workspaceIsBound()) {
      this.treeData = [];
      this.render();
      return;
    }
    this.treeData = await this.buildTree(this.rootPath);
    this.render();
  }

  private async buildTree(
    path: string,
    parentPath: string = '',
  ): Promise<FileTreeNode[]> {
    try {
      const entries = await this.fs.readdir(path);
      const nodes: FileTreeNode[] = [];

      for (const entry of entries) {
        const fullPath =
          path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
        const relativePath = parentPath
          ? `${parentPath}/${entry.name}`
          : entry.name;

        // Skip .git directory in display
        if (entry.name === '.git') {
          continue;
        }

        const node: FileTreeNode = {
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory,
          isExpanded: false,
          children: [],
          gitStatus: this.getGitStatus(relativePath),
        };

        if (entry.isDirectory) {
          // Don't recursively load children initially
          node.children = []; // Will be loaded on expand
        }

        nodes.push(node);
      }

      // Sort: directories first, then files alphabetically
      nodes.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) {
          return a.name.localeCompare(b.name);
        }
        return a.isDirectory ? -1 : 1;
      });

      return nodes;
    } catch (error) {
      console.error('Error building tree:', error);
      return [];
    }
  }

  private getGitStatus(filepath: string): string | undefined {
    for (const row of this.gitStatus) {
      const [rowPath] = row;
      if (rowPath === filepath) {
        const classification = classifyStatusRow(row);

        if (classification.isUntracked) {
          return 'untracked';
        }

        // Check for staged changes first
        if (classification.isStaged) {
          if (classification.stagedStatus === 'A') return 'added-staged';
          if (classification.stagedStatus === 'D') return 'deleted-staged';
          if (classification.stagedStatus === 'M') return 'modified-staged';
        }

        // Then check for unstaged changes
        if (classification.isUnstaged) {
          if (classification.unstagedStatus === 'D') return 'deleted-unstaged';
          if (classification.unstagedStatus === 'M') return 'modified-unstaged';
        }
      }
    }
    return undefined;
  }

  private async expandNode(node: FileTreeNode) {
    if (node.isDirectory && node.children.length === 0) {
      const relativeParent = node.path
        .replace(this.rootPath + '/', '')
        .replace(/^\//, '');
      node.children = await this.buildTree(node.path, relativeParent);
    }
    node.isExpanded = true;
    this.render();
  }

  private collapseNode(node: FileTreeNode) {
    node.isExpanded = false;
    this.render();
  }

  private render() {
    this.container.innerHTML = '';

    let header: HTMLElement | null = null;
    if (!this.hideHeader) {
      header = document.createElement('div');
      header.className = this.showPanelTitle
        ? 'panel__header'
        : 'panel__header panel__header--toolbar-only';
      header.setAttribute('role', 'toolbar');
      header.setAttribute(
        'aria-label',
        this.showPanelTitle ? this.title : 'Explorer',
      );
      const titleBlock = this.showPanelTitle
        ? `<h3 class="panel__title">${getIcon('folder', 16, 'panel__header-icon')}${this.title}</h3>`
        : '';
      header.innerHTML = `
      ${titleBlock}
      <div class="panel__header-actions file-tree__toolbar">
        ${this.onOpenFolder ? `<button type="button" class="panel__icon-btn" id="open-folder-btn" title="Open Folder">${getIcon('folderInput', 16)}</button>` : ''}
        ${this.onCloseFolder ? `<button type="button" class="panel__icon-btn" id="close-folder-btn" title="Close Folder">${getIcon('folderClose', 16)}</button>` : ''}
      </div>
    `;
      this.container.appendChild(header);
    }

    // Tree content
    const treeContent = document.createElement('div');
    treeContent.className = 'panel__content';

    if (!this.workspaceIsBound()) {
      // No folder selected — keep panel body empty (same idea as Git panel idle state)
    } else if (this.treeData.length === 0) {
      treeContent.innerHTML =
        '<div class="placeholder placeholder--directory">Empty directory</div>';
    } else {
      this.treeData.forEach((node) => {
        this.renderNode(treeContent, node, 0);
      });
    }

    this.container.appendChild(treeContent);

    if (header) {
      const openFolderBtn = header.querySelector('#open-folder-btn');
      if (openFolderBtn && this.onOpenFolder) {
        openFolderBtn.addEventListener('click', () => this.onOpenFolder!());
      }

      const closeFolderBtn = header.querySelector('#close-folder-btn');
      if (closeFolderBtn && this.onCloseFolder) {
        closeFolderBtn.addEventListener('click', () => this.onCloseFolder!());
      }
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private renderNode(
    container: HTMLElement,
    node: FileTreeNode,
    depth: number,
  ) {
    const item = document.createElement('div');
    item.className = 'file-tree__entry';
    item.style.setProperty('--tree-depth', String(depth));

    const iconName = node.isDirectory
      ? node.isExpanded
        ? 'folderOpen'
        : 'folder'
      : 'fileText';
    const icon = getIcon(iconName, 16, 'file-row__type-icon-svg');
    const chevronIcon = node.isDirectory
      ? getIcon(
          node.isExpanded ? 'chevronDown' : 'chevronRight',
          14,
          'file-row__chevron-svg',
        )
      : '';
    const statusClass = node.gitStatus || '';
    const statusDescription = node.gitStatus
      ? this.getStatusDescription(node.gitStatus)
      : '';
    const statusMod = statusClass
      ? ` file-row__status--${statusClass}`
      : '';
    const statusIndicator = node.gitStatus
      ? `<span class="file-row__status${statusMod}" title="${this.escapeHtml(statusDescription)}">${this.getStatusSymbol(node.gitStatus)}</span>`
      : '';

    // Show change counts for collapsed folders
    let folderChangesIndicator = '';
    if (node.isDirectory && !node.isExpanded && node.children.length > 0) {
      const changeCounts = this.countChangesInFolder(node);
      if (changeCounts.size > 0) {
        const changesText = this.formatFolderChanges(changeCounts);
        folderChangesIndicator = `<span class="file-row__folder-badge" title="${this.escapeHtml(changesText)}">${this.escapeHtml(changesText)}</span>`;
      }
    }

    const nameHtml = this.escapeHtml(node.name);
    const pathAttr = this.escapeHtml(node.path);
    item.innerHTML = `
      <div class="file-row file-row--clickable file-row--tree" data-path="${pathAttr}">
        <span class="file-row__type-icon">${icon}</span>
        <span class="file-row__path">${nameHtml}</span>
        ${folderChangesIndicator}
        ${statusIndicator}
        <span class="file-row__chevron">${chevronIcon}</span>
      </div>
    `;

    const row = item.querySelector('.file-row--tree') as HTMLElement;
    if (row) {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (node.isDirectory) {
          if (node.isExpanded) {
            this.collapseNode(node);
          } else {
            this.expandNode(node);
          }
        } else {
          this.onFileSelect(node.path);
        }
      });
    }

    container.appendChild(item);

    // Render children if expanded
    if (node.isDirectory && node.isExpanded && node.children.length > 0) {
      node.children.forEach((child) => {
        this.renderNode(container, child, depth + 1);
      });
    }
  }

  private getStatusSymbol(status: string): string {
    const symbols: Record<string, string> = {
      'modified-staged': 'M',
      'modified-unstaged': 'M',
      modified: 'M',
      'added-staged': 'A',
      'added-unstaged': 'A',
      added: 'A',
      'deleted-staged': 'D',
      'deleted-unstaged': 'D',
      deleted: 'D',
      staged: 'S',
      untracked: '?',
    };
    return symbols[status] || '';
  }

  private getStatusDescription(status: string): string {
    const descriptions: Record<string, string> = {
      'modified-staged': 'modified (staged)',
      'modified-unstaged': 'modified (unstaged)',
      modified: 'modified',
      'added-staged': 'added (staged)',
      'added-unstaged': 'added (unstaged)',
      added: 'added',
      'deleted-staged': 'deleted (staged)',
      'deleted-unstaged': 'deleted (unstaged)',
      deleted: 'deleted',
      staged: 'staged',
      untracked: 'untracked',
    };
    return descriptions[status] || status;
  }

  private countChangesInFolder(node: FileTreeNode): Map<string, number> {
    const counts = new Map<string, number>();

    const countRecursive = (n: FileTreeNode) => {
      if (n.gitStatus) {
        const baseStatus = n.gitStatus
          .replace('-staged', '')
          .replace('-unstaged', '');
        counts.set(baseStatus, (counts.get(baseStatus) || 0) + 1);
      }
      if (n.children) {
        n.children.forEach(countRecursive);
      }
    };

    if (node.children) {
      node.children.forEach(countRecursive);
    }

    return counts;
  }

  private formatFolderChanges(counts: Map<string, number>): string {
    const parts: string[] = [];
    if (counts.get('added')) parts.push(`${counts.get('added')} added`);
    if (counts.get('modified'))
      parts.push(`${counts.get('modified')} modified`);
    if (counts.get('deleted')) parts.push(`${counts.get('deleted')} deleted`);
    if (counts.get('untracked'))
      parts.push(`${counts.get('untracked')} untracked`);
    return parts.join(', ');
  }
}
