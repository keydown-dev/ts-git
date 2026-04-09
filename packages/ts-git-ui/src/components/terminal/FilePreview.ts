import type {
  FSAdapter,
  LogEntry,
  DiffResult,
  FileDelta,
  Hunk,
} from '@keydown-app/ts-git';
import { normalizeRepoRelativePath, relative } from '@keydown-app/ts-git';
import type { GitOperations as SidebarGitOperations } from '../sidebar/gitPanelShared.js';
import { getIcon } from '../../lib/icons.js';

/** Git client surface required by {@link FilePreview} (sidebar ops + diff). */
export type FilePreviewGitOperations = SidebarGitOperations & {
  diff(options?: {
    left?: { type: string; ref?: string };
    right?: { type: string };
    cached?: boolean;
    paths?: string[];
  }): Promise<DiffResult>;
};

export interface FilePreviewOptions {
  container: HTMLElement;
  fs: FSAdapter;
  git: FilePreviewGitOperations;
  filepath: string;
  /** Git repository root (GitClient.dir), not the terminal cwd — used for diff pathspecs. */
  repoDir: string;
  onEdit: (filepath: string) => void;
  onClose: () => void;
}

export class FilePreview {
  private container: HTMLElement;
  private fs: FSAdapter;
  private git: FilePreviewGitOperations;
  private filepath: string;
  private repoDir: string;
  private onEdit: (filepath: string) => void;
  private onClose: () => void;

  private commits: LogEntry[] = [];
  private selectedCommitOid: string | null = null;
  private showDiff: boolean = false;
  private fileContent: string | null = null;
  private isBinary: boolean = false;
  private fileStatus: 'unchanged' | 'modified' | 'new' | 'deleted' | 'unknown' =
    'unknown';
  private diffResult: DiffResult | null = null;
  private isLoading: boolean = true;
  private error: string | null = null;

  private diffElement!: HTMLElement;
  private dropdownElement!: HTMLSelectElement;

  constructor(options: FilePreviewOptions) {
    this.container = options.container;
    this.fs = options.fs;
    this.git = options.git;
    this.filepath = options.filepath;
    this.repoDir = options.repoDir;
    this.onEdit = options.onEdit;
    this.onClose = options.onClose;

    this.render();
    this.loadData();
  }

  private async loadData(): Promise<void> {
    try {
      const content = await this.fs.readFile(this.filepath);
      this.isBinary = this.detectBinary(content);
      this.fileContent = this.isBinary
        ? null
        : new TextDecoder().decode(content);

      if (!this.isBinary) {
        this.commits = await this.git.log(50);
      }

      // Always start with no diff selected
      this.showDiff = false;
      this.selectedCommitOid = null;

      this.isLoading = false;
      this.renderContent();
    } catch (err) {
      this.isLoading = false;
      this.error = err instanceof Error ? err.message : String(err);
      this.renderContent();
    }
  }

  /** Repo-relative path; matches diff snapshot keys (index / tree / walk). */
  private getRepoRelativePath(): string {
    return normalizeRepoRelativePath(relative(this.repoDir, this.filepath));
  }

  private findDeltaForPath(): FileDelta | undefined {
    const want = normalizeRepoRelativePath(this.getRepoRelativePath());
    return this.diffResult?.deltas.find(
      (d) => normalizeRepoRelativePath(d.path) === want,
    );
  }

  private detectBinary(content: Uint8Array): boolean {
    const checkLength = Math.min(content.length, 8192);
    for (let i = 0; i < checkLength; i++) {
      if (content[i] === 0) {
        return true;
      }
    }
    return false;
  }

  private async loadDiff(): Promise<void> {
    if (!this.selectedCommitOid || this.isBinary) {
      this.fileStatus = 'unknown';
      return;
    }

    const relativePath = this.getRepoRelativePath();

    try {
      const result = await this.git.diff({
        left: { type: 'commit', ref: this.selectedCommitOid },
        right: { type: 'worktree' },
        paths: [relativePath],
      });

      this.diffResult = result;
      const fileDelta = this.findDeltaForPath();

      if (fileDelta) {
        // File exists in both commit and worktree but differs
        if (fileDelta.status === 'A') {
          this.fileStatus = 'new';
        } else if (fileDelta.status === 'D') {
          this.fileStatus = 'deleted';
        } else if (fileDelta.status === 'M') {
          this.fileStatus = 'modified';
        } else {
          this.fileStatus = 'unknown';
        }
      } else {
        // File not in deltas means it's unchanged (same in commit and worktree)
        this.fileStatus = 'unchanged';
      }
    } catch (err) {
      console.error('Error loading diff:', err);
      this.fileStatus = 'unknown';
    }
  }

