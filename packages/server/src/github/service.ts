import { Octokit } from '@octokit/rest';
import type { Repos, GithubRepoRow } from '../db/repos/index.js';
import type { SecretBox } from '../lib/crypto.js';
import type { Logger } from '../logger.js';
import { HttpError } from '../lib/errors.js';
import { inferComponentFromPath, type FileDiff, type CompareResponse } from '@sf-claws/shared';

export interface CommitFile {
  path: string;
  /** File text, or `null` to delete the path from the tree in this commit. */
  content: string | null;
  /** How `content` encodes the bytes; `base64` for binary metadata (static resource images, documents). */
  encoding?: 'utf8' | 'base64';
}

/**
 * GitHub integration per client. Uses the Git Data API to create commits without cloning,
 * which keeps the server stateless with respect to repositories.
 */
export class GithubService {
  constructor(
    private repos: Repos,
    private secrets: SecretBox,
    private log: Logger,
    private defaultToken = '',
    /** Test seam: replaces the Octokit factory. */
    private clientFactory?: (repo: GithubRepoRow) => Octokit,
  ) {}

  hasToken(clientId: string): boolean {
    const r = this.repos.github.byClient(clientId);
    return !!r && (!!r.tokenEnc || !!this.defaultToken.trim());
  }

  repoFor(clientId: string): GithubRepoRow {
    const r = this.repos.github.byClient(clientId);
    if (!r) throw new HttpError(409, 'GITHUB_NOT_CONFIGURED', 'No GitHub repository configured for this client');
    if (!r.tokenEnc && !this.defaultToken.trim()) throw new HttpError(409, 'GITHUB_NO_TOKEN', 'GitHub token missing for this client');
    return r;
  }
  private client(r: GithubRepoRow): Octokit {
    if (this.clientFactory) return this.clientFactory(r);
    const token = r.tokenEnc ? this.secrets.decrypt(r.tokenEnc) : this.defaultToken.trim();
    return new Octokit({ auth: token, userAgent: 'sf-claws', request: { timeout: 30_000 } });
  }

