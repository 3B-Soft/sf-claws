import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateSkillRequest, UpdateSkillRequest, type Skill } from '@sf-claws/shared';
import type { AppContext } from '../../app-context.js';
import { parse } from '../validate.js';
import { requireRole, requireUser } from '../context.js';
import { accessibleClientIds, canAccessClient, requireClientAccess, requireOrgAccess } from '../access.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';

export async function skillRoutes(app: FastifyInstance, ctx: AppContext) {
  /**
   * Which client a skill belongs to, if any. Global skills belong to nobody and are readable by
   * every user; a client- or org-scoped skill is readable by that client's members only.
   */
  const clientOfSkill = (s: Skill): string | null => {
    if (s.scope === 'client') return s.clientId ?? null;
    if (s.scope === 'org') return (s.orgId && ctx.repos.orgs.byId(s.orgId)?.clientId) ?? null;
    return null;
  };

  app.get('/skills', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ clientId: z.string().optional(), orgId: z.string().optional(), all: z.enum(['1', '0']).optional() }), req.query);
    if (q.orgId) requireOrgAccess(ctx, req, q.orgId);
    if (q.clientId) requireClientAccess(ctx, req, q.clientId);
    if (q.clientId || q.orgId) return ctx.repos.skills.list({ clientId: q.clientId, orgId: q.orgId });
    // No filter: the whole catalogue for a super admin; global skills plus the caller's own
    // clients' skills for everyone else. `all=1` is honoured only when it changes nothing.
    const ids = accessibleClientIds(ctx, user);
    if (ids === 'all') return ctx.repos.skills.listAllRaw();
    const seen = new Set<string>();
    const out: Skill[] = [];
    const globals = ctx.repos.skills.listAllRaw().filter((s) => s.scope === 'global');
    for (const s of [...globals, ...ids.flatMap((clientId) => ctx.repos.skills.list({ clientId }))]) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out;
  });
  app.get('/skills/:id', async (req) => {
    const user = requireUser(req);
    const s = ctx.repos.skills.byId((req.params as any).id);
    if (!s) throw notFound('Skill');
    const clientId = clientOfSkill(s);
    if (clientId && !canAccessClient(ctx, user, clientId)) throw forbidden('You are not a member of this client', 'NOT_A_MEMBER');
    return s;
  });
  app.post('/skills', async (req, reply) => {
    const admin = requireRole(req, 'superadmin');
    const body = parse(CreateSkillRequest, req.body);
    if (body.scope === 'client' && !body.clientId) throw badRequest('clientId required for client scope');
    if (body.scope === 'org' && !body.orgId) throw badRequest('orgId required for org scope');
    const s = ctx.repos.skills.create({ ...body, updatedBy: admin.id });
    ctx.repos.audit.log({ userId: admin.id, action: 'skill.create', target: s.id, details: { name: s.name, kind: s.kind, scope: s.scope } });
    reply.status(201);
    return s;
  });
  app.patch('/skills/:id', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const body = parse(UpdateSkillRequest, req.body);
    const s = ctx.repos.skills.update((req.params as any).id, { ...body, updatedBy: admin.id });
    if (!s) throw notFound('Skill');
    ctx.repos.audit.log({ userId: admin.id, action: 'skill.update', target: s.id, details: { version: s.version } });
    return s;
  });
  app.delete('/skills/:id', async (req) => {
    const admin = requireRole(req, 'superadmin');
    ctx.repos.skills.delete((req.params as any).id);
    ctx.repos.audit.log({ userId: admin.id, action: 'skill.delete', target: (req.params as any).id });
    return { ok: true };
  });
  /** Preview the full system prompt context a role would receive for an org (debugging skills). */
  app.get('/skills/preview', async (req) => {
    const q = parse(z.object({ orgId: z.string(), role: z.string() }), req.query);
    const { org } = requireOrgAccess(ctx, req, q.orgId);
    requireRole(req, 'admin');
    return { text: ctx.skills.promptSection(q.role as any, org.clientId, org.id) };
  });
}
