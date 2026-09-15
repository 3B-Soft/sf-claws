import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentInstructions, CreateClientRequest, CreateOrgRequest, SetClientMemberRequest } from '@sf-claws/shared';
import type { AppContext } from '../../app-context.js';
import { parse } from '../validate.js';
import { requireRole, requireUser, ip } from '../context.js';
import { accessibleClientIds, requireClientAccess } from '../access.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { publicOrg } from './orgs.js';

export async function clientRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Membership first, role second, so a non-member admin learns "not a member" and nothing about the route. */
  const clientFor = (req: any) => requireClientAccess(ctx, req, req.params.id ?? req.params.clientId);

  app.get('/clients', async (req) => {
    const user = requireUser(req);
    const ids = accessibleClientIds(ctx, user);
    const visible = ids === 'all' ? ctx.repos.clients.list() : ctx.repos.clients.list().filter((c) => ids.includes(c.id));
    return visible.map((c) => ({ ...c, orgCount: ctx.repos.orgs.listByClient(c.id).length, hasGithub: !!ctx.repos.github.byClient(c.id) }));
  });
  app.post('/clients', async (req, reply) => {
    const admin = requireRole(req, 'admin');
    const body = parse(CreateClientRequest, req.body);
    if (ctx.repos.clients.bySlug(body.slug)) throw badRequest('Slug already in use');
    const c = ctx.repos.clients.create(body);
    // The admin who creates a client can see it afterwards. A super admin needs no row.
    if (admin.role !== 'superadmin') ctx.repos.clientMembers.set(admin.id, c.id, 'admin');
    ctx.repos.audit.log({ userId: admin.id, action: 'client.create', target: c.id, details: { name: c.name } });
    reply.status(201);
    return c;
  });
  app.get('/clients/:id', async (req) => {
    clientFor(req);
    const c = ctx.repos.clients.byId((req.params as any).id)!;
    return {
      ...c,
      orgs: ctx.repos.orgs.listByClient(c.id).map(publicOrg),
      github: stripToken(ctx.repos.github.byClient(c.id)),
      projects: ctx.repos.projects.list(c.id),
    };
  });
  app.patch('/clients/:id', async (req) => {
    clientFor(req);
    const admin = requireRole(req, 'admin');
    const body = parse(
      z.object({
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        instructions: AgentInstructions.nullable().optional(),
      }),
      req.body,
    );
    const c = ctx.repos.clients.update((req.params as any).id, body);
    if (!c) throw notFound('Client');
    // The audit trail records that instructions changed and their size, not the prose itself.
    ctx.repos.audit.log({
      userId: admin.id,
      action: 'client.update',
      target: c.id,
      details: { ...body, ...(body.instructions !== undefined ? { instructions: `${body.instructions?.length ?? 0} chars` } : {}) },
    });
    return c;
  });
  app.delete('/clients/:id', async (req) => {
    clientFor(req);
    const admin = requireRole(req, 'superadmin');
    const id = (req.params as any).id;
    if (ctx.repos.sessions.list({ clientId: id, limit: 1 }).length) throw badRequest('Client has sessions; archive instead of deleting');
    ctx.repos.clients.delete(id);
    ctx.repos.audit.log({ userId: admin.id, action: 'client.delete', target: id });
    return { ok: true };
  });

  app.get('/clients/:clientId/orgs', async (req) => {
    clientFor(req);
    return ctx.repos.orgs.listByClient((req.params as any).clientId).map(publicOrg);
  });
  app.post('/clients/:clientId/orgs', async (req, reply) => {
    clientFor(req);
    const admin = requireRole(req, 'admin');
    const { clientId } = req.params as any;
    const { consumerSecret, ...body } = parse(CreateOrgRequest, req.body);
    const org = ctx.repos.orgs.create({
      clientId,
      ...body,
      protected: body.protected || body.kind === 'production',
      consumerSecretEnc: consumerSecret ? ctx.secrets.encryptFor(clientId, consumerSecret) : null,
    });
    ctx.repos.audit.log({ userId: admin.id, action: 'org.create', target: org.id, details: { label: org.label, kind: org.kind } });
    reply.status(201);
    return publicOrg(org);
  });

  // ---- membership ----
  // Listing is open to members (you may see who else works on your client); changing it is the
  // super admin's call, since membership is what decides who can read a client's orgs and sessions.
  app.get('/clients/:clientId/members', async (req) => {
    clientFor(req);
    return ctx.repos.clientMembers.listByClient((req.params as any).clientId);
  });
  app.put('/clients/:clientId/members/:userId', async (req) => {
    clientFor(req);
    const admin = requireRole(req, 'superadmin');
    const { clientId, userId } = req.params as { clientId: string; userId: string };
    const body = parse(SetClientMemberRequest, req.body ?? {});
    const user = ctx.repos.users.byId(userId);
    if (!user) throw notFound('User');
    if (user.role === 'superadmin') throw badRequest('Super admins belong to every client already');
    ctx.repos.clientMembers.set(userId, clientId, body.role);
    ctx.repos.audit.log({ userId: admin.id, action: 'client.member_set', target: clientId, details: { userId, role: body.role }, ip: ip(req) });
    return ctx.repos.clientMembers.listByClient(clientId).find((m) => m.userId === userId);
  });
  app.delete('/clients/:clientId/members/:userId', async (req) => {
    clientFor(req);
    const admin = requireRole(req, 'superadmin');
    const { clientId, userId } = req.params as { clientId: string; userId: string };
    if (!ctx.repos.clientMembers.remove(userId, clientId)) throw notFound('Membership');
    ctx.repos.audit.log({ userId: admin.id, action: 'client.member_remove', target: clientId, details: { userId }, ip: ip(req) });
    return { ok: true };
  });
}

export function stripToken<T extends { tokenEnc?: string | null } | undefined>(r: T): Omit<NonNullable<T>, 'tokenEnc'> | null {
  if (!r) return null;
  const { tokenEnc: _t, ...rest } = r as any;
  return rest;
}
