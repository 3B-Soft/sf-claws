/**
 * Org ↔ branch sync: retrieve a package.xml from a Salesforce org, compare it with a branch, and
 * optionally commit the org's version into that branch (typically to seed a new branch).
 *
 * Unchanged files are detected by git blob sha, so only files that actually differ are downloaded
 * from GitHub. A byte difference that is only line endings or trailing whitespace counts as
 * identical — that is formatting noise, not a metadata change.
 */
import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { inferComponentFromPath, type FileDiff, type OrgDiffResponse, type OrgPullResponse, type OrgSyncRequest } from '@sf-claws/shared';
import type { AppContext } from '../app-context.js';
import { parsePackageXml } from '../salesforce/metadata-xml.js';
import { sourceFileBytes, type SourceFile } from '../salesforce/sdr.js';
import { HttpError } from '../lib/errors.js';

/** A full-org retrieve is much slower than a component read. */
const RETRIEVE_TIMEOUT_MS = 20 * 60_000;
/** Patches past this size are listed without a diff so a response stays renderable. */
const MAX_PATCH_CHARS = 200_000;

export function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '');
}

/** Whether a source path (relative to the source root) is covered by the manifest. */
export function inManifest(rel: string, components: { type: string; members: string[] }[]): boolean {
  const c = inferComponentFromPath(rel);
  if (!c) return false;
  const t = components.find((x) => x.type === c.metadataType);
  return !!t && (t.members.includes('*') || t.members.includes(c.fullName));
}

interface DiffResult {
  diff: OrgDiffResponse;
  /** Org files by repo path, for the pull to commit. */
  orgFiles: Map<string, SourceFile>;
}

export async function diffOrgWithBranch(ctx: AppContext, clientId: string, req: OrgSyncRequest): Promise<DiffResult> {
  const org = ctx.repos.orgs.byId(req.orgId);
  if (!org || org.clientId !== clientId) throw new HttpError(404, 'NOT_FOUND', 'Org not found for this client');
  let components;
  try {
    components = parsePackageXml(req.packageXml);
  } catch (e) {
    throw new HttpError(400, 'INVALID_PACKAGE_XML', (e as Error).message);
  }
  const repo = ctx.github.repoFor(clientId);
  const root = repo.sourceRoot.replace(/\/+$/, '');

  const [retrieved, tree] = await Promise.all([
    ctx.sf.retrieve(req.orgId, components, { timeoutMs: RETRIEVE_TIMEOUT_MS }),
    ctx.github.treeShas(clientId, req.branch, `${root}/`),
  ]);
  const branchShas = tree ?? new Map<string, string>();
  const orgFiles = new Map(retrieved.map((f) => [`${root}/${f.path}`, f]));

  const files: FileDiff[] = [];
  let identical = 0;
  const changed: { path: string; file: SourceFile; sha: string }[] = [];
  for (const [path, file] of orgFiles) {
    const sha = branchShas.get(path);
    if (!sha) files.push(entry(path, root, 'added', countLines(file), 0, null));
    else if (sha === gitBlobSha(sourceFileBytes(file))) identical++;
    else changed.push({ path, file, sha });
  }
  // ponytail: fixed batches of 10 blob reads; a proper pool if big first-pull diffs are slow.
  for (let i = 0; i < changed.length; i += 10) {
    await Promise.all(
      changed.slice(i, i + 10).map(async ({ path, file, sha }) => {
        if (file.encoding === 'base64') return files.push(entry(path, root, 'modified', 0, 0, null));
        const before = (await ctx.github.blob(clientId, sha)).toString('utf8');
        if (normalizeText(before) === normalizeText(file.content)) return identical++;
        const patch = createTwoFilesPatch(`branch/${path}`, `org/${path}`, before, file.content);
        const add = (patch.match(/^\+(?!\+\+)/gm) ?? []).length;
        const del = (patch.match(/^-(?!--)/gm) ?? []).length;
        files.push(entry(path, root, 'modified', add, del, patch.length > MAX_PATCH_CHARS ? null : patch));
      }),
    );
  }
  for (const [path] of branchShas) {
    if (!orgFiles.has(path) && inManifest(path.slice(root.length + 1), components)) files.push(entry(path, root, 'removed', 0, 0, null));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { diff: { branch: req.branch, branchExists: !!tree, identical, files }, orgFiles };
}

/**
 * Commit the org's version of every added or modified file into the branch (created from the
 * default branch when missing), plus the manifest at `manifest/package.xml`. Files that exist
 * only in the branch are left alone — a pull never deletes.
 */
export async function pullOrgIntoBranch(
  ctx: AppContext,
  clientId: string,
  req: OrgSyncRequest,
  author: { name: string; email: string },
): Promise<OrgPullResponse> {
  const { diff, orgFiles } = await diffOrgWithBranch(ctx, clientId, req);
  const changed = diff.files.filter((f) => f.status !== 'removed').map((f) => ({ ...orgFiles.get(f.path)!, path: f.path }));
  if (!changed.length) return { branch: req.branch, sha: null, url: null, filesChanged: 0 };
  const org = ctx.repos.orgs.byId(req.orgId)!;
  const message = `${req.message?.trim() || `Pull metadata from ${org.label}`}\n\nOrg: ${org.label}\nAuthored with SF Claws by ${author.name}`;
  const r = await ctx.github.commit(clientId, req.branch, [...changed, { path: 'manifest/package.xml', content: req.packageXml }], message, author);
  return { branch: req.branch, sha: r.sha, url: r.url, filesChanged: changed.length };
}

function entry(path: string, root: string, status: FileDiff['status'], additions: number, deletions: number, patch: string | null): FileDiff {
  const c = inferComponentFromPath(path.slice(root.length + 1));
  return { path, status, additions, deletions, patch, metadataType: c?.metadataType ?? null, fullName: c?.fullName ?? null };
}

function countLines(f: SourceFile): number {
  return f.encoding === 'base64' ? 0 : f.content.split('\n').length;
}
