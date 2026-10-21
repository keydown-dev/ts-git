import type { LogEntry, StatusRow } from '@keydown-dev/ts-git';

/** Dispatched on sidebar root when no workspace folder is open. */
export const GIT_SIDEBAR_WORKSPACE_UNREADY = 'ts-git:sidebar-workspace-unready';

/** Dispatched when the open folder is not a git repository. */
export const GIT_SIDEBAR_NOT_A_REPO = 'ts-git:sidebar-not-a-repo';

/** Successful fetch: status matrix, log, and current branch. */
export const GIT_SIDEBAR_REPO_STATE = 'ts-git:sidebar-repo-state';

/** Git status failed for a reason other than not-a-repo. */
export const GIT_SIDEBAR_STATUS_ERROR = 'ts-git:sidebar-status-error';

export interface GitRepoStateDetail {
  status: StatusRow[];
  log: LogEntry[];
  branch: string | null;
}

export type GitSidebarEventMap = {
  [GIT_SIDEBAR_WORKSPACE_UNREADY]: Record<string, never>;
  [GIT_SIDEBAR_NOT_A_REPO]: Record<string, never>;
  [GIT_SIDEBAR_REPO_STATE]: GitRepoStateDetail;
  [GIT_SIDEBAR_STATUS_ERROR]: Record<string, never>;
};

export function dispatchGitSidebarEvent<K extends keyof GitSidebarEventMap>(
  target: EventTarget,
  type: K,
  detail: GitSidebarEventMap[K],
): void {
  target.dispatchEvent(
    new CustomEvent(type, {
      detail,
      bubbles: false,
    }),
  );
}
