# @keydown-dev/ts-git

Pure TypeScript Git with pluggable filesystems and smart-HTTP remotes. Runs in
the browser, Node.js, Tauri, or anywhere else you can provide a filesystem
adapter.

> **Alpha:** this is an early pre-release. APIs may change between alpha
> versions without notice, and not every Git feature is implemented yet. Pin
> an exact version if you depend on it.

## Install

```bash
npm install @keydown-dev/ts-git@alpha
```

The package is **ESM-only** (`"type": "module"`, no CommonJS build). Use
`import`, or `require()` on a Node version that supports loading ES modules.
It needs a runtime with `fetch`, `TextEncoder`/`TextDecoder` and Web Crypto
(`crypto.subtle`): modern browsers or Node.js 20+.
TypeScript users need the `DOM` lib or `@types/node` for the `fetch` type.

## Usage

```typescript
import { GitClient, MemoryFS } from '@keydown-dev/ts-git';

// Any FSAdapter works; MemoryFS keeps everything in memory.
const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo' });

await git.init({ defaultBranch: 'main' });

await fs.writeFile('/my-repo/README.md', '# Hello\n');
await git.add('README.md');
const oid = await git.commit('Initial commit', {
  name: 'Jane Doe',
  email: 'jane@example.com',
});

const commits = await git.log();
```

### Remotes

Clone, fetch, pull and push over smart HTTP(S) using `fetch`. In browsers,
point `corsProxy` at a CORS proxy.

```typescript
const git = new GitClient({
  fs,
  dir: '/project',
  remote: {
    corsProxy: 'https://cors.isomorphic-git.org', // browsers only
    onAuth: () => ({ username: 'x-access-token', password: token }),
  },
});

await git.clone('https://github.com/keydown-dev/ts-git.git');
await git.pull();
await git.push({ setUpstream: true });
```

### Filesystem adapters

`GitClient` works against the `FSAdapter` interface, exported as a type.
`MemoryFS` ships with the package; implement `FSAdapter` yourself to back a
repository with IndexedDB, the File System Access API, Tauri, ZenFS or a
native filesystem. The
[examples](https://github.com/keydown-dev/ts-git/tree/master/examples) in the
repository show several adapters.

### Embedded command line: `@keydown-dev/ts-git/cli`

A second entry point parses and runs `git ...` command strings, which is
useful for an in-app terminal:

```typescript
import { CommandParser } from '@keydown-dev/ts-git/cli';

const parser = new CommandParser();
const result = await parser.execute('git status', {
  currentDir: '/my-repo',
  fs,
  git,
  author: { name: 'Jane Doe', email: 'jane@example.com' },
});
console.log(result.output);
```

Help text and prompts can be overridden with `CommandContext.copy`.

## Supported commands

- **Porcelain:** `init`, `add` (honours `.gitignore`), `rm --cached`,
  `commit`, `status`, `log`, `branch`, `checkout`, `reset`
  (`--soft`/`--mixed`/`--hard`), `diff` (`--cached`, `--name-only`,
  `--name-status`, `--stat`), `merge` (fast-forward and three-way, with
  conflict state and `--abort`).
- **Remotes:** `clone`, `remote`, `fetch`, `pull`, `push`.
- **Plumbing:** `cat-file`, `hash-object`, `ls-tree`, `update-index`.

Not yet supported: `tag`, `rebase`, `cherry-pick`, `stash`, `config`, `show`,
rename detection in `diff`, and index version 4. See the
[repository README](https://github.com/keydown-dev/ts-git#readme) for the full
list and known limitations.

Line diffs are pluggable: pass a `LineDiffAlgorithm` as `lineDiffAlgorithm`
in the `GitClient` options or per `diff()` call.

## License

[MIT](./LICENSE) © 2026 Edward Mowle