  private render(): void {
    this.container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'panel-header content-preview-header';

    const relativePath = this.getRepoRelativePath();
    const filename = relativePath.split('/').pop() || relativePath;

    header.innerHTML = `
      <div class="content-preview-title">
        ${getIcon('fileText', 16, 'panel-header-icon')}
        <span class="filename" title="${relativePath}">${filename}</span>
      </div>
      <div class="content-preview-actions">
        <label class="commit-dropdown-label">
          <select class="commit-dropdown" id="commit-select">
            <option value="">No Diff</option>
          </select>
        </label>
        <button class="edit-btn" title="Edit file">${getIcon('edit', 16)}</button>
        <button class="close-btn" title="Close">${getIcon('x', 16)}</button>
      </div>
    `;

    this.container.appendChild(header);

    this.dropdownElement = header.querySelector(
      '#commit-select',
    ) as HTMLSelectElement;
    this.dropdownElement.addEventListener('change', () =>
      this.handleCommitChange(),
    );

    const editBtn = header.querySelector('.edit-btn') as HTMLButtonElement;
    editBtn.addEventListener('click', () => this.handleEdit());

    const closeBtn = header.querySelector('.close-btn') as HTMLButtonElement;
    closeBtn.addEventListener('click', () => this.onClose());

    this.diffElement = document.createElement('div');
    this.diffElement.className = 'panel-content content-preview-content';
    this.diffElement.innerHTML = '<div class="loading">Loading...</div>';
    this.container.appendChild(this.diffElement);
  }

  private renderContent(): void {
    if (this.error) {
      this.diffElement.innerHTML = `<div class="error-state">${this.escapeHtml(this.error)}</div>`;
      this.updateDropdown();
      return;
    }

    if (this.isLoading) {
      this.diffElement.innerHTML = '<div class="loading">Loading...</div>';
      return;
    }

    if (this.isBinary) {
      this.diffElement.innerHTML = `
        <div class="binary-file-notice">
          ${getIcon('fileText', 48, 'binary-icon')}
          <p>Binary file</p>
          <p class="binary-hint">Cannot display binary content</p>
        </div>
      `;
      this.updateDropdown();
      return;
    }

    this.updateDropdown();

    // If no diff is selected, just show the file content
    if (!this.showDiff || !this.selectedCommitOid) {
      this.renderPlainFile();
      return;
    }

    // Show diff based on file status
    switch (this.fileStatus) {
      case 'new':
        this.renderNewFile();
        break;
      case 'deleted':
        this.renderDeletedFile();
        break;
      case 'modified':
        this.renderModifiedFile();
        break;
      case 'unchanged':
        this.renderUnchangedFile();
        break;
      default:
        this.renderPlainFile();
    }
  }

  private renderPlainFile(): void {
    const content = this.fileContent || '';
    const lines = content.split('\n');

    let html = '<div class="diff-container">';
    html += '<div class="diff-content plain-file">';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      html += `<div class="diff-line context"><span class="line-num">${i + 1}</span><span class="line-content">${this.escapeHtml(line)}</span></div>`;
    }