  async testConnection(clientId: string): Promise<{ ok: boolean; message: string; defaultBranch?: string; permissions?: unknown }> {
    const r = this.repoFor(clientId);
    try {
      const { data } = await this.client(r).repos.get({ owner: r.owner, repo: r.repo });
      return { ok: true, message: `Connected to ${data.full_name}`, defaultBranch: data.default_branch, permissions: data.permissions };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async branches(clientId: string): Promise<{ name: string; sha: string; protected: boolean }[]> {
    const r = this.repoFor(clientId);
    const gh = this.client(r);
    const out: { name: string; sha: string; protected: boolean }[] = [];
    for await (const page of gh.paginate.iterator(gh.repos.listBranches, { owner: r.owner, repo: r.repo, per_page: 100 })) {
      for (const b of page.data) out.push({ name: b.name, sha: b.commit.sha, protected: b.protected });
      if (out.length > 500) break;
    }
    return out.sort((a, b) => (a.name === r.defaultBranch ? -1 : b.name === r.defaultBranch ? 1 : a.name.localeCompare(b.name)));
  }

  async ensureBranch(clientId: string, branch: string, from?: string): Promise<{ created: boolean; sha: string }> {
    const r = this.repoFor(clientId);
    const gh = this.client(r);
    try {
      const { data } = await gh.git.getRef({ owner: r.owner, repo: r.repo, ref: `heads/${branch}` });
      return { created: false, sha: data.object.sha };
    } catch (e: any) {
      if (isEmptyRepo(e)) {
        // The Git Data API cannot write the first commit; the contents API can, and it creates the default branch.
        await gh.repos.createOrUpdateFileContents({
          owner: r.owner,
          repo: r.repo,
          path: 'README.md',
          message: 'Initial commit',
          content: Buffer.from(`# ${r.repo}\n`).toString('base64'),
          branch: r.defaultBranch,
        });
        this.log.info({ clientId }, 'Seeded empty GitHub repository');
        return this.ensureBranch(clientId, branch, from);
      }
      if (e.status !== 404) throw e;
    }
    const base = await gh.git.getRef({ owner: r.owner, repo: r.repo, ref: `heads/${from ?? r.defaultBranch}` });
    await gh.git.createRef({ owner: r.owner, repo: r.repo, ref: `refs/heads/${branch}`, sha: base.data.object.sha });
    return { created: true, sha: base.data.object.sha };
  }

  async getFile(clientId: string, path: string, ref?: string): Promise<{ content: string; sha: string } | null> {
    const r = this.repoFor(clientId);
    try {
      const { data } = await this.client(r).repos.getContent({ owner: r.owner, repo: r.repo, path, ref: ref ?? r.defaultBranch });
      if (Array.isArray(data) || data.type !== 'file') return null;
      return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
    } catch (e: any) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async listDir(clientId: string, path: string, ref?: string): Promise<{ name: string; path: string; type: string }[]> {
    const r = this.repoFor(clientId);
    try {
      const { data } = await this.client(r).repos.getContent({ owner: r.owner, repo: r.repo, path, ref: ref ?? r.defaultBranch });
      return Array.isArray(data) ? data.map((d) => ({ name: d.name, path: d.path, type: d.type })) : [];
    } catch (e: any) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  /**
   * Every blob under `prefix` on `branch` as path → blob sha, in one tree call; `null` when the
   * branch does not exist. GitHub truncates recursive trees past ~100k entries: reported loudly.
   */
  async treeShas(clientId: string, branch: string, prefix: string): Promise<Map<string, string> | null> {
    const r = this.repoFor(clientId);
    const gh = this.client(r);
    let head: string;
    try {
      head = (await gh.git.getRef({ owner: r.owner, repo: r.repo, ref: `heads/${branch}` })).data.object.sha;
    } catch (e: any) {
      if (e.status === 404 || isEmptyRepo(e)) return null;
      throw e;
    }
    const { data } = await gh.git.getTree({ owner: r.owner, repo: r.repo, tree_sha: head, recursive: 'true' });
    if (data.truncated) throw new HttpError(422, 'GITHUB_TREE_TRUNCATED', 'Repository tree is too large to compare in one request');
    const out = new Map<string, string>();
    for (const t of data.tree) if (t.type === 'blob' && t.path && t.sha && t.path.startsWith(prefix)) out.set(t.path, t.sha);
    return out;
  }

  async blob(clientId: string, sha: string): Promise<Buffer> {
    const r = this.repoFor(clientId);
    const { data } = await this.client(r).git.getBlob({ owner: r.owner, repo: r.repo, file_sha: sha });
    return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8');
  }

  /**
   * Create a single commit with many files on a branch (Git Data API).
   *
   * A file with `content: null` is deleted: the Git Data API removes a path from a tree built on
   * `base_tree` when its entry carries `sha: null`. Deleting a path that does not exist on the
   * branch is a 422 from GitHub, so callers delete only what the org actually had. Binary files
   * carry `encoding: 'base64'` and reach the blob byte-exact.
   */
  async commit(
    clientId: string,
    branch: string,
    files: CommitFile[],
    message: string,
    author: { name: string; email: string },
  ): Promise<{ sha: string; url: string; filesChanged: number }> {
    const r = this.repoFor(clientId);
    const gh = this.client(r);
    await this.ensureBranch(clientId, branch);
    const ref = await gh.git.getRef({ owner: r.owner, repo: r.repo, ref: `heads/${branch}` });
    const headSha = ref.data.object.sha;
    const headCommit = await gh.git.getCommit({ owner: r.owner, repo: r.repo, commit_sha: headSha });

    const tree = await buildTreeEntries(files, async (f) => {
      const blob = await gh.git.createBlob({
        owner: r.owner,
        repo: r.repo,
        content: Buffer.from(f.content!, f.encoding ?? 'utf8').toString('base64'),
        encoding: 'base64',
      });
      return blob.data.sha;
    });
    const newTree = await gh.git.createTree({ owner: r.owner, repo: r.repo, base_tree: headCommit.data.tree.sha, tree: tree as any });
    const commit = await gh.git.createCommit({
      owner: r.owner,
      repo: r.repo,
      message,
      tree: newTree.data.sha,
      parents: [headSha],
      author: { ...author, date: new Date().toISOString() },
    });
    await gh.git.updateRef({ owner: r.owner, repo: r.repo, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
    this.log.info({ clientId, branch, sha: commit.data.sha, files: files.length }, 'GitHub commit created');
    return { sha: commit.data.sha, url: commit.data.html_url, filesChanged: files.length };
  }

  async openPullRequest(clientId: string, head: string, title: string, body: string): Promise<{ url: string; number: number }> {
    const r = this.repoFor(clientId);
    const gh = this.client(r);
    const existing = await gh.pulls.list({ owner: r.owner, repo: r.repo, head: `${r.owner}:${head}`, base: r.defaultBranch, state: 'open' });
    if (existing.data[0]) return { url: existing.data[0].html_url, number: existing.data[0].number };
    const { data } = await gh.pulls.create({ owner: r.owner, repo: r.repo, head, base: r.defaultBranch, title, body });
    return { url: data.html_url, number: data.number };
  }

  async compare(clientId: string, base: string, head: string): Promise<CompareResponse> {
    const r = this.repoFor(clientId);
    const { data } = await this.client(r).repos.compareCommitsWithBasehead({ owner: r.owner, repo: r.repo, basehead: `${base}...${head}`, per_page: 250 });
    const files: FileDiff[] = (data.files ?? []).map((f) => {
      const rel = f.filename.startsWith(r.sourceRoot + '/') ? f.filename.slice(r.sourceRoot.length + 1) : null;
      const comp = rel ? inferComponentFromPath(rel) : null;
      return {
        path: f.filename,
        status: f.status === 'renamed' ? 'renamed' : f.status === 'removed' ? 'removed' : f.status === 'added' ? 'added' : 'modified',
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
        metadataType: comp?.metadataType ?? null,
        fullName: comp?.fullName ?? null,
      };
    });
    return { base, head, aheadBy: data.ahead_by, behindBy: data.behind_by, files, url: data.html_url };
  }

  async commits(clientId: string, branch?: string, limit = 30): Promise<{ sha: string; message: string; author: string; date: string; url: string }[]> {
    const r = this.repoFor(clientId);
    const { data } = await this.client(r).repos.listCommits({ owner: r.owner, repo: r.repo, sha: branch ?? r.defaultBranch, per_page: Math.min(limit, 100) });
    return data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
      date: c.commit.author?.date ?? '',
      url: c.html_url,
    }));
  }
}

export interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  /** A blob sha, or `null` to remove the path from the base tree. */
  sha: string | null;
}

/** Tree entries for a commit: one blob per file, a `sha: null` entry per deletion. */
/** GitHub answers 409 "Git Repository is empty" for ref lookups on a repo with no commits. */
function isEmptyRepo(e: any): boolean {
  return e?.status === 409 && /empty/i.test(e.message ?? '');
}

export async function buildTreeEntries(files: CommitFile[], createBlob: (f: CommitFile) => Promise<string>): Promise<TreeEntry[]> {
  const tree: TreeEntry[] = [];
  for (const f of files) {
    if (f.content === null) {
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: await createBlob(f) });
  }
  return tree;
}

/** Branch name for a session according to the repo strategy. */
export function sessionBranchName(
  repo: { commitStrategy: string; branchPrefix: string; defaultBranch: string },
  session: { id: string; title: string; taskId?: string | null },
): string {
  if (repo.commitStrategy === 'direct') return repo.defaultBranch;
  const slug =
    session.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'session';
  if (repo.commitStrategy === 'branch-per-task' && session.taskId) return `${repo.branchPrefix}task-${session.taskId.slice(-8)}-${slug}`;
  return `${repo.branchPrefix}${slug}-${session.id.slice(-6)}`;
}
