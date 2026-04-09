import type { StatusRow } from '@keydown-app/ts-git';
import { classifyStatusRow } from '@keydown-app/ts-git';
import { getIcon } from '../../lib/icons.js';
import {
  GIT_SIDEBAR_NOT_A_REPO,
  GIT_SIDEBAR_REPO_STATE,
  GIT_SIDEBAR_STATUS_ERROR,
  GIT_SIDEBAR_WORKSPACE_UNREADY,
  type GitRepoStateDetail,
} from './gitEvents.js';
import {
  type GitOperations,
  createGitPaneShell,
  escapeHtml,
} from './gitPanelShared.js';

export interface FileChangesOptions {
  container: HTMLElement;
  git: GitOperations;
  /** Where git sidebar custom events are dispatched (listen here). */
  gitEventTarget: EventTarget;
  onShowDiff?: (request: { path: string; cached: boolean }) => void;
  onRepositoryInitialized?: () => void | Promise<void>;
  requestRefresh: () => void | Promise<void>;
}

export class FileChanges {
  private git: GitOperations;
  private onShowDiff?: (request: { path: string; cached: boolean }) => void;
  private onRepositoryInitialized?: () => void | Promise<void>;
  private requestRefresh: () => void | Promise<void>;
  private gitEventTarget: EventTarget;

  private shell: ReturnType<typeof createGitPaneShell>;
  private changesErrorElement!: HTMLElement;
  private changesCleanElement!: HTMLElement;
  private stagedSection!: HTMLElement;
  private stagedSummaryElement!: HTMLElement;
  private unstagedSection!: HTMLElement;
  private unstagedSummaryElement!: HTMLElement;

  private gitStatus: StatusRow[];
  private stagedCount = 0;
  private unstagedCount = 0;

  private boundWorkspaceUnready = () => this.showNoWorkspaceState();
  private boundNotARepo = () => this.showEmptyState();
  private boundRepoState = (ev: Event) =>
    this.onRepoState((ev as CustomEvent<GitRepoStateDetail>).detail);
  private boundStatusError = () => this.showChangesLoadError();

  constructor(options: FileChangesOptions) {
    this.git = options.git;
    this.onShowDiff = options.onShowDiff;
    this.onRepositoryInitialized = options.onRepositoryInitialized;
    this.requestRefresh = options.requestRefresh;
    this.gitEventTarget = options.gitEventTarget;
    this.gitStatus = [];

    this.shell = createGitPaneShell(
      options.container,
      () => void this.handleInitializeRepository(),
    );

    const host = this.shell.gitRepoContent;

    this.changesErrorElement = document.createElement('div');
    this.changesErrorElement.className = 'file-changes__error';
    this.changesErrorElement.style.display = 'none';
    host.appendChild(this.changesErrorElement);

    this.changesCleanElement = document.createElement('div');
    this.changesCleanElement.className = 'file-changes__clean';
    this.changesCleanElement.style.display = 'none';
    host.appendChild(this.changesCleanElement);

    this.stagedSection = document.createElement('div');
    this.stagedSection.className =
      'repo-pane__subsection file-changes__subsection file-changes__subsection--staged';
    const stagedHeader = document.createElement('h4');
    stagedHeader.className = 'repo-pane__subsection-heading';
    stagedHeader.innerHTML =
      '<span class="file-changes__count">0</span> Staged Changes';
    this.stagedSection.appendChild(stagedHeader);
    this.stagedSummaryElement = document.createElement('div');
    this.stagedSummaryElement.className = 'file-changes__summary';
    this.stagedSection.appendChild(this.stagedSummaryElement);
    host.appendChild(this.stagedSection);

    this.unstagedSection = document.createElement('div');
    this.unstagedSection.className =
      'repo-pane__subsection file-changes__subsection file-changes__subsection--unstaged';
    const unstagedHeader = document.createElement('h4');
    unstagedHeader.className = 'repo-pane__subsection-heading';
    unstagedHeader.innerHTML =
      '<span class="file-changes__count">0</span> Changes';
    this.unstagedSection.appendChild(unstagedHeader);
    this.unstagedSummaryElement = document.createElement('div');
    this.unstagedSummaryElement.className = 'file-changes__summary';
    this.unstagedSection.appendChild(this.unstagedSummaryElement);
    host.appendChild(this.unstagedSection);

    this.bindFileDiffClicks();
    this.bindFileActionClicks();
    this.subscribeEvents();
  }

  destroy(): void {
    this.gitEventTarget.removeEventListener(
      GIT_SIDEBAR_WORKSPACE_UNREADY,
      this.boundWorkspaceUnready,
    );
    this.gitEventTarget.removeEventListener(
      GIT_SIDEBAR_NOT_A_REPO,
      this.boundNotARepo,
    );
    this.gitEventTarget.removeEventListener(
      GIT_SIDEBAR_REPO_STATE,
      this.boundRepoState,
    );
    this.gitEventTarget.removeEventListener(
      GIT_SIDEBAR_STATUS_ERROR,
      this.boundStatusError,
    );
  }

