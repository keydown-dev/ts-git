/**
 * Default strings for the embedded CLI / demo terminal. Host apps override via `CommandContext.copy`.
 */
export interface EmbeddedCliCopy {
  noFolderSelectedPrompt?: string;
  unknownCommandHint?: string;
  fullHelpText?: string;
  gitHelpText?: string;
}

export const defaultEmbeddedCliCopy: Required<EmbeddedCliCopy> = {
  noFolderSelectedPrompt:
    'No folder selected. Please use the "Open Folder" button to select a folder first.',
  unknownCommandHint: "Type 'help' for available commands.",
  fullHelpText: `Available commands:

Git Commands (use 'git <command>' or just '<command>'):
  git init [branch]       - Initialize git repository (default: master)
  git add <file>          - Stage file
  git add -A              - Stage all changes
  git rm <file>           - Remove file from index
  git commit -m "<msg>"   - Create commit
  git status              - Show working tree status
  git log                 - Show commit history
  git branch [name]       - List branches or create new branch
  git branch -d <branch>  - Delete branch
  git branch -D <branch>  - Force delete branch
  git checkout <branch>   - Switch to branch
  git reset [file]        - Unstage file(s) (restore index from HEAD)
  git diff [<options>]    - Show changes between commits, index, and worktree
  git merge <commit>      - Merge into the current branch (--ff-only, --no-ff, --abort)
  git tag                 - Manage tags (NOT IMPLEMENTED)

Remote Commands:
  git clone <url> [dir]   - Clone a repository (-b <branch>, --single-branch)
  git remote [-v]         - List remotes (add, remove, set-url, get-url)
  git fetch [remote]      - Download objects and refs (--prune, --tags)
  git pull [remote] [br]  - Fetch and merge the upstream branch (--ff-only)
  git push [remote] [ref] - Update remote refs (-u, --force, --delete, --tags)

Diff Options:
  --cached, --staged      - Show staged changes (index vs HEAD)
  --name-only             - Show only names of changed files
  --name-status           - Show names and status of changed files
  --stat                  - Show diffstat summary
  <commit>                - Compare worktree to a commit
  <commit>..<commit>        - Compare two commits
  <commit>...<commit>     - Compare since the merge base
  -- <path>...            - Limit diff to specific paths

File Commands:
  cd [path]               - Change directory (cd alone goes to root)
  pwd                     - Print current working directory
  rename <old> <new>      - Rename file/directory
  delete <file>           - Delete file/directory
  edit <file>             - View file content
  mkdir <directory>       - Create directory
  touch <file>            - Create empty file or update timestamp
  ls [path]               - List directory contents
  cat <file>              - Display file content

Other:
  clear                   - Clear terminal output
  help                    - Show this help message`,
  gitHelpText: `usage: git <command> [<args>]

These are the common Git commands:

Start a working area
  init [branch]           - Initialize git repository (default: master)

Work on the current change
  add <file>              - Stage file for commit
  add -A                  - Stage all changes
  rm <file>               - Remove file from index (git rm)
  status                  - Show working tree status
  commit -m "<msg>"       - Create commit
  reset [file]            - Unstage file(s)

View commit history
  log                     - Show commit history
  diff [<options>] [<commit>] [--] [<path>...]
                          - Show changes between commits, index, and worktree

Branching and merging
  branch [name]           - List branches or create new branch
  branch -d <branch>      - Delete branch
  branch -D <branch>      - Force delete branch
  checkout <branch>       - Switch to branch
  merge <commit>          - Join another branch into the current one

Collaborate
  clone <url> [dir]       - Clone a repository into a new directory
  remote [-v]             - Manage tracked repositories
  fetch [remote]          - Download objects and refs from a remote
  pull [remote] [branch]  - Fetch and integrate with another repository
  push [remote] [refspec] - Update remote refs along with their objects

Diff Options:
  --cached, --staged      - Show staged changes (index vs HEAD)
  --name-only             - Show only names of changed files
  --name-status           - Show names and status (A/M/D) of changed files
  --stat                  - Show diffstat summary

Tagging (NOT IMPLEMENTED)
  tag                     - List, create, or delete tags

See 'help' for all available commands`,
};
