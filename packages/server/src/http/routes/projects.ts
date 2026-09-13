import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateProjectRequest, CreateTaskRequest, UpdateTaskRequest, TaskStatus } from '@sf-claws/shared';
import type { AppContext } from '../../app-context.js';
import { parse } from '../validate.js';
import { requireRole, requireUser } from '../context.js';
import { accessibleClientIds, filterAccessible, requireClientAccess, requireOrgAccess } from '../access.js';
import { notFound, badRequest } from '../../lib/errors.js';

export async function projectRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Projects and tasks are client-owned through the project; every addressed route resolves that client first. */
  const projectFor = (req: any, projectId: string) => {
    const p = ctx.repos.projects.byId(projectId);
    if (!p) throw notFound('Project');
    requireClientAccess(ctx, req, p.clientId);
    return p;
  };
  const taskFor = (req: any, taskId: string) => {
    const t = ctx.repos.tasks.byId(taskId);
    if (!t) throw notFound('Task');
    projectFor(req, t.projectId);
    return t;
  };

  app.get('/projects', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ clientId: z.string().optional() }), req.query);
    if (q.clientId) {
      requireClientAccess(ctx, req, q.clientId);
      return ctx.repos.projects.list(q.clientId);
    }
    // Listing across clients is an inventory action: admins see the clients they belong to, a
    // super admin sees everything, a plain user must say which client.
    if (user.role === 'user') throw badRequest('clientId is required');
    return filterAccessible(ctx, user, ctx.repos.projects.listAll());
  });
  app.post('/projects', async (req, reply) => {
    const user = requireRole(req, 'user');
    const body = parse(CreateProjectRequest, req.body);
    requireClientAccess(ctx, req, body.clientId);
    const p = ctx.repos.projects.create(body);
    ctx.repos.audit.log({ userId: user.id, action: 'project.create', target: p.id });
    reply.status(201);
    return p;
  });
  app.patch('/projects/:id', async (req) => {
    projectFor(req, (req.params as any).id);
    const body = parse(
      z.object({ name: z.string().optional(), description: z.string().nullable().optional(), status: z.enum(['active', 'archived']).optional() }),
      req.body,
    );
    const p = ctx.repos.projects.update((req.params as any).id, body);
    if (!p) throw notFound('Project');
    return p;
  });
  app.delete('/projects/:id', async (req) => {
    projectFor(req, (req.params as any).id);
    requireRole(req, 'admin');
    ctx.repos.projects.delete((req.params as any).id);
    return { ok: true };
  });

  app.get('/tasks', async (req) => {
    const user = requireUser(req);
    const q = parse(
      z.object({ projectId: z.string().optional(), orgId: z.string().optional(), assigneeId: z.string().optional(), status: TaskStatus.optional() }),
      req.query,
    );
    // At least one filter: an unfiltered task list would span every client in the deployment.
    if (!q.projectId && !q.orgId && !q.assigneeId) throw badRequest('Provide projectId, orgId or assigneeId');
    if (q.projectId) projectFor(req, q.projectId);
    if (q.orgId) requireOrgAccess(ctx, req, q.orgId);
    const rows = ctx.repos.tasks.list(q);
    // An assignee filter alone can cross clients; keep only the tasks whose project the caller may see.
    const ids = accessibleClientIds(ctx, user);
    if (ids === 'all') return rows;
    const allowed = new Set(ids);
    return rows.filter((t) => allowed.has(ctx.repos.projects.byId(t.projectId)?.clientId ?? ''));
  });
  app.post('/tasks', async (req, reply) => {
    requireRole(req, 'user');
    const body = parse(CreateTaskRequest, req.body);
    projectFor(req, body.projectId);
    reply.status(201);
    return ctx.repos.tasks.create(body);
  });
  app.patch('/tasks/:id', async (req) => {
    taskFor(req, (req.params as any).id);
    const body = parse(UpdateTaskRequest, req.body);
    const t = ctx.repos.tasks.update((req.params as any).id, body);
    if (!t) throw notFound('Task');
    return t;
  });
  app.delete('/tasks/:id', async (req) => {
    taskFor(req, (req.params as any).id);
    requireRole(req, 'admin');
    ctx.repos.tasks.delete((req.params as any).id);
    return { ok: true };
  });
}
