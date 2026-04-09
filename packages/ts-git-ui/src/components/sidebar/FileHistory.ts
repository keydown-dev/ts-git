import type { LogEntry } from '@keydown-app/ts-git';
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

export interface FileHistoryOptions {
  container: HTMLElement;
  git: GitOperations;
  gitEventTarget: EventTarget;
  requestRefresh: () => void | Promise<void>;
  onRepositoryInitialized?: () => void | Promise<void>;
  onShowCommitDiff?: (commitOid: string) => void | Promise<void>;
}

export class FileHistory {
  private git: GitOperations;
  private requestRefresh: () => void | Promise<void>;
  private onRepositoryInitialized?: () => void | Promise<void>;
  private onShowCommitDiff?: (commitOid: string) => void | Promise<void>;
  private gitEventTarget: EventTarget;

  private shell: ReturnType<typeof createGitPaneShell>;
  private commitLogElement!: HTMLElement;
  private commitLog: LogEntry[] = [];

  private boundWorkspaceUnready = () => this.showNoWorkspaceState();
  private boundNotARepo = () => this.showEmptyState();
  private boundRepoState = (ev: Event) =>
    this.onRepoState((ev as CustomEvent<GitRepoStateDetail>).detail);
  private boundStatusError = () => this.onStatusError();

  constructor(options: FileHistoryOptions) {
    this.git = options.git;
    this.requestRefresh = options.requestRefresh;
    this.onRepositoryInitialized = options.onRepositoryInitialized;
    this.onShowCommitDiff = options.onShowCommitDiff;
    this.gitEventTarget = options.gitEventTarget;

    this.shell = createGitPaneShell(
      options.container,
      () => void this.handleInitializeRepository(),
    );

    this.commitLogElement = document.createElement('div');
    this.commitLogElement.className = 'file-history__log';
    this.shell.gitRepoContent.appendChild(this.commitLogElement);

    this.bindCommitInteractions();
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

  private bindCommitInteractions(): void {
    const handler = (ev: MouseEvent | KeyboardEvent) => {
      const commitEl = (ev.target as HTMLElement).closest<HTMLElement>(
        '.file-history__entry',
      );
      if (!commitEl) return;

      // Handle keyboard events
      if (ev instanceof KeyboardEvent) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
      }

      const oid = commitEl.getAttribute('data-commit-oid');
      if (oid && this.onShowCommitDiff) {
        void this.onShowCommitDiff(oid);
      }
    };

    this.commitLogElement.addEventListener('click', handler);
    this.commitLogElement.addEventListener('keydown', handler);
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
    this.commitLog = detail.log;
    this.showGitContent();
    this.renderCommitLog();
  }

  private onStatusError() {
    this.commitLogElement.innerHTML = '';
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

  private renderCommitLog() {
    if (this.commitLog.length === 0) {
      this.commitLogElement.innerHTML =
        '<div class="placeholder placeholder--history">No commits yet</div>';
      return;
    }

    let html = '';
    for (const commit of this.commitLog) {
      const date = new Date(commit.commit.committer.timestamp * 1000);
      const shortDate = date.toLocaleDateString();
      const shortHash = commit.oid.slice(0, 7);
      const message = commit.commit.message.split('\n')[0];
      html += `
        <div class="file-history__entry file-row file-row--clickable" role="button" tabindex="0" data-commit-oid="${commit.oid}">
          <div class="file-history__entry-icon" aria-hidden="true">${getIcon('gitCommitVertical', 14, 'file-history__entry-icon-svg')}</div>
          <div class="file-history__entry-body">
            <span class="file-history__hash">${shortHash}</span>
            <span class="file-history__date">${shortDate}</span>
            <span class="file-history__message">${escapeHtml(message)}</span>
          </div>
        </div>
      `;
    }
    this.commitLogElement.innerHTML = html;
  }
}
