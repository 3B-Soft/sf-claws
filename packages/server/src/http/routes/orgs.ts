import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentInstructions, QueryRequest, type SalesforceOrg } from '@sf-claws/shared';
import type { AppContext } from '../../app-context.js';
import type { OrgRow } from '../../db/repos/index.js';
import { parse } from '../validate.js';
import { requireRole, requireUser, ip } from '../context.js';
import { filterAccessible, requireOrgAccess } from '../access.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { xmlToJson } from '../../salesforce/metadata-xml.js';

export function publicOrg(o: OrgRow): SalesforceOrg & { myDomainHost: string | null; lastError: string | null; githubRepoId: string | null } {
  return { ...o, githubRepoId: null };
}

export async function orgRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Membership check first, role check second: a non-member admin is told "not a member", never "needs admin". */
  const orgFor = (req: any) => requireOrgAccess(ctx, req, req.params.orgId).org;

  app.get('/orgs', async (req) => {
    const user = requireUser(req);
    return filterAccessible(ctx, user, ctx.repos.orgs.listAll()).map(publicOrg);
  });
  app.get('/orgs/:orgId', async (req) => publicOrg(orgFor(req)));
  app.patch('/orgs/:orgId', async (req) => {
    const o = orgFor(req);
    const admin = requireRole(req, 'admin');
    const body = parse(
      z.object({
        label: z.string().min(1).optional(),
        kind: z.enum(['production', 'sandbox', 'scratch', 'developer']).optional(),
        loginUrl: z.string().url().optional(),
        apiVersion: z.string().optional(),
        protected: z.boolean().optional(),
        instructions: AgentInstructions.nullable().optional(),
      }),
      req.body,
    );
    const updated = ctx.repos.orgs.update(o.id, body)!;
    ctx.sf.connections.invalidate(o.id);
    ctx.repos.audit.log({
      userId: admin.id,
      action: 'org.update',
      target: o.id,
      details: { ...body, ...(body.instructions !== undefined ? { instructions: `${body.instructions?.length ?? 0} chars` } : {}) },
    });
    return publicOrg(updated);
  });
  app.delete('/orgs/:orgId', async (req) => {
    const o = orgFor(req);
    const admin = requireRole(req, 'superadmin');
    if (ctx.repos.sessions.list({ orgId: o.id, limit: 1 }).length) throw badRequest('Org has sessions; disconnect it instead of deleting');
    await ctx.sf.disconnect(o.id);
    ctx.repos.orgs.delete(o.id);
    ctx.repos.audit.log({ userId: admin.id, action: 'org.delete', target: o.id });
    return { ok: true };
  });

  /**
   * Extension: which registered org is the current tab? The lookup runs across every org (the
   * tab does not yet know its client), and the caller only ever sees the orgs they are a member
   * of: an org that exists but belongs to someone else's client answers "not found", the same as
   * an org nobody registered.
   */
  app.get('/orgs/resolve', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ host: z.string().optional(), sfOrgId: z.string().optional() }), req.query);
    let matches: OrgRow[] = [];
    if (q.sfOrgId) matches = ctx.repos.orgs.bySfOrgId(q.sfOrgId);
    if (!matches.length && q.host) {
      const host = q.host.toLowerCase();
      // acme.lightning.force.com / acme.my.salesforce.com / acme--sbx.sandbox.my.salesforce.com / acme.my.salesforce-setup.com
      const base = host.replace(
        /\.(lightning\.force|my\.salesforce|my\.salesforce-setup|sandbox\.lightning\.force|sandbox\.my\.salesforce|sandbox\.my\.salesforce-setup|develop\.lightning\.force|develop\.my\.salesforce|scratch\.lightning\.force|scratch\.my\.salesforce|file\.force|vf\.force|visualforce)\.com$/,
        '',
      );
      matches = ctx.repos.orgs.listAll().filter((o) => {
        const h = (o.myDomainHost ?? (o.instanceUrl ? new URL(o.instanceUrl).hostname : '')).toLowerCase();
        if (!h) return false;
        const b = h.replace(/\.(my\.salesforce|lightning\.force|sandbox\.my\.salesforce|develop\.my\.salesforce|scratch\.my\.salesforce)\.com$/, '');
        return b === base;
      });
    }
    matches = filterAccessible(ctx, user, matches);
    if (!matches.length) throw notFound('Org for this Salesforce host');
    const org = matches[0];
    return { org: publicOrg(org), client: ctx.repos.clients.byId(org.clientId), candidates: matches.length > 1 ? matches.map(publicOrg) : undefined };
  });

  // ---- OAuth ----
  app.get('/orgs/:orgId/connect/start', async (req) => {
    const o = orgFor(req);
    const admin = requireRole(req, 'admin');
    ctx.repos.audit.log({ userId: admin.id, action: 'org.connect_start', target: o.id, ip: ip(req) });
    return ctx.sf.startOAuth(o.id, admin.id);
  });
  app.get('/oauth/salesforce/callback', async (req, reply) => {
    const q = parse(
      z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() }),
      req.query,
    );
    const adminBase = ctx.config.PUBLIC_URL;
    if (q.error || !q.code || !q.state)
      return reply.redirect(`${adminBase}/#/oauth-result?ok=0&message=${encodeURIComponent(q.error_description ?? q.error ?? 'Missing code')}`);
    try {
      const r = await ctx.sf.completeOAuth(q.code, q.state);
      return reply.redirect(`${adminBase}/#/oauth-result?ok=1&orgId=${r.orgId}`);
    } catch (e) {
      return reply.redirect(`${adminBase}/#/oauth-result?ok=0&message=${encodeURIComponent((e as Error).message)}`);
    }
  });
  app.post('/orgs/:orgId/disconnect', async (req) => {
    const o = orgFor(req);
    const admin = requireRole(req, 'admin');
    await ctx.sf.disconnect(o.id);
    ctx.repos.audit.log({ userId: admin.id, action: 'org.disconnect', target: o.id });
    return publicOrg(ctx.repos.orgs.byId(o.id)!);
  });
  app.get('/orgs/:orgId/status', async (req) => ctx.sf.status(orgFor(req).id));

  // ---- Data & metadata (read) ----
  app.post('/orgs/:orgId/query', async (req) => {
    const { user, org: o } = requireOrgAccess(ctx, req, (req.params as any).orgId);
    const body = parse(QueryRequest, req.body);
    if (!/^\s*select\s/i.test(body.soql)) throw badRequest('Only SELECT queries are allowed');
    ctx.repos.audit.log({ userId: user.id, action: 'org.query', target: o.id, details: { soql: body.soql.slice(0, 500), tooling: body.tooling } });
    return ctx.sf.query(o.id, body.soql, { tooling: body.tooling, limit: body.limit });
  });
  app.get('/orgs/:orgId/describe/global', async (req) => ctx.sf.describeGlobal(orgFor(req).id));
  app.get('/orgs/:orgId/describe/:sobject', async (req) => ctx.sf.describe(orgFor(req).id, (req.params as any).sobject));
  app.get('/orgs/:orgId/metadata/types', async (req) => ctx.sf.describeMetadata(orgFor(req).id));
  app.get('/orgs/:orgId/metadata/list', async (req) => {
    const o = orgFor(req);
    const q = parse(z.object({ type: z.string(), folder: z.string().optional() }), req.query);
    return ctx.sf.listMetadata(o.id, q.type, q.folder);
  });
  app.get('/orgs/:orgId/metadata/read', async (req) => {
    const o = orgFor(req);
    const q = parse(z.object({ type: z.string(), fullName: z.string() }), req.query);
    const files = await ctx.sf.readComponent(o.id, q.type, q.fullName);
    return { files: files.map((f) => ({ path: f.path, content: f.content, json: f.path.endsWith('.xml') ? safeJson(f.content) : null })) };
  });
  app.get('/orgs/:orgId/logs', async (req) => {
    const o = orgFor(req);
    const q = parse(z.object({ limit: z.coerce.number().int().max(100).default(20) }), req.query);
    return ctx.sf.recentApexLogs(o.id, q.limit);
  });
  app.get('/orgs/:orgId/logs/:logId', async (req) => ({ body: await ctx.sf.apexLogBody(orgFor(req).id, (req.params as any).logId) }));
  app.get('/orgs/:orgId/limits', async (req) => {
    const o = orgFor(req);
    const q = parse(z.object({ force: z.enum(['1', '0']).optional() }), req.query);
    return ctx.sf.limits(o.id, ctx.policy.effective(o.clientId).apiLimitWarnPercent, q.force === '1');
  });
  app.get('/orgs/:orgId/docs', async (req) => ctx.repos.docs.byOrg(orgFor(req).id, 100));
}

function safeJson(xml: string): unknown {
  try {
    return xmlToJson(xml);
  } catch {
    return null;
  }
}