  private subscribeEvents(): void {
    this.gitEventTarget.addEventListener(
      GIT_SIDEBAR_WORKSPACE_UNREADY,
      this.boundWorkspaceUnready,
    );
    this.gitEventTarget.addEventListener(
      GIT_SIDEBAR_NOT_A_REPO,
      this.boundNotARepo,
    );
    this.gitEventTarget.addEventListener(
      GIT_SIDEBAR_REPO_STATE,
      this.boundRepoState,
    );
    this.gitEventTarget.addEventListener(
      GIT_SIDEBAR_STATUS_ERROR,
      this.boundStatusError,
    );
  }

  private bindFileDiffClicks() {
    const handler = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement;
      const row = target.closest<HTMLElement>('.file-row--clickable');
      // Ignore clicks on action buttons (let bindFileActionClicks handle those)
      if (!row || target.closest('.file-row__action')) return;
      if (!this.onShowDiff) return;
      const enc = row.getAttribute('data-file-path');
      const kind = row.getAttribute('data-diff-kind');
      if (!enc || (kind !== 'staged' && kind !== 'unstaged')) return;
      ev.preventDefault();
      const path = decodeURIComponent(enc);
      this.onShowDiff({ path, cached: kind === 'staged' });
    };
    this.stagedSummaryElement.addEventListener('click', handler);
    this.unstagedSummaryElement.addEventListener('click', handler);
  }

  private bindFileActionClicks() {
    const handler = (ev: MouseEvent) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>(
        '.file-row__action',
      );
      if (!btn) return;
      ev.stopPropagation();
      const row = btn.closest<HTMLElement>('.file-row--clickable');
      if (!row) return;
      const enc = row.getAttribute('data-file-path');
      const kind = row.getAttribute('data-diff-kind');
      if (!enc) return;
      const filepath = decodeURIComponent(enc);

      if (kind === 'staged') {
        void this.handleUnstage(filepath);
      } else if (kind === 'unstaged') {
        void this.handleStage(filepath);
      }
    };
    this.stagedSummaryElement.addEventListener('click', handler);
    this.unstagedSummaryElement.addEventListener('click', handler);
  }

  private async handleStage(filepath: string) {
    try {
      await this.git.add(filepath);
      await this.requestRefresh();
    } catch (err) {
      console.error('Failed to stage file:', err);
    }
  }

  private async handleUnstage(filepath: string) {
    try {
      await this.git.reset(filepath);
      await this.requestRefresh();
    } catch (err) {
      console.error('Failed to unstage file:', err);
    }
  }

  private async handleInitializeRepository() {
    this.shell.initErrorElement.style.display = 'none';
    this.shell.initErrorElement.textContent = '';
    this.shell.initButton.disabled = true;
    try {
      await this.git.init();
      await this.requestRefresh();
      await this.onRepositoryInitialized?.();
    } catch (err) {
      console.error('Git init from panel failed:', err);
      this.shell.initErrorElement.textContent =
        'Could not initialize repository. Try again or use the terminal.';
      this.shell.initErrorElement.style.display = 'block';
    } finally {
      this.shell.initButton.disabled = false;
    }
  }

  private onRepoState(detail: GitRepoStateDetail) {
    this.gitStatus = detail.status;
    this.clearChangesError();
    this.showGitContent();
    this.renderDiffSummary();
    this.updateSectionCounts();
  }

  private clearChangesError() {
    this.changesErrorElement.style.display = 'none';
    this.changesErrorElement.textContent = '';
  }

  private showChangesLoadError() {
    this.changesErrorElement.textContent = 'Unable to load git status';
    this.changesErrorElement.style.display = 'block';
    this.changesCleanElement.style.display = 'none';
    this.stagedSection.style.display = 'none';
    this.unstagedSection.style.display = 'none';
    this.stagedSummaryElement.innerHTML = '';
    this.unstagedSummaryElement.innerHTML = '';
    this.stagedCount = 0;
    this.unstagedCount = 0;
    this.showGitContent();
  }

  private showNoWorkspaceState() {
    this.shell.noRepoContentWrapper.style.display = 'none';
    this.shell.gitNotRepoBody.classList.add('repo-pane__not-repo--bare');
    this.shell.gitNotRepoBody.style.display = 'flex';
    this.shell.gitRepoContent.style.display = 'none';
  }

  private showEmptyState() {
    this.shell.gitNotRepoBody.classList.remove('repo-pane__not-repo--bare');
    this.shell.noRepoContentWrapper.style.display = '';
    this.shell.initErrorElement.style.display = 'none';
    this.shell.initErrorElement.textContent = '';
    this.shell.initButton.disabled = false;
    this.shell.gitNotRepoBody.style.display = 'flex';
    this.shell.gitRepoContent.style.display = 'none';
  }

  private showGitContent() {
    this.shell.gitNotRepoBody.style.display = 'none';
    this.shell.gitNotRepoBody.classList.remove('repo-pane__not-repo--bare');
    this.shell.gitRepoContent.style.display = 'flex';
  }

  private updateSectionCounts() {
    const stagedHeader = this.stagedSection.querySelector('.file-changes__count');
    if (stagedHeader) stagedHeader.textContent = String(this.stagedCount);
    const unstagedHeader =
      this.unstagedSection.querySelector('.file-changes__count');
    if (unstagedHeader) unstagedHeader.textContent = String(this.unstagedCount);
  }

  private renderDiffSummary() {
    const changedFiles = this.gitStatus.filter((row) => {
      const [, headStatus, workdirStatus, stageStatus] = row;
      const isUnmodified =
        headStatus === 1 && workdirStatus === 1 && stageStatus === 1;
      return !isUnmodified;
    });

    if (changedFiles.length === 0) {
      this.stagedSection.style.display = 'none';
      this.unstagedSection.style.display = 'none';
      this.stagedSummaryElement.innerHTML = '';
      this.unstagedSummaryElement.innerHTML = '';
      this.stagedCount = 0;
      this.unstagedCount = 0;
      this.changesCleanElement.innerHTML = `<div class="file-changes__clean-message">${getIcon('check', 16, 'file-changes__clean-icon')} Working tree clean</div>`;
      this.changesCleanElement.style.display = 'block';
      return;
    }

    this.changesCleanElement.style.display = 'none';
    this.changesCleanElement.innerHTML = '';

    const stagedFiles: StatusRow[] = [];
    const unstagedFiles: StatusRow[] = [];

    for (const row of changedFiles) {
      const classification = classifyStatusRow(row);
      if (classification.isStaged) stagedFiles.push(row);
      if (classification.isUnstaged || classification.isUntracked) {
        unstagedFiles.push(row);
      }
    }

    this.stagedCount = stagedFiles.length;
    this.unstagedCount = unstagedFiles.length;

    if (stagedFiles.length > 0) {
      this.stagedSection.style.display = 'block';
      this.stagedSummaryElement.innerHTML = this.renderFileList(
        stagedFiles,
        'staged',
      );
    } else {
      this.stagedSection.style.display = 'none';
    }

    if (unstagedFiles.length > 0) {
      this.unstagedSection.style.display = 'block';
      this.unstagedSummaryElement.innerHTML = this.renderFileList(
        unstagedFiles,
        'unstaged',
      );
    } else {
      this.unstagedSection.style.display = 'none';
    }

    this.updateSectionCounts();
  }

  private renderFileList(
    files: StatusRow[],
    context: 'staged' | 'unstaged',
  ): string {
    const stats = {
      added: 0,
      modified: 0,
      deleted: 0,
      untracked: 0,
    };

    for (const row of files) {
      const [, headStatus, workdirStatus] = row;
      if (headStatus === 0 && workdirStatus === 2) stats.added++;
      else if (headStatus === 1 && workdirStatus === 0) stats.deleted++;
      else if (headStatus === 1 && workdirStatus === 2) stats.modified++;
      else if (headStatus === 0 && workdirStatus === 1) stats.untracked++;
    }

    let html = '';

    if (files.length > 0) {
      html += '<div class="file-changes__list">';
      for (const row of files) {
        const [filepath, headStatus, workdirStatus] = row;
        let statusClass = '';
        let statusSymbol = '';
        if (headStatus === 0 && workdirStatus === 2) {
          statusClass = 'added';
          statusSymbol = 'A';
        } else if (headStatus === 1 && workdirStatus === 0) {
          statusClass = 'deleted';
          statusSymbol = 'D';
        } else if (headStatus === 1 && workdirStatus === 2) {
          statusClass = 'modified';
          statusSymbol = 'M';
        } else if (headStatus === 0 && workdirStatus === 1) {
          statusClass = 'untracked';
          statusSymbol = '?';
        }
        if (context === 'staged') {
          statusClass = 'staged';
          statusSymbol = 'S';
        }
        const pathAttr = encodeURIComponent(filepath);
        const pathHtml = escapeHtml(filepath);
        const clickClass = this.onShowDiff ? ' file-row--clickable' : '';
        const clickAttrs = this.onShowDiff
          ? ` role="button" tabindex="0" data-file-path="${pathAttr}" data-diff-kind="${context}"`
          : '';

        // Action button: minus for staged (unstage), plus for unstaged (stage)
        const actionIcon = context === 'staged' ? 'minus' : 'plus';
        const actionTitle =
          context === 'staged' ? 'Unstage file' : 'Stage file';
        const actionButton = `
          <button type="button" class="file-row__action" title="${actionTitle}" aria-label="${actionTitle}">
            ${getIcon(actionIcon, 14, 'file-row__action-icon')}
          </button>
        `;

        const statusMod = statusClass
          ? ` file-row__status--${statusClass}`
          : '';
        html += `
          <div class="file-row${clickClass}"${clickAttrs}>
            <span class="file-row__status${statusMod}">${statusSymbol}</span>
            <span class="file-row__path">${pathHtml}</span>
            ${actionButton}
          </div>
        `;
      }
      html += '</div>';
    }
    return html;
  }
}
