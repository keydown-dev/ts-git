// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const GITHUB_URL = 'https://github.com/keydown-dev/ts-git';

/**
 * Sidebar groups are declared separately so new sections slot in cleanly.
 * Remote commands (remote, clone, fetch, push, pull, merge) live in the
 * "Remote" group between "Commands" and "Plumbing".
 */
const gettingStarted = {
  label: 'Getting Started',
  items: [
    { label: 'Introduction', slug: 'getting-started/introduction' },
    { label: 'Installation', slug: 'getting-started/installation' },
    { label: 'Quick Start', slug: 'getting-started/quickstart' },
  ],
};

const concepts = {
  label: 'Concepts',
  items: [
    { label: 'How TS-Git Works', slug: 'concepts/architecture' },
    { label: 'GitClient', slug: 'concepts/git-client' },
  ],
};

const commands = {
  label: 'Commands',
  items: [
    { label: 'init', slug: 'commands/init' },
    { label: 'add', slug: 'commands/add' },
    { label: 'remove', slug: 'commands/remove' },
    { label: 'commit', slug: 'commands/commit' },
    { label: 'status', slug: 'commands/status' },
    { label: 'log', slug: 'commands/log' },
    { label: 'branch', slug: 'commands/branch' },
    { label: 'checkout', slug: 'commands/checkout' },
    { label: 'reset', slug: 'commands/reset' },
    { label: 'diff', slug: 'commands/diff' },
  ],
};

const remoteCommands = {
  label: 'Remote',
  items: [
    { label: 'Working with remotes', slug: 'remote/overview' },
    { label: 'clone', slug: 'remote/clone' },
    { label: 'remote', slug: 'remote/remote' },
    { label: 'fetch', slug: 'remote/fetch' },
    { label: 'push', slug: 'remote/push' },
    { label: 'pull', slug: 'remote/pull' },
    { label: 'merge', slug: 'remote/merge' },
  ],
};

const plumbing = {
  label: 'Plumbing',
  items: [
    { label: 'cat-file', slug: 'plumbing/cat-file' },
    { label: 'hash-object', slug: 'plumbing/hash-object' },
    { label: 'ls-tree', slug: 'plumbing/ls-tree' },
    { label: 'update-index', slug: 'plumbing/update-index' },
  ],
};

const filesystem = {
  label: 'Filesystem Adapters',
  items: [
    { label: 'Overview', slug: 'filesystem/overview' },
    { label: 'MemoryFS', slug: 'filesystem/memory' },
    { label: 'NodeFSAdapter', slug: 'filesystem/node' },
    { label: 'Creating Custom Adapters', slug: 'filesystem/custom' },
  ],
};

const cli = {
  label: 'CLI',
  items: [{ label: 'CommandParser', slug: 'cli/command-parser' }],
};

const project = {
  label: 'Project',
  items: [{ label: 'Roadmap & Limitations', slug: 'roadmap' }],
};

// https://astro.build/config
export default defineConfig({
  site: 'https://tsgit.keydown.app',
  output: 'static',
  integrations: [
    starlight({
      title: 'TS-Git',
      description:
        'A pure TypeScript Git implementation with pluggable filesystem adapters, for browsers and Node.js.',
      favicon: '/favicon.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: GITHUB_URL,
        },
      ],
      editLink: {
        baseUrl: `${GITHUB_URL}/edit/master/docs/`,
      },
      logo: {
        src: './public/icon.svg',
      },
      customCss: ['./src/styles/custom.css'],
      components: {
        Sidebar: './src/components/Sidebar.astro',
        Hero: './src/components/Hero.astro',
      },
      sidebar: [
        gettingStarted,
        concepts,
        commands,
        remoteCommands,
        plumbing,
        filesystem,
        cli,
        project,
      ],
    }),
  ],
});
