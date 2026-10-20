import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFS } from '../../fs/memory-adapter.js';
import { init } from '../../commands/init.js';
import { add } from '../../commands/add.js';
import { commit } from '../../commands/commit.js';
import {
  addRemote,
  listRemotes,
  removeRemote,
  setRemoteUrl,
} from '../../commands/remote.js';
import { fetch } from '../../commands/fetch.js';
import { push } from '../../commands/push.js';
import { LocalTransport } from '../../remote/transport.js';
import { listRefs, resolveRefOid, writeRef } from '../../core/refs.js';
import { readObject } from '../../core/objects.js';
import {
  PushRejectedError,
  RemoteNotFoundError,
  AlreadyExistsError,
} from '../../errors.js';

const author = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1700000000,
  timezoneOffset: 0,
};

async function commitFile(
  fs: MemoryFS,
  dir: string,
  path: string,
  content: string,
  message: string,
) {
  await fs.writeFile(`${dir}/${path}`, content);
  await add({ fs, dir, filepath: path });
  return commit({
    fs,
    dir,
    message,
    author: { ...author, timestamp: author.timestamp++ },
  });
}

async function makeBare(fs: MemoryFS, path: string) {
  await fs.mkdir(`${path}/objects`, { recursive: true });
  await fs.mkdir(`${path}/refs/heads`, { recursive: true });
  await fs.writeFile(`${path}/HEAD`, 'ref: refs/heads/main\n');
  await fs.writeFile(`${path}/config`, '[core]\n\tbare = true\n');
}

