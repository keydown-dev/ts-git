# TS-Git Browser

A browser-based Git client using the File System Access API. This example demonstrates how to use the `@ts-git/ui` components with a real file system backend that allows users to open and work with local folders from their computer.

## Features

- 📁 **Open Local Folders** - Select any folder from your local file system using the File System Access API
- 🔀 **Git Operations** - Full git support including init, add, commit, status, log, branch, and checkout
- 💻 **Terminal Interface** - Built-in terminal for executing git and file commands
- 📊 **Visual Git Status** - File tree with color-coded git status indicators
- 🌐 **PWA Support** - Works as a Progressive Web App for offline use

## How It Works

The app uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) to let users select a folder from their local file system. Once selected, the app:

1. Creates a `FileSystemAccessAdapter` that implements the `FSAdapter` interface from `ts-git`
2. Checks if the folder is already a git repository (by looking for `.git` directory)
3. Renders the UI components from `@ts-git/ui` using the adapter
4. Allows users to perform git operations and file management

## Browser Compatibility

This app requires a browser that supports the File System Access API:

- Chrome 86+
- Edge 86+
- Opera 72+

**Note:** Firefox and Safari do not currently support the File System Access API.

## Getting Started

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build
```

## Usage

1. Open the app in a compatible browser
2. Click "Select Folder" to choose a folder from your local file system
3. Grant permission to access the folder when prompted
4. The app will display the folder contents in the file tree
5. Use the terminal to execute git commands
6. If the folder is already a git repository, git status will be displayed automatically

### Available Commands

**Git Commands:**

- `init [branch]` - Initialize a git repository
- `add <file>` - Stage a file
- `add -A` - Stage all changes
- `commit -m "<message>"` - Create a commit
- `status` - Show working tree status
- `log` - Show commit history
- `branch [name]` - List or create branches
- `checkout <branch>` - Switch branches

**File Commands:**

- `ls [path]` - List directory contents
- `cat <file>` - Display file content
- `mkdir <directory>` - Create a directory
- `touch <file>` - Create an empty file
- `rename <old> <new>` - Rename a file
- `delete <file>` - Delete a file

## Architecture

### FileSystemAccessAdapter

The `FileSystemAccessAdapter` class implements the `FSAdapter` interface from `ts-git` using the File System Access API. It wraps a `FileSystemDirectoryHandle` and provides methods for:

- Reading and writing files
- Creating directories
- Listing directory contents
- Getting file stats
- Renaming and deleting files

### GitOperations

The `GitOperations` class provides a high-level interface to git operations using the `ts-git` library. It works with any `FSAdapter` implementation.

### UI Components

The app uses components from `@ts-git/ui`:

- `Sidebar` - Explorer / Changes / History tab strip and panels (wraps `FileTree`, `FileChanges`, `FileHistory`)
- `FileTree` - Folder structure with git status (used inside the sidebar)
- `Terminal` - Command-line interface

## Security & Privacy

- All files stay on your computer - nothing is uploaded to any server
- The app only has access to the specific folder you select
- Permissions are requested each time you open a folder
- Works entirely in the browser with no backend server required

## Development

### Project Structure

```
src/
├── App.ts                      # Main application logic
├── main.ts                     # Entry point
├── lib/
│   ├── FileSystemAccessAdapter.ts  # FS adapter implementation
│   └── gitOperations.ts        # Git operations wrapper
└── styles/
    └── main.css               # Application styles
```

The shared `@ts-git/ui` **App** wires the embedded terminal to `@keydown-app/ts-git/cli` (`CommandParser`); this example only supplies `fs`, `git`, `author`, and folder UI callbacks.

### Adding New Commands

Implement or extend commands in `packages/ts-git/src/cli/commandParser.ts` (and optional copy in `embeddedCopy.ts`), then rebuild `@keydown-app/ts-git`.

## License

MIT
