import { describe, it, expect, vi } from 'vitest';
import { makeContext, seedClientOrgUser } from './helpers.js';
import { GithubService, buildTreeEntries } from '../src/github/service.js';

/** The Git Data API calls `commit()` makes, recorded rather than sent. */
function stubOctokit() {
  const blobs: { content: string; encoding: string }[] = [];
  const trees: any[] = [];
  const git = {
    getRef: vi.fn(async () => ({ data: { object: { sha: 'head1' } } })),
    createRef: vi.fn(),
    getCommit: vi.fn(async () => ({ data: { tree: { sha: 'tree0' } } })),
    createBlob: vi.fn(async (args: { content: string; encoding: string }) => {
      blobs.push(args);
      return { data: { sha: `blob${blobs.length}` } };
    }),
    createTree: vi.fn(async (args: any) => {
      trees.push(args);
      return { data: { sha: 'tree1' } };
    }),
    createCommit: vi.fn(async () => ({ data: { sha: 'commit1', html_url: 'https://github.com/o/r/commit/commit1' } })),
    updateRef: vi.fn(async () => ({})),
  };
  return { git, blobs, trees };
}

describe('buildTreeEntries', () => {
  it('turns a null content into a removal entry and everything else into a blob', async () => {
    const tree = await buildTreeEntries(
      [
        { path: 'a.txt', content: 'A' },
        { path: 'gone.txt', content: null },
      ],
      async (f) => `sha-of-${f.path}`,
    );
    expect(tree).toEqual([
      { path: 'a.txt', mode: '100644', type: 'blob', sha: 'sha-of-a.txt' },
      // `sha: null` on a base_tree entry is how the Git Data API deletes a path.
      { path: 'gone.txt', mode: '100644', type: 'blob', sha: null },
    ]);
  });
});

describe('GithubService.commit', () => {
  it('accepts the environment token when a configured repository has no stored token', async () => {
    const ctx = makeContext();
    const { client } = await seedClientOrgUser(ctx);
    ctx.repos.github.upsert(client.id, {
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      sourceRoot: 'force-app/main/default',
      docsRoot: 'docs',
      commitStrategy: 'direct',
      branchPrefix: 'sf-claws/',
    });
    const gh = new GithubService(ctx.repos, ctx.secrets, ctx.log, 'github_pat_from_env');

    expect(gh.hasToken(client.id)).toBe(true);
    expect(gh.repoFor(client.id).tokenEnc).toBeNull();
    expect(await (gh as any).client(gh.repoFor(client.id)).auth()).toMatchObject({ token: 'github_pat_from_env' });

    ctx.repos.github.upsert(client.id, {
      ...gh.repoFor(client.id),
      tokenEnc: ctx.secrets.encrypt('ghp_override'),
    });
    expect(await (gh as any).client(gh.repoFor(client.id)).auth()).toMatchObject({ token: 'ghp_override' });
    ctx.db.close();
  });

  it('deletes paths and uploads binary content byte-exact in one commit', async () => {
    const ctx = makeContext();
    const { client } = await seedClientOrgUser(ctx);
    ctx.repos.github.upsert(client.id, {
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      sourceRoot: 'force-app/main/default',
      docsRoot: 'docs',
      commitStrategy: 'direct',
      branchPrefix: 'sf-claws/',
      tokenEnc: ctx.secrets.encrypt('ghp_test'),
    });
    const stub = stubOctokit();
    const gh = new GithubService(ctx.repos, ctx.secrets, ctx.log, '', () => stub as any);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);

    const r = await gh.commit(
      client.id,
      'main',
      [
        { path: 'force-app/main/default/classes/Foo.cls', content: 'public class Foo {}' },
        { path: 'force-app/main/default/staticresources/Logo.png', content: png.toString('base64'), encoding: 'base64' },
        { path: 'force-app/main/default/classes/Dead.cls', content: null },
        { path: 'force-app/main/default/classes/Dead.cls-meta.xml', content: null },
      ],
      'Remove Dead, add Foo',
      { name: 'Dev', email: 'dev@example.com' },
    );

    expect(r).toEqual({ sha: 'commit1', url: 'https://github.com/o/r/commit/commit1', filesChanged: 4 });
    // Two blobs: deletions never upload anything.
    expect(stub.blobs).toHaveLength(2);
    expect(Buffer.from(stub.blobs[0].content, 'base64').toString('utf8')).toBe('public class Foo {}');
    expect(Buffer.compare(Buffer.from(stub.blobs[1].content, 'base64'), png)).toBe(0);
    // The tree is built on the branch head so untouched files survive, and deletions carry sha: null.
    expect(stub.trees[0].base_tree).toBe('tree0');
    expect(stub.trees[0].tree).toEqual([
      { path: 'force-app/main/default/classes/Foo.cls', mode: '100644', type: 'blob', sha: 'blob1' },
      { path: 'force-app/main/default/staticresources/Logo.png', mode: '100644', type: 'blob', sha: 'blob2' },
      { path: 'force-app/main/default/classes/Dead.cls', mode: '100644', type: 'blob', sha: null },
      { path: 'force-app/main/default/classes/Dead.cls-meta.xml', mode: '100644', type: 'blob', sha: null },
    ]);
    expect(stub.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ message: 'Remove Dead, add Foo', parents: ['head1'], tree: 'tree1' }));
    expect(stub.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/main', sha: 'commit1', force: false }));
  });

  it('seeds an empty repository before the first commit', async () => {
    const ctx = makeContext();
    const { client } = await seedClientOrgUser(ctx);
    ctx.repos.github.upsert(client.id, {
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      sourceRoot: 'force-app/main/default',
      docsRoot: 'docs',
      commitStrategy: 'direct',
      branchPrefix: 'sf-claws/',
      tokenEnc: ctx.secrets.encrypt('ghp_test'),
    });
    const stub = stubOctokit();
    const empty = Object.assign(new Error('Git Repository is empty.'), { status: 409 });
    let seeded = false;
    stub.git.getRef.mockImplementation(async () => {
      if (!seeded) throw empty;
      return { data: { object: { sha: 'head1' } } };
    });
    const repos = {
      createOrUpdateFileContents: vi.fn(async () => {
        seeded = true;
        return {};
      }),
    };
    const gh = new GithubService(ctx.repos, ctx.secrets, ctx.log, '', () => ({ ...stub, repos }) as any);

    expect(await gh.treeShas(client.id, 'main', 'force-app/')).toBeNull();
    const r = await gh.commit(client.id, 'main', [{ path: 'a.txt', content: 'A' }], 'Pull org', { name: 'Dev', email: 'dev@example.com' });

    expect(repos.createOrUpdateFileContents).toHaveBeenCalledWith(expect.objectContaining({ path: 'README.md', branch: 'main' }));
    expect(r.sha).toBe('commit1');
    ctx.db.close();
  });
});