describe('remote config', () => {
  let fs: MemoryFS;
  beforeEach(async () => {
    fs = new MemoryFS();
    await init({ fs, dir: '/repo', defaultBranch: 'main' });
  });

  it('adds, lists, updates and removes remotes', async () => {
    await addRemote({
      fs,
      dir: '/repo',
      name: 'origin',
      url: 'https://example.com/a.git',
    });
    await addRemote({
      fs,
      dir: '/repo',
      name: 'upstream',
      url: '/srv/b',
      fetch: [
        '+refs/heads/main:refs/remotes/upstream/main',
        '+refs/tags/*:refs/tags/*',
      ],
    });
    await expect(
      addRemote({ fs, dir: '/repo', name: 'origin', url: 'x' }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);

    await setRemoteUrl({
      fs,
      dir: '/repo',
      name: 'origin',
      url: 'https://example.com/push.git',
      push: true,
    });
    expect(await listRemotes({ fs, dir: '/repo' })).toEqual([
      {
        name: 'origin',
        url: 'https://example.com/a.git',
        pushUrl: 'https://example.com/push.git',
        fetch: ['+refs/heads/*:refs/remotes/origin/*'],
      },
      {
        name: 'upstream',
        url: '/srv/b',
        fetch: [
          '+refs/heads/main:refs/remotes/upstream/main',
          '+refs/tags/*:refs/tags/*',
        ],
      },
    ]);
    const config = await fs.readFileString('/repo/.git/config');
    expect(config).toContain('[remote "upstream"]');
    expect(config.match(/fetch = /g)).toHaveLength(3);

    await writeRef(
      fs,
      '/repo/.git',
      'refs/remotes/upstream/main',
      'a'.repeat(40),
      true,
    );
    await removeRemote({ fs, dir: '/repo', name: 'upstream' });
    expect(
      (await listRemotes({ fs, dir: '/repo' })).map((r) => r.name),
    ).toEqual(['origin']);
    expect((await listRefs(fs, '/repo/.git', 'refs/remotes/')).size).toBe(0);
    await expect(
      removeRemote({ fs, dir: '/repo', name: 'nope' }),
    ).rejects.toBeInstanceOf(RemoteNotFoundError);
  });
});

describe('local transport (FSAdapter remotes)', () => {
  let fs: MemoryFS;

  beforeEach(async () => {
    fs = new MemoryFS();
    await init({ fs, dir: '/server', defaultBranch: 'main' });
    await commitFile(fs, '/server', 'a.txt', 'one\n', 'first');
    await commitFile(fs, '/server', 'b.txt', 'two\n', 'second');
    await init({ fs, dir: '/client', defaultBranch: 'main' });
    await addRemote({ fs, dir: '/client', name: 'origin', url: '/server' });
  });

  it('fetches from a path on the same filesystem', async () => {
    const result = await fetch({ fs, dir: '/client' });
    expect(result.remoteHead).toBe('refs/heads/main');
    const serverHead = await resolveRefOid(
      fs,
      '/server/.git',
      'refs/heads/main',
    );
    expect(
      await resolveRefOid(fs, '/client/.git', 'refs/remotes/origin/main'),
    ).toBe(serverHead);
    const obj = await readObject(fs, '/client/.git', serverHead!);
    expect(obj.type).toBe('commit');
    expect(result.objectCount).toBe(6); // 2 commits, 2 trees, 2 blobs
  });

  it('prunes only refs that no refspec still maps (e.g. PR refs)', async () => {
    const head = await resolveRefOid(fs, '/server/.git', 'refs/heads/main');
    await writeRef(fs, '/server/.git', 'refs/pull/5/head', head!, true);
    await writeRef(fs, '/server/.git', 'refs/heads/gone', head!, true);
    await addRemote({
      fs,
      dir: '/client',
      name: 'origin',
      url: '/server',
      force: true,
      fetch: [
        '+refs/heads/*:refs/remotes/origin/*',
        '+refs/pull/*/head:refs/remotes/origin/pr/*',
      ],
    });
    await fetch({ fs, dir: '/client' });
    const { deleteRef } = await import('../../core/refs.js');
    await deleteRef(fs, '/server/.git', 'refs/heads/gone');

    const result = await fetch({ fs, dir: '/client', prune: true });
    expect(
      result.updates
        .filter((u) => u.status === 'pruned')
        .map((u) => u.localRef),
    ).toEqual(['refs/remotes/origin/gone']);
    expect([
      ...(await listRefs(fs, '/client/.git', 'refs/remotes/')).keys(),
    ]).toEqual(['refs/remotes/origin/main', 'refs/remotes/origin/pr/5']);
  });

  it('fetches from a repository on a different FSAdapter', async () => {
    const other = new MemoryFS();
    await init({ fs: other, dir: '/elsewhere', defaultBranch: 'main' });
    const head = await commitFile(
      other,
      '/elsewhere',
      'x.txt',
      'x\n',
      'remote commit',
    );
    const transport = new LocalTransport({
      fs: other,
      path: '/elsewhere',
      url: 'mem://elsewhere',
    });
    const result = await fetch({
      fs,
      dir: '/client',
      remote: 'mem://elsewhere',
      transport,
    });
    expect(result.fetchHead).toEqual([
      { oid: head, remoteRef: 'HEAD', notForMerge: false },
    ]);
    expect((await readObject(fs, '/client/.git', head)).type).toBe('commit');
  });

  it('pushes to a bare repository and refuses the checked-out branch of a non-bare one', async () => {
    await fetch({ fs, dir: '/client' });
    const base = await resolveRefOid(
      fs,
      '/client/.git',
      'refs/remotes/origin/main',
    );
    await writeRef(fs, '/client/.git', 'refs/heads/main', base!, true);
    // Materialise files so further commits build on origin/main's tree.
    await fs.writeFile('/client/a.txt', 'one\n');
    await fs.writeFile('/client/b.txt', 'two\n');
    await add({ fs, dir: '/client', filepath: ['a.txt', 'b.txt'] });
    const head = await commitFile(fs, '/client', 'c.txt', 'three\n', 'third');

    const err = await push({ fs, dir: '/client', refspecs: ['main'] }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PushRejectedError);
    expect((err as PushRejectedError).refs[0]).toMatchObject({
      status: 'remote-rejected',
      reason: 'branch is currently checked out',
    });

    // Pushing to another branch of the non-bare repo is fine.
    const ok = await push({ fs, dir: '/client', refspecs: ['main:incoming'] });
    expect(ok.refs[0].status).toBe('new');
    expect(await resolveRefOid(fs, '/server/.git', 'refs/heads/incoming')).toBe(
      head,
    );
    expect((await readObject(fs, '/server/.git', head)).type).toBe('commit');

    // Bare repository: the current branch can be updated.
    await makeBare(fs, '/bare.git');
    await addRemote({ fs, dir: '/client', name: 'bare', url: '/bare.git' });
    const pushed = await push({
      fs,
      dir: '/client',
      remote: 'bare',
      refspecs: ['main'],
    });
    expect(pushed.refs[0].status).toBe('new');
    expect(await resolveRefOid(fs, '/bare.git', 'refs/heads/main')).toBe(head);
    expect(
      await resolveRefOid(fs, '/client/.git', 'refs/remotes/bare/main'),
    ).toBe(head);
  });

  it('refuses atomic pushes the remote cannot honour', async () => {
    const hub = new LocalTransport({
      fs,
      path: '/server',
      url: 'mem://server',
    });
    const noAtomic: typeof hub = Object.create(hub);
    noAtomic.listRefs = async (service) => {
      const adv = await hub.listRefs(service);
      adv.capabilities.delete('atomic');
      return adv;
    };
    await expect(
      push({
        fs,
        dir: '/client',
        remote: 'mem://server',
        transport: noAtomic,
        refspecs: ['main:x'],
        atomic: true,
      }),
    ).rejects.toThrow(/does not support --atomic/);
  });

  it('never reports credentials embedded in the remote URL', async () => {
    const secretUrl = 'https://alice:s3cret-token@example.com/repo.git';
    await addRemote({ fs, dir: '/client', name: 'secret', url: secretUrl });
    const transport = new LocalTransport({
      fs,
      path: '/server',
      url: secretUrl,
    });
    const fetched = await fetch({
      fs,
      dir: '/client',
      remote: 'secret',
      transport,
    });
    expect(fetched.url).toBe('https://example.com/repo.git');
    // Diverge so the push is rejected, then inspect what gets reported.
    const serverHead = await resolveRefOid(
      fs,
      '/server/.git',
      'refs/heads/main',
    );
    await writeRef(fs, '/client/.git', 'refs/heads/main', serverHead!, true);
    await commitFile(fs, '/server', 'z.txt', 'z\n', 'server moves on');
    await commitFile(fs, '/client', 'y.txt', 'y\n', 'client commit');
    const err = await push({
      fs,
      dir: '/client',
      remote: 'secret',
      transport,
      refspecs: ['main:other'],
    })
      .then(() =>
        push({
          fs,
          dir: '/client',
          remote: 'secret',
          transport,
          refspecs: ['main'],
        }),
      )
      .catch((e) => e);
    expect(String(err.message)).not.toContain('s3cret');
    expect(String(err.message)).toContain('https://example.com/repo.git');
  });

  it('round-trips: push from one clone, fetch into another', async () => {
    const bareFs = new MemoryFS();
    await makeBare(bareFs, '/hub');
    const hub = new LocalTransport({
      fs: bareFs,
      path: '/hub',
      url: 'mem://hub',
    });

    await addRemote({ fs, dir: '/server', name: 'hub', url: 'mem://hub' });
    await push({
      fs,
      dir: '/server',
      remote: 'hub',
      transport: hub,
      refspecs: ['main'],
    });

    await init({ fs, dir: '/third', defaultBranch: 'main' });
    await addRemote({ fs, dir: '/third', name: 'hub', url: 'mem://hub' });
    await fetch({ fs, dir: '/third', remote: 'hub', transport: hub });
    expect(
      await resolveRefOid(fs, '/third/.git', 'refs/remotes/hub/main'),
    ).toBe(await resolveRefOid(fs, '/server/.git', 'refs/heads/main'));

    // Second push only needs the new objects.
    await commitFile(fs, '/server', 'a.txt', 'changed\n', 'third');
    let packObjects = -1;
    const counting: typeof hub = Object.create(hub);
    counting.pushPack = async (adv, req) => {
      const { indexPackfile } = await import('../../core/pack-builder.js');
      packObjects = req.packfile
        ? (await indexPackfile(req.packfile)).objects.length
        : 0;
      return hub.pushPack(adv, req);
    };
    const res = await push({
      fs,
      dir: '/server',
      remote: 'hub',
      transport: counting,
      refspecs: ['main'],
    });
    expect(res.refs[0].status).toBe('fast-forward');
    expect(packObjects).toBe(3);
  });
});

describe('GitClient remote workflow (in memory)', () => {
  it('clones, commits, pushes and pulls between two clients', async () => {
    const { GitClient } = await import('../../client/index.js');
    const fs = new MemoryFS();
    await init({ fs, dir: '/seed', defaultBranch: 'main' });
    await commitFile(fs, '/seed', 'README.md', 'hello\n', 'seed');
    // A bare hub everyone pushes to.
    await makeBare(fs, '/hub.git');
    await addRemote({ fs, dir: '/seed', name: 'origin', url: '/hub.git' });
    await push({ fs, dir: '/seed', refspecs: ['main'] });

    const alice = new GitClient({ fs, dir: '/alice' });
    const bob = new GitClient({ fs, dir: '/bob' });
    expect((await alice.clone('/hub.git')).branch).toBe('main');
    await bob.clone('/hub.git');
    expect(await fs.readFileString('/alice/README.md')).toBe('hello\n');

    await fs.writeFile('/alice/notes.txt', 'from alice\n');
    await alice.add('notes.txt');
    await alice.commit('alice: notes', author);
    const pushed = await alice.push();
    expect(pushed.refs[0].status).toBe('fast-forward');

    const pulled = await bob.pull();
    expect(pulled.merge.type).toBe('fast-forward');
    expect(await fs.readFileString('/bob/notes.txt')).toBe('from alice\n');
    expect((await bob.listRemotes()).map((r) => r.url)).toEqual(['/hub.git']);
  });
});