    html += '</div></div>';
    this.diffElement.innerHTML = html;
  }

  private updateDropdown(): void {
    const select = this.dropdownElement;
    select.innerHTML = '';

    // Add "No diff" option as default
    const noDiffOption = document.createElement('option');
    noDiffOption.value = '';
    noDiffOption.textContent = 'No Diff';
    noDiffOption.selected = !this.showDiff || !this.selectedCommitOid;
    select.appendChild(noDiffOption);

    if (this.commits.length === 0) {
      select.disabled = false;
      return;
    }

    for (let i = 0; i < Math.min(this.commits.length, 50); i++) {
      const commit = this.commits[i];
      const option = document.createElement('option');
      option.value = commit.oid;
      option.textContent = 'Diff: ' + this.formatCommitLabel(commit);
      option.selected = this.selectedCommitOid === commit.oid;
      select.appendChild(option);
    }

    select.disabled = false;
  }

  private formatCommitLabel(commit: LogEntry): string {
    const shortOid = commit.oid.slice(0, 7);
    const message = commit.commit.message.split('\n')[0].slice(0, 30);
    const date = this.formatRelativeDate(commit.commit.committer.timestamp);

    if (message.length < commit.commit.message.split('\n')[0].length) {
      return `${shortOid} - ${message}... (${date})`;
    }
    return `${shortOid} - ${message} (${date})`;
  }

  private formatRelativeDate(timestamp: number): string {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;

    if (diff < 60) {
      return 'just now';
    } else if (diff < 3600) {
      const minutes = Math.floor(diff / 60);
      return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    } else if (diff < 86400) {
      const hours = Math.floor(diff / 3600);
      return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    } else if (diff < 604800) {
      const days = Math.floor(diff / 86400);
      return `${days} day${days !== 1 ? 's' : ''} ago`;
    } else {
      const date = new Date(timestamp * 1000);
      return date.toLocaleDateString();
    }
  }

  private async handleCommitChange(): Promise<void> {
    const selectedOid = this.dropdownElement.value;

    if (!selectedOid) {
      // User selected "No diff"
      this.showDiff = false;
      this.selectedCommitOid = null;
      this.fileStatus = 'unknown';
      this.diffResult = null;
      this.renderContent();
      return;
    }

    this.showDiff = true;
    this.selectedCommitOid = selectedOid;
    this.isLoading = true;
    this.renderContent();

    await this.loadDiff();

    this.isLoading = false;
    this.renderContent();
  }

  private handleEdit(): void {
    this.onEdit(this.filepath);
  }

  private renderNewFile(): void {
    const content = this.fileContent || '';
    const lines = content.split('\n');

    let html = '<div class="diff-container">';
    html +=
      '<div class="diff-header new-file-header">New file (not in selected commit)</div>';
    html += '<div class="diff-content">';

    const fileDelta = this.findDeltaForPath();
    if (fileDelta?.hunks && fileDelta.hunks.length > 0) {
      for (const hunk of fileDelta.hunks) {
        html += this.renderHunk(hunk);
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        html += `<div class="diff-line added"><span class="line-type">+</span><span class="line-content">${this.escapeHtml(line)}</span></div>`;
      }
    }

    html += '</div></div>';
    this.diffElement.innerHTML = html;
  }

  private renderDeletedFile(): void {
    let html = '<div class="diff-container">';
    html +=
      '<div class="diff-header deleted-file-header">File deleted in worktree</div>';
    html += '<div class="diff-content">';

    const fileDelta = this.findDeltaForPath();
    if (fileDelta?.hunks && fileDelta.hunks.length > 0) {
      for (const hunk of fileDelta.hunks) {
        html += this.renderHunk(hunk);
      }
    }

    html += '</div></div>';
    this.diffElement.innerHTML = html;
  }

  private renderModifiedFile(): void {
    const fileDelta = this.findDeltaForPath();
    if (!fileDelta) {
      this.renderPlainFile();
      return;
    }

    let html = '<div class="diff-container">';

    const statusLabel = this.getStatusLabel(fileDelta.status);
    const stats = this.getDeltaStats(fileDelta);
    html += `<div class="diff-header"><span class="status-badge ${statusLabel.class}">${statusLabel.text}</span><span class="diff-stats">${stats}</span></div>`;

    html += '<div class="diff-content">';

    if (fileDelta.hunks && fileDelta.hunks.length > 0) {
      for (const hunk of fileDelta.hunks) {
        html += this.renderHunk(hunk);
      }
    }

    html += '</div></div>';
    this.diffElement.innerHTML = html;
  }

  private renderUnchangedFile(): void {
    const content = this.fileContent || '';
    const lines = content.split('\n');

    let html = '<div class="diff-container">';
    html +=
      '<div class="diff-header no-changes-header">No changes (file is identical to selected commit)</div>';
    html += '<div class="diff-content">';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      html += `<div class="diff-line context"><span class="line-num">${i + 1}</span><span class="line-content">${this.escapeHtml(line)}</span></div>`;
    }

    html += '</div></div>';
    this.diffElement.innerHTML = html;
  }

  private renderHunk(hunk: Hunk): string {
    let html = `<div class="diff-hunk-header">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;

    if (hunk.context) {
      html += ` ${this.escapeHtml(hunk.context.slice(0, 40))}`;
    }

    html += '</div>';

    for (const line of hunk.lines) {
      const className =
        line.type === '+' ? 'added' : line.type === '-' ? 'removed' : 'context';
      const prefix = line.type;

      html += `<div class="diff-line ${className}"><span class="line-type">${prefix}</span><span class="line-content">${this.escapeHtml(line.content)}</span></div>`;
    }

    return html;
  }

  private getStatusLabel(status: string): { text: string; class: string } {
    switch (status) {
      case 'A':
        return { text: 'Added', class: 'added' };
      case 'M':
        return { text: 'Modified', class: 'modified' };
      case 'D':
        return { text: 'Deleted', class: 'deleted' };
      default:
        return { text: status, class: '' };
    }
  }

  private getDeltaStats(delta: FileDelta): string {
    const parts: string[] = [];

    if (delta.addedLines !== undefined && delta.addedLines > 0) {
      parts.push(`+${delta.addedLines}`);
    }
    if (delta.deletedLines !== undefined && delta.deletedLines > 0) {
      parts.push(`-${delta.deletedLines}`);
    }

    return parts.join(' ');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  refresh(): void {
    this.loadData();
  }

  setFilepath(filepath: string): void {
    this.filepath = filepath;
    this.isLoading = true;
    this.isBinary = false;
    this.fileStatus = 'unknown';
    this.showDiff = false;
    this.commits = [];
    this.selectedCommitOid = null;
    this.diffResult = null;
    this.error = null;
    this.render();
    this.loadData();
  }
}
