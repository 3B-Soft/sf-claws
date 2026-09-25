import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OrgSyncRequest, SetGithubRepoRequest } from '@sf-claws/shared';
import type { AppContext } from '../../app-context.js';
import { parse } from '../validate.js';
import { requireRole } from '../context.js';
import { requireClientAccess } from '../access.js';
import { notFound } from '../../lib/errors.js';
import { stripToken } from './clients.js';
import { diffOrgWithBranch, pullOrgIntoBranch } from '../../github/org-sync.js';

export async function githubRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Every route here is client-addressed: membership is checked before anything else. */
  const clientOf = (req: any) => {
    const id = req.params.clientId as string;
    requireClientAccess(ctx, req, id);
    return id;
  };

  app.get('/clients/:clientId/github', async (req) => {
    const clientId = clientOf(req);
    return stripToken(ctx.repos.github.byClient(clientId), ctx.github.hasToken(clientId));
  });
  app.put('/clients/:clientId/github', async (req) => {
    const clientId = clientOf(req);
    const admin = requireRole(req, 'superadmin');
    const body = parse(SetGithubRepoRequest, req.body);
    const { token, ...rest } = body;
    const r = ctx.repos.github.upsert(clientId, { ...rest, tokenEnc: token ? ctx.secrets.encryptFor(clientId, token) : undefined });
    ctx.repos.audit.log({
      userId: admin.id,
      action: 'github.configure',
      target: clientId,
      details: { owner: r.owner, repo: r.repo, strategy: r.commitStrategy, tokenUpdated: !!token },
    });
    return stripToken(r, ctx.github.hasToken(clientId));
  });
  app.delete('/clients/:clientId/github', async (req) => {
    const clientId = clientOf(req);
    const admin = requireRole(req, 'superadmin');
    ctx.repos.github.delete(clientId);
    ctx.repos.audit.log({ userId: admin.id, action: 'github.remove', target: clientId });
    return { ok: true };
  });
  app.post('/clients/:clientId/github/test', async (req) => {
    const clientId = clientOf(req);
    requireRole(req, 'admin');
    return ctx.github.testConnection(clientId);
  });
  app.get('/clients/:clientId/github/branches', async (req) => ctx.github.branches(clientOf(req)));
  app.get('/clients/:clientId/github/compare', async (req) => {
    const clientId = clientOf(req);
    const repo = ctx.github.repoFor(clientId);
    const q = parse(z.object({ base: z.string().default(repo.defaultBranch), head: z.string() }), req.query);
    return ctx.github.compare(clientId, q.base, q.head);
  });
  app.post('/clients/:clientId/github/org-diff', async (req) => {
    const clientId = clientOf(req);
    requireRole(req, 'admin');
    return (await diffOrgWithBranch(ctx, clientId, parse(OrgSyncRequest, req.body))).diff;
  });
  app.post('/clients/:clientId/github/org-pull', async (req) => {
    const clientId = clientOf(req);
    const admin = requireRole(req, 'superadmin');
    const body = parse(OrgSyncRequest, req.body);
    const r = await pullOrgIntoBranch(ctx, clientId, body, { name: admin.displayName, email: admin.email });
    ctx.repos.audit.log({
      userId: admin.id,
      action: 'github.org-pull',
      target: clientId,
      details: { orgId: body.orgId, branch: r.branch, sha: r.sha, files: r.filesChanged },
    });
    return r;
  });
  app.get('/clients/:clientId/github/commits', async (req) => {
    const clientId = clientOf(req);
    const q = parse(z.object({ branch: z.string().optional(), limit: z.coerce.number().int().max(100).default(30) }), req.query);
    return ctx.github.commits(clientId, q.branch, q.limit);
  });
  app.get('/clients/:clientId/github/file', async (req) => {
    const clientId = clientOf(req);
    const q = parse(z.object({ path: z.string(), ref: z.string().optional() }), req.query);
    const f = await ctx.github.getFile(clientId, q.path, q.ref);
    if (!f) throw notFound('File');
    return f;
  });
  app.get('/clients/:clientId/github/tree', async (req) => {
    const clientId = clientOf(req);
    const q = parse(z.object({ path: z.string().default(''), ref: z.string().optional() }), req.query);
    return ctx.github.listDir(clientId, q.path, q.ref);
  });
}
