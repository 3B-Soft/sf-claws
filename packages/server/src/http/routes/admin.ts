import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApproveUserRequest,
  UpdateUserRequest,
  SetProviderRequest,
  CreateModelRequest,
  UpdateModelRequest,
  SetRoleBindingsRequest,
  SetPolicyRequest,
  AiProvider,
  KnowledgeSourceKind,
  AgentRole,
} from '@sf-claws/shared';
import type { AppContext } from '../../app-context.js';
import { parse } from '../validate.js';
import { requireRole, ip } from '../context.js';
import { accessibleClientIds, requireClientAccess } from '../access.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';
import { toPublicSource } from '../../knowledge/service.js';
import { monthStartIso } from '../../agents/cost.js';

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---- users ----
  app.get('/admin/users', async (req) => {
    requireRole(req, 'admin');
    return ctx.repos.users.list();
  });

  app.post('/admin/users/:id/approve', async (req) => {
    const admin = requireRole(req, 'admin');
    const { id } = req.params as { id: string };
    const body = parse(ApproveUserRequest, req.body ?? {});
    if (body.role === 'superadmin' && admin.role !== 'superadmin') throw forbidden('Only a super admin can grant super admin');
    const user = ctx.repos.users.byId(id);
    if (!user) throw notFound('User');
    const updated = ctx.repos.users.update(id, { status: 'active', role: body.role, approvedAt: new Date().toISOString(), approvedBy: admin.id });
    ctx.repos.audit.log({ userId: admin.id, action: 'user.approve', target: id, details: { role: body.role }, ip: ip(req) });
    return updated;
  });

  app.post('/admin/users/:id/disable', async (req) => {
    const admin = requireRole(req, 'admin');
    const { id } = req.params as { id: string };
    const user = ctx.repos.users.byId(id);
    if (!user) throw notFound('User');
    if (user.role === 'superadmin' && admin.role !== 'superadmin') throw forbidden('Cannot disable a super admin');
    if (user.id === admin.id) throw badRequest('You cannot disable yourself');
    ctx.repos.users.update(id, { status: 'disabled' });
    ctx.repos.tokens.revokeAllForUser(id);
    ctx.repos.audit.log({ userId: admin.id, action: 'user.disable', target: id, ip: ip(req) });
    return ctx.repos.users.byId(id);
  });

  /** Every client membership in the deployment, for the users page. Admin-only inventory. */
  app.get('/admin/memberships', async (req) => {
    requireRole(req, 'admin');
    return ctx.repos.clientMembers.listAll();
  });

  app.patch('/admin/users/:id', async (req) => {
    const admin = requireRole(req, 'admin');
    const { id } = req.params as { id: string };
    const body = parse(UpdateUserRequest, req.body);
    const user = ctx.repos.users.byId(id);
    if (!user) throw notFound('User');
    if ((body.role === 'superadmin' || user.role === 'superadmin') && admin.role !== 'superadmin')
      throw forbidden('Only a super admin can manage super admins');
    const updated = ctx.repos.users.update(id, body);
    if (body.status === 'disabled') ctx.repos.tokens.revokeAllForUser(id);
    ctx.repos.audit.log({ userId: admin.id, action: 'user.update', target: id, details: body, ip: ip(req) });
    return updated;
  });

  // ---- client access ----
  // The per-user view of membership (`client_members`), for the edit modal on the users page. The
  // per-client view lives on `/clients/:clientId/members`. Same rule as there: a super admin belongs
  // to every client and has no rows; only a super admin changes membership.
  app.get('/admin/users/:id/clients', async (req) => {
    requireRole(req, 'admin');
    const user = ctx.repos.users.byId((req.params as any).id);
    if (!user) throw notFound('User');
    const all = user.role === 'superadmin';
    return { seesAllClients: all, clientIds: all ? [] : ctx.repos.clientMembers.clientIdsForUser(user.id) };
  });

  app.put('/admin/users/:id/clients', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const user = ctx.repos.users.byId((req.params as any).id);
    if (!user) throw notFound('User');
    if (user.role === 'superadmin') throw badRequest('A super admin already belongs to every client');
    const body = parse(z.object({ clientIds: z.array(z.string()).max(500) }), req.body);
    const wanted = new Set(body.clientIds);
    for (const id of wanted) if (!ctx.repos.clients.byId(id)) throw badRequest(`Unknown client ${id}`);
    const current = new Set(ctx.repos.clientMembers.clientIdsForUser(user.id));
    // Existing memberships keep their level; new ones start as plain members.
    for (const id of wanted) if (!current.has(id)) ctx.repos.clientMembers.set(user.id, id, 'member');
    for (const id of current) if (!wanted.has(id)) ctx.repos.clientMembers.remove(user.id, id);
    ctx.repos.audit.log({ userId: admin.id, action: 'user.clients.set', target: user.id, details: { clientIds: [...wanted] }, ip: ip(req) });
    return { seesAllClients: false, clientIds: ctx.repos.clientMembers.clientIdsForUser(user.id) };
  });

  // ---- providers ----
  app.get('/admin/providers', async (req) => {
    requireRole(req, 'admin');
    const configured = new Map(ctx.repos.providers.list().map((p) => [p.provider, p]));
    return AiProvider.options.map((p) => ({
      provider: p,
      hasKey: configured.has(p),
      baseUrl: configured.get(p)?.baseUrl ?? null,
      updatedAt: configured.get(p)?.updatedAt ?? null,
    }));
  });
  app.put('/admin/providers/:provider', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const provider = parse(AiProvider, (req.params as any).provider);
    const body = parse(SetProviderRequest, req.body);
    ctx.repos.providers.set(provider, ctx.secrets.encrypt(body.apiKey), body.baseUrl ?? null, admin.id);
    ctx.ai.invalidate();
    ctx.repos.audit.log({ userId: admin.id, action: 'provider.set', target: provider, ip: ip(req) });
    return { ok: true };
  });
  app.delete('/admin/providers/:provider', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const provider = parse(AiProvider, (req.params as any).provider);
    ctx.repos.providers.delete(provider);
    ctx.ai.invalidate();
    ctx.repos.audit.log({ userId: admin.id, action: 'provider.delete', target: provider, ip: ip(req) });
    return { ok: true };
  });
  app.post('/admin/providers/:provider/test', async (req) => {
    requireRole(req, 'admin');
    const provider = parse(AiProvider, (req.params as any).provider);
    return ctx.ai.testProvider(provider);
  });

  // ---- models ----
  app.get('/admin/models', async (req) => {
    requireRole(req, 'user');
    return ctx.repos.models.list();
  });
  app.post('/admin/models', async (req, reply) => {
    const admin = requireRole(req, 'superadmin');
    const body = parse(CreateModelRequest, req.body);
    if (ctx.repos.models.byProviderModel(body.provider, body.modelId)) throw badRequest('Model already registered');
    const m = ctx.repos.models.create(body);
    ctx.repos.audit.log({ userId: admin.id, action: 'model.create', target: m.id, details: { provider: m.provider, modelId: m.modelId } });
    reply.status(201);
    return m;
  });
  app.patch('/admin/models/:id', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const body = parse(UpdateModelRequest, req.body);
    const m = ctx.repos.models.update((req.params as any).id, body);
    if (!m) throw notFound('Model');
    ctx.repos.audit.log({ userId: admin.id, action: 'model.update', target: m.id, details: body });
    return m;
  });
  app.delete('/admin/models/:id', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const id = (req.params as any).id;
    if (ctx.repos.bindings.list().some((b) => b.modelId === id)) throw badRequest('Model is bound to an agent role; rebind first');
    ctx.repos.models.delete(id);
    ctx.repos.audit.log({ userId: admin.id, action: 'model.delete', target: id });
    return { ok: true };
  });

  // ---- role bindings ----
  app.get('/admin/role-bindings', async (req) => {
    requireRole(req, 'user');
    return ctx.repos.bindings.list();
  });
  app.put('/admin/role-bindings', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const body = parse(SetRoleBindingsRequest, req.body);
    for (const b of body) if (!ctx.repos.models.byId(b.modelId)) throw badRequest(`Unknown model ${b.modelId} for role ${b.role}`);
    ctx.repos.bindings.setAll(body);
    ctx.repos.audit.log({ userId: admin.id, action: 'bindings.set', details: body });
    return ctx.repos.bindings.list();
  });

  // ---- policy ----
  app.get('/admin/policy', async (req) => {
    requireRole(req, 'user');
    const q = parse(z.object({ clientId: z.string().optional() }), req.query);
    // The global policy is readable by any user; a client's override only by that client's members.
    if (q.clientId) requireClientAccess(ctx, req, q.clientId);
    return {
      effective: ctx.policy.effective(q.clientId),
      global: ctx.repos.policies.get('global') ?? {},
      override: q.clientId ? (ctx.repos.policies.get(`client:${q.clientId}`) ?? {}) : null,
    };
  });
  app.put('/admin/policy', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const q = parse(z.object({ clientId: z.string().optional() }), req.query);
    const body = parse(SetPolicyRequest, req.body);
    // Merge rather than replace. The stored row is a partial, and a caller that omits a key means
    // "leave it alone", not "reset it to the schema default" — the admin console omitted the spend
    // ceilings for exactly this reason and every save silently set them back to unlimited. Callers
    // that mean to clear a field send it explicitly.
    // Which keys the caller actually sent has to come from the raw body: `PolicyRules.partial()`
    // still applies each field's default, so the parsed object always looks fully specified and a
    // merge against it would preserve nothing. Parse validates; the raw body decides intent.
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const sent = Object.fromEntries(Object.entries(body).filter(([k]) => k in raw));
    const scopeKey = q.clientId ? `client:${q.clientId}` : 'global';
    ctx.repos.policies.set(scopeKey, { ...(ctx.repos.policies.get(scopeKey) ?? {}), ...sent }, admin.id);
    ctx.repos.audit.log({ userId: admin.id, action: 'policy.set', target: q.clientId ?? 'global', details: body });
    return { effective: ctx.policy.effective(q.clientId) };
  });

  // ---- observability ----
  app.get('/admin/sessions', async (req) => {
    const admin = requireRole(req, 'admin');
    const q = parse(
      z.object({
        userId: z.string().optional(),
        clientId: z.string().optional(),
        orgId: z.string().optional(),
        status: z.string().optional(),
        helpful: z.enum(['true', 'false']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.coerce.number().int().max(1000).optional(),
      }),
      req.query,
    );
    if (q.clientId) requireClientAccess(ctx, req, q.clientId);
    const filter = { ...q, status: q.status as any, helpful: q.helpful === undefined ? undefined : q.helpful === 'true' };
    const ids = accessibleClientIds(ctx, admin);
    if (ids === 'all' || q.clientId) return ctx.repos.sessions.list(filter);
    // A platform admin's inventory covers the clients they belong to, not the whole deployment.
    return ids
      .flatMap((clientId) => ctx.repos.sessions.list({ ...filter, clientId }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, q.limit ?? 100);
  });
  app.get('/admin/usage/summary', async (req) => {
    requireRole(req, 'admin');
    const q = parse(
      z.object({ from: z.string().optional(), to: z.string().optional(), groupBy: z.enum(['user', 'client', 'model', 'role']).default('user') }),
      req.query,
    );
    const from = q.from ?? new Date(Date.now() - 30 * 86400_000).toISOString();
    const to = q.to ?? new Date().toISOString();
    const rows = ctx.repos.usage.summary(q.groupBy, from, to);
    const label = (key: string) =>
      q.groupBy === 'user' ? (ctx.repos.users.byId(key)?.displayName ?? key) : q.groupBy === 'client' ? (ctx.repos.clients.byId(key)?.name ?? key) : key;
    const out = rows.map((r) => ({ ...r, label: label(r.key) }));
    const totals = out.reduce(
      (a, r) => ({
        key: 'total',
        label: 'Total',
        sessions: a.sessions + r.sessions,
        inputTokens: a.inputTokens + r.inputTokens,
        outputTokens: a.outputTokens + r.outputTokens,
        cachedInputTokens: a.cachedInputTokens + r.cachedInputTokens,
        costUsd: a.costUsd + r.costUsd,
      }),
      { key: 'total', label: 'Total', sessions: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
    );
    return { groupBy: q.groupBy, from, to, rows: out, totals };
  });
  app.get('/admin/usage/records', async (req) => {
    requireRole(req, 'admin');
    const q = parse(z.object({ sessionId: z.string() }), req.query);
    return ctx.repos.usage.bySession(q.sessionId);
  });
  app.get('/admin/audit', async (req) => {
    requireRole(req, 'admin');
    const q = parse(z.object({ limit: z.coerce.number().int().max(2000).default(200) }), req.query);
    return ctx.repos.audit.list(q.limit);
  });
  app.get('/admin/stats', async (req) => {
    requireRole(req, 'admin');
    const dayAgo = new Date(Date.now() - 86400_000).toISOString();
    return {
      usersPending: ctx.repos.users.list().filter((u) => u.status === 'pending').length,
      usersTotal: ctx.repos.users.count(),
      sessions24h: ctx.repos.sessions.countSince(dayAgo),
      cost24h: ctx.repos.usage.costSince(dayAgo),
      clients: ctx.repos.clients.list().length,
      orgs: ctx.repos.orgs.listAll().length,
    };
  });

  // ---- knowledge sources (product documentation + product source repositories) ----
  // Super-admin only: a source carries a credential and is readable by every session in scope, so
  // adding one is the same trust decision as editing the policy.
  const KnowledgeSourceInput = z.object({
    kind: KnowledgeSourceKind,
    name: z.string().min(1),
    repoRef: z.string().regex(/^[\w.-]+\/[\w.-]+(#.+)?$/, 'Expected owner/repo or owner/repo#branch'),
    guidance: z.string().default(''),
    scope: z.enum(['global', 'client']).default('global'),
    clientId: z.string().nullable().optional(),
    token: z.string().optional(),
    enabled: z.boolean().default(true),
  });

  app.get('/admin/knowledge', async (req) => {
    requireRole(req, 'admin');
    return ctx.repos.knowledge.listAll().map(toPublicSource);
  });

  app.post('/admin/knowledge', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const body = parse(KnowledgeSourceInput, req.body);
    if (body.scope === 'client' && !body.clientId) throw badRequest('A client-scoped source needs a clientId');
    const created = ctx.repos.knowledge.create({
      kind: body.kind,
      name: body.name,
      repoRef: body.repoRef,
      guidance: body.guidance,
      scope: body.scope,
      clientId: body.scope === 'client' ? (body.clientId ?? null) : null,
      tokenEnc: body.token ? ctx.secrets.encrypt(body.token) : null,
      enabled: body.enabled,
    });
    ctx.repos.audit.log({
      userId: admin.id,
      action: 'knowledge.create',
      target: created.id,
      details: { name: created.name, repoRef: created.repoRef, scope: created.scope },
      ip: ip(req),
    });
    return toPublicSource(created);
  });

  app.patch('/admin/knowledge/:id', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const { id } = req.params as { id: string };
    if (!ctx.repos.knowledge.byId(id)) throw notFound('Knowledge source');
    const body = parse(KnowledgeSourceInput.partial(), req.body);
    const updated = ctx.repos.knowledge.update(id, {
      ...body,
      // An empty token means "leave it alone"; clearing one is an explicit delete of the source.
      tokenEnc: body.token ? ctx.secrets.encrypt(body.token) : undefined,
    });
    ctx.knowledge.invalidate(id);
    ctx.repos.audit.log({ userId: admin.id, action: 'knowledge.update', target: id, details: { fields: Object.keys(body) }, ip: ip(req) });
    return toPublicSource(updated!);
  });

  app.delete('/admin/knowledge/:id', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const { id } = req.params as { id: string };
    ctx.knowledge.invalidate(id);
    ctx.repos.knowledge.delete(id);
    ctx.repos.audit.log({ userId: admin.id, action: 'knowledge.delete', target: id, ip: ip(req) });
    return { ok: true };
  });

  app.post('/admin/knowledge/:id/test', async (req) => {
    requireRole(req, 'admin');
    const { id } = req.params as { id: string };
    if (!ctx.repos.knowledge.byId(id)) throw notFound('Knowledge source');
    return ctx.knowledge.test(id);
  });

  // ---- observability ----
  // Per-tool telemetry, separate from usage_records (which is per model call). This is how a super
  // admin sees which tools earn their prompt-token cost, which fail, and which the models misuse.
  app.get('/admin/tools/summary', async (req) => {
    requireRole(req, 'admin');
    const q = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), req.query);
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.now() - 7 * 86400_000).toISOString();
    return { from, to, tools: ctx.repos.usage.toolSummary(from, to) };
  });

  app.get('/admin/tools/session', async (req) => {
    requireRole(req, 'admin');
    const q = parse(z.object({ sessionId: z.string() }), req.query);
    return ctx.repos.usage.toolStats(q.sessionId);
  });

  /** Spend against the configured ceilings, per client, for the current month. */
  app.get('/admin/budget', async (req) => {
    const admin = requireRole(req, 'admin');
    const monthStart = monthStartIso();
    const ids = accessibleClientIds(ctx, admin);
    const clients = ids === 'all' ? ctx.repos.clients.list() : ctx.repos.clients.list().filter((c) => ids.includes(c.id));
    return clients.map((client) => {
      const rules = ctx.policy.effective(client.id);
      const spentThisMonth = ctx.repos.usage.clientCostSince(client.id, monthStart);
      const limit = rules.maxClientMonthlyCostUsd;
      return {
        clientId: client.id,
        clientName: client.name,
        spentThisMonth,
        monthlyLimitUsd: limit,
        // null when unlimited: the UI should say "no ceiling", not draw a full bar.
        percentUsed: limit > 0 ? Math.round((spentThisMonth / limit) * 100) : null,
        maxSessionCostUsd: rules.maxSessionCostUsd,
        maxTurnCostUsd: rules.maxTurnCostUsd,
      };
    });
  });

  // ---- custom specialists ----
  // Super-admin only, like knowledge sources and policy: a specialist's instructions reach every
  // session in scope. The base role fixes the tool set, so this cannot widen an agent's reach.
  const CustomAgentInput = z.object({
    name: z.string().min(1).max(60),
    whenToUse: z.string().min(1).max(500),
    baseRole: AgentRole,
    instructions: z.string().min(1),
    scope: z.enum(['global', 'client']).default('global'),
    clientId: z.string().nullable().optional(),
    enabled: z.boolean().default(true),
  });

  app.get('/admin/agents', async (req) => {
    requireRole(req, 'admin');
    return ctx.repos.customAgents.listAll();
  });

  app.post('/admin/agents', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const body = parse(CustomAgentInput, req.body);
    if (body.scope === 'client' && !body.clientId) throw badRequest('A client-scoped specialist needs a clientId');
    // The orchestrator delegates; it cannot be a delegate, and the summarizer has no tools.
    if (body.baseRole === 'orchestrator' || body.baseRole === 'summarizer') throw badRequest('baseRole must be a delegatable role');
    const created = ctx.repos.customAgents.create({
      name: body.name,
      whenToUse: body.whenToUse,
      baseRole: body.baseRole,
      instructions: body.instructions,
      scope: body.scope,
      enabled: body.enabled,
      clientId: body.scope === 'client' ? (body.clientId ?? null) : null,
    });
    ctx.repos.audit.log({
      userId: admin.id,
      action: 'agent.create',
      target: created.id,
      details: { name: created.name, baseRole: created.baseRole },
      ip: ip(req),
    });
    return created;
  });

  app.patch('/admin/agents/:id', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const { id } = req.params as { id: string };
    if (!ctx.repos.customAgents.byId(id)) throw notFound('Specialist');
    const body = parse(CustomAgentInput.partial(), req.body);
    if (body.baseRole === 'orchestrator' || body.baseRole === 'summarizer') throw badRequest('baseRole must be a delegatable role');
    const updated = ctx.repos.customAgents.update(id, body);
    ctx.repos.audit.log({ userId: admin.id, action: 'agent.update', target: id, details: { fields: Object.keys(body) }, ip: ip(req) });
    return updated;
  });

  app.delete('/admin/agents/:id', async (req) => {
    const admin = requireRole(req, 'superadmin');
    const { id } = req.params as { id: string };
    ctx.repos.customAgents.delete(id);
    ctx.repos.audit.log({ userId: admin.id, action: 'agent.delete', target: id, ip: ip(req) });
    return { ok: true };
  });
}
