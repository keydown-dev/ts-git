import type { LogEntry, StatusRow } from '@keydown-dev/ts-git';
import { classifyStatusRow } from '@keydown-dev/ts-git';

export interface GitOperations {
  init(): Promise<void>;
  isWorkspaceReady?(): boolean;
  statusMatrix(): Promise<StatusRow[]>;
  log(depth?: number): Promise<LogEntry[]>;
  listBranches(): Promise<{ branches: string[]; current: string | null }>;
  add(filepath: string): Promise<void>;
  reset(filepath?: string | string[]): Promise<string[]>;
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export interface GitPaneShell {
  root: HTMLElement;
  gitNotRepoBody: HTMLElement;
  noRepoContentWrapper: HTMLElement;
  initButton: HTMLButtonElement;
  initErrorElement: HTMLElement;
  /** Repo UI (changes / history) mounts here; `.sidebar__pane` scrolls. */
  gitRepoContent: HTMLElement;
}

/**
 * Shared chrome for Changes / History panes (not-repo + repo content host).
 */
export function createGitPaneShell(
  container: HTMLElement,
  onInitClick: () => void,
): GitPaneShell {
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'repo-pane__root';

  const gitNotRepoBody = document.createElement('div');
  gitNotRepoBody.className = 'repo-pane__not-repo';
  gitNotRepoBody.style.display = 'none';

  const noRepoContentWrapper = document.createElement('div');
  noRepoContentWrapper.className = 'repo-pane__no-repo-actions';

  const notRepoDescription = document.createElement('p');
  notRepoDescription.className = 'repo-pane__description';
  notRepoDescription.textContent =
    "The folder currently open doesn't have a Git repository. You can initialize a repository to enable source control features powered by Git.";
  noRepoContentWrapper.appendChild(notRepoDescription);

  const initErrorElement = document.createElement('div');
  initErrorElement.className = 'repo-pane__init-error';
  initErrorElement.style.display = 'none';
  noRepoContentWrapper.appendChild(initErrorElement);

  const initButton = document.createElement('button');
  initButton.type = 'button';
  initButton.className = 'repo-pane__init-button';
  initButton.textContent = 'Initialize repository';
  initButton.addEventListener('click', () => {
    void onInitClick();
  });
  noRepoContentWrapper.appendChild(initButton);

  gitNotRepoBody.appendChild(noRepoContentWrapper);
  root.appendChild(gitNotRepoBody);

  const gitRepoContent = document.createElement('div');
  gitRepoContent.className = 'repo-pane__repo';
  gitRepoContent.style.display = 'none';

  root.appendChild(gitRepoContent);

  container.appendChild(root);

  return {
    root,
    gitNotRepoBody,
    noRepoContentWrapper,
    initButton,
    initErrorElement,
    gitRepoContent,
  };
}

/** Staged + unstaged file counts for footer / badge (matches prior single-panel behavior). */
export function countWorkingTreeFiles(status: StatusRow[]): {
  stagedCount: number;
  unstagedCount: number;
} {
  const changedFiles = status.filter((row) => {
    const [, headStatus, workdirStatus, stageStatus] = row;
    const isUnmodified =
      headStatus === 1 && workdirStatus === 1 && stageStatus === 1;
    return !isUnmodified;
  });

  const stagedFiles: StatusRow[] = [];
  const unstagedFiles: StatusRow[] = [];

  for (const row of changedFiles) {
    const classification = classifyStatusRow(row);
    if (classification.isStaged) stagedFiles.push(row);
    if (classification.isUnstaged || classification.isUntracked) {
      unstagedFiles.push(row);
    }
  }

  return {
    stagedCount: stagedFiles.length,
    unstagedCount: unstagedFiles.length,
  };
}
