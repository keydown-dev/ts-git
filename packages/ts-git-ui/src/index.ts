export {
  FileTree,
  type FileTreeOptions,
} from './components/sidebar/FileTree.js';
export {
  Terminal,
  type TerminalOptions,
  type CommandResult,
} from './components/Terminal.js';
export {
  FileEditor,
  type FileEditorOptions,
} from './components/terminal/FileEditor.js';
export {
  Sidebar,
  type SidebarOptions,
  type SidebarTabId,
  FileChanges,
  type FileChangesOptions,
  FileHistory,
  type FileHistoryOptions,
  type GitOperations,
  GIT_SIDEBAR_NOT_A_REPO,
  GIT_SIDEBAR_REPO_STATE,
  GIT_SIDEBAR_STATUS_ERROR,
  GIT_SIDEBAR_WORKSPACE_UNREADY,
  dispatchGitSidebarEvent,
  type GitRepoStateDetail,
} from './components/Sidebar.js';
export { App, type AppConfig } from './components/App.js';
export { NullAdapter } from './lib/NullAdapter.js';
export {
  FilePreview,
  type FilePreviewOptions,
  type FilePreviewGitOperations,
} from './components/terminal/FilePreview.js';
export {
  getIcon,
  createIconElement,
  iconRegistry,
  type IconName,
} from './lib/icons.js';
