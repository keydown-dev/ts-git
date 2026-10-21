import { createMemoryFS, GitClient, type Author } from '@keydown-dev/ts-git';
import { App } from '@ts-git/ui';

const WORKING_DIR = '/workspace';
const GIT_DIR = '/workspace/.git';

const fs = createMemoryFS();
await fs.mkdir(WORKING_DIR, { recursive: true });

const author: Author = {
  name: 'Demo User',
  email: 'demo@example.com',
};

const git = new GitClient({
  fs,
  dir: WORKING_DIR,
  gitdir: GIT_DIR,
  defaultBranch: 'master',
});

const WELCOME_MESSAGE = `\
Welcome to TS-Git!
Current directory: ${WORKING_DIR}
Type "help" for available commands.
`;

async function main() {
  const appContainer = document.getElementById('app');
  if (!appContainer) return;

  new App({
    container: appContainer,
    fs,
    git,
    author,
    currentDir: WORKING_DIR,
    gitdir: GIT_DIR,
    welcomeMessage: WELCOME_MESSAGE,
  });
}

main();
