import { workspaceArchive, auditArchive } from '../session-export.js';
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  BrowserCaptureResponse,
  CreateSessionRequest,
  SendMessageRequest,
  ConfirmRequest,
  FeedbackRequest,
  CommitRequest,
  type SessionEvent,
} from '@sf-claws/shared';
import { inferComponentFromPath } from '@sf-claws/shared';
import type { AppContext } from '../../app-context.js';
import { parse } from '../validate.js';
import { requireUser } from '../context.js';
import { accessibleClientIds, isClientAdmin, requireClientAccess, requireOrgAccess } from '../access.js';
import { notFound, forbidden, badRequest } from '../../lib/errors.js';
import { hasRole } from '../../auth/service.js';
import { validateXml } from '../../salesforce/metadata-xml.js';
import { normalizePath } from '../../agents/tools.js';
import { publicOrg } from './orgs.js';

export async function sessionRoutes(app: FastifyInstance, ctx: AppContext) {
  /**
   * Who may open a session: a member of the session's client who is its owner, a client admin,
   * a platform admin or a super admin. Membership is checked first and outlives ownership: a
   * user removed from a client loses their old sessions there too.
   */
  const access = (req: any) => {
    const s = ctx.repos.sessions.byId(req.params.id);
    if (!s) throw notFound('Session');
    const user = requireClientAccess(ctx, req, s.clientId);
    if (s.userId !== user.id && !isClientAdmin(ctx, user, s.clientId)) throw forbidden('Not your session');
    return { user, session: s };
  };

  app.post('/sessions', async (req, reply) => {
    const body = parse(CreateSessionRequest, req.body);
    const { user } = requireOrgAccess(ctx, req, body.orgId);
    const s = ctx.runtime.createSession({ userId: user.id, ...body });
    reply.status(201);
    return s;
  });

  app.get('/sessions', async (req) => {
    const user = requireUser(req);
    const q = parse(
      z.object({
        mine: z.string().optional(),
        clientId: z.string().optional(),
        orgId: z.string().optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().max(500).optional(),
      }),
      req.query,
    );
    if (q.orgId) requireOrgAccess(ctx, req, q.orgId);
    if (q.clientId) requireClientAccess(ctx, req, q.clientId);
    const mine = q.mine === '1' || !hasRole(user, 'admin');
    const filter = { userId: mine ? user.id : undefined, orgId: q.orgId, status: q.status as any, limit: q.limit };
    if (q.clientId) return ctx.repos.sessions.list({ ...filter, clientId: q.clientId });
    // Unscoped: one query per client the caller belongs to, so an admin without a membership
    // sees nothing rather than everything.
    const ids = accessibleClientIds(ctx, user);
    if (ids === 'all') return ctx.repos.sessions.list(filter);
    return ids
      .flatMap((clientId) => ctx.repos.sessions.list({ ...filter, clientId }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, q.limit ?? 50);
  });

  app.get('/sessions/:id', async (req) => {
    const { session } = access(req);
    const org = ctx.repos.orgs.byId(session.orgId)!;
    return {
      session,
      org: publicOrg(org),
      client: ctx.repos.clients.byId(session.clientId),
      project: session.projectId ? (ctx.repos.projects.byId(session.projectId) ?? null) : null,
      task: session.taskId ? (ctx.repos.tasks.byId(session.taskId) ?? null) : null,
      workspace: ctx.repos.workspace.list(session.id),
      deploys: ctx.repos.deploys.list(session.id),
      docs: ctx.repos.docs.bySession(session.id),
      pendingConfirmations: ctx.repos.confirmations.pending(session.id).map((c) => ({ id: c.id, kind: c.kind, title: c.title, ...c.payload })),
      lastSeq: ctx.repos.events.lastSeq(session.id),
      running: ctx.runtime.isRunning(session.id),
      canDownloadAudit: isClientAdmin(ctx, requireUser(req), session.clientId),
    };
  });

  app.patch('/sessions/:id', async (req) => {
    const { session } = access(req);
    const body = parse(
      z.object({
        title: z.string().min(1).optional(),
        projectId: z.string().nullable().optional(),
        taskId: z.string().nullable().optional(),
        excludedFromMemory: z.boolean().optional(),
      }),
      req.body,
    );
    return ctx.repos.sessions.update(session.id, body);
  });

  /**
   * The panel answering a browser.request event. Owner-or-admin like every other session route:
   * console and network recordings are the user's own page activity and must not be postable by
   * anyone else. An unknown requestId means the tool already timed out — accepted quietly, since
   * there is nothing for the caller to do about it.
   */
  app.post('/sessions/:id/browser-capture', async (req) => {
    const { session } = access(req);
    const body = parse(BrowserCaptureResponse, req.body);
    return { ok: true, delivered: ctx.runtime.resolveBrowserCapture(session.id, body) };
  });

  app.post('/sessions/:id/messages', async (req, reply) => {
    const { user, session } = access(req);
    const body = parse(SendMessageRequest, req.body);
    let text = body.text;
    if (body.attachments?.length) {
      const parts = body.attachments
        .filter((a) => a.mimeType.startsWith('text/') || /json|xml|csv/.test(a.mimeType))
        .map((a) => `\n\n[Attachment ${a.name}]\n${Buffer.from(a.dataBase64, 'base64').toString('utf8').slice(0, 50_000)}`);
      text += parts.join('');
    }
    if (body.pageContext) ctx.runtime.updatePageContext(session.id, body.pageContext);
    ctx.runtime.startTurn(session.id, user.id, text);
    reply.status(202);
    return { ok: true, status: 'running' };
  });

  app.post('/sessions/:id/confirm', async (req) => {
    const { user, session } = access(req);
    const body = parse(ConfirmRequest, req.body);
    return ctx.runtime.confirm(session.id, body.confirmationId, body.optionId, user.id, body.answerText ?? null);
  });

  app.post('/sessions/:id/cancel', async (req) => {
    const { user, session } = access(req);
    ctx.runtime.cancel(session.id, user.id);
    return { ok: true };
  });

  /**
   * Compact the conversation on demand. Owner-or-admin like every session route, and refused while
   * a turn is running — the orchestrator is writing to the conversation this rewrites.
   */
  app.post('/sessions/:id/compact', async (req) => {
    const { session } = access(req);
    return ctx.runtime.compactSession(session.id);
  });

  app.post('/sessions/:id/feedback', async (req) => {
    const { user, session } = access(req);
    const body = parse(FeedbackRequest, req.body);
    const s = ctx.repos.sessions.update(session.id, { helpful: body.helpful, feedbackNote: body.note ?? null });
    ctx.repos.audit.log({ userId: user.id, action: 'session.feedback', target: session.id, details: body });
    return s;
  });

  app.post('/sessions/:id/complete', async (req) => {
    const { session } = access(req);
    if (ctx.runtime.isRunning(session.id)) throw badRequest('Session is running');
    return ctx.runtime.completeSession(session.id);
  });

  app.get('/sessions/:id/history', async (req) => {
    const { session } = access(req);
    const q = parse(z.object({ after: z.coerce.number().int().min(0).default(0), through: z.coerce.number().int().min(0).optional() }), req.query);
    return ctx.repos.events.listAfter(session.id, q.after, 5000, q.through);
  });

  /** Lossless persisted-event export, bounded to a watermark captured before streaming. */
  app.get('/sessions/:id/export', async (req, reply) => {
    const { session } = access(req);
    const throughSeq = ctx.repos.events.lastSeq(session.id);
    reply
      .type('application/x-ndjson')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="session-${session.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.ndjson"`);
    async function* lines() {
      yield JSON.stringify({
        type: 'export.manifest',
        version: 1,
        sessionId: session.id,
        throughSeq,
        exportedAt: new Date().toISOString(),
        excludedEphemeralTypes: ['assistant.delta', 'assistant.thinking'],
      }) + '\n';
      let after = 0;
      while (!reply.raw.destroyed) {
        const page = ctx.repos.events.listAfter(session.id, after, 500, throughSeq);
        if (!page.length) break;
        for (const event of page) yield JSON.stringify(event) + '\n';
        after = page[page.length - 1].seq;
        if (after >= throughSeq) break;
      }
    }
    return reply.send(Readable.from(lines()));
  });

  app.get('/sessions/:id/workspace/export', async (req, reply) => {
    const { user, session } = access(req);
    const archive = workspaceArchive(ctx, session.id);
    ctx.repos.audit.log({ userId: user.id, action: 'workspace.export', target: session.id });
    reply
      .type('application/zip')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="workspace-${session.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip"`);
    return reply.send(await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  });

  app.get('/sessions/:id/audit/export', async (req, reply) => {
    const { user, session } = access(req);
    if (!isClientAdmin(ctx, user, session.clientId)) throw forbidden('Admin access required for session audit downloads');
    ctx.repos.audit.log({ userId: user.id, action: 'session.audit.export', target: session.id });
    const archive = auditArchive(ctx, session.id);
    reply
      .type('application/zip')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="audit-${session.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip"`);
    return reply.send(await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  });

  /** Server-Sent Events stream; replays events after ?after= then streams live. */
  app.get('/sessions/:id/events', async (req, reply) => {
    const { session } = access(req);
    const q = parse(z.object({ after: z.coerce.number().int().default(0) }), req.query);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(req.headers.origin ? { 'Access-Control-Allow-Origin': req.headers.origin, 'Access-Control-Allow-Credentials': 'true' } : {}),
    });
    const send = (ev: SessionEvent) => {
      reply.raw.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    let last = q.after;
    for (const ev of ctx.repos.events.listAfter(session.id, q.after)) {
      send(ev);
      last = ev.seq;
    }
    const unsub = ctx.runtime.bus.subscribe(session.id, (ev) => {
      if (ev.seq > last || ev.type === 'assistant.delta' || ev.type === 'assistant.thinking') {
        send(ev);
        if (ev.seq > last) last = ev.seq;
      }
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ lastSeq: last, running: ctx.runtime.isRunning(session.id) })}\n\n`);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsub();
    });
    await new Promise<void>((resolve) => req.raw.on('close', () => resolve()));
    return reply;
  });

  // ---- workspace ----
  app.get('/sessions/:id/workspace', async (req) => {
    const { session } = access(req);
    return ctx.repos.workspace.list(session.id);
  });
  app.put('/sessions/:id/workspace/file', async (req) => {
    const { user, session } = access(req);
    if (ctx.runtime.isRunning(session.id)) throw badRequest('Cannot edit files while the session is running');
    const body = parse(z.object({ path: z.string().min(1), content: z.string() }), req.body);
    const path = normalizePath(body.path);
    if (path.includes('..')) throw badRequest('Invalid path');
    if (path.endsWith('.xml')) {
      const err = validateXml(body.content);
      if (err) throw badRequest(`XML is not well-formed: ${err}`);
    }
    const inferred = inferComponentFromPath(path);
    const rules = ctx.policy.effective(session.clientId);
    const v = ctx.policy.checkComponent(rules, inferred?.metadataType ?? null, inferred?.fullName ?? null);
    if (v) throw forbidden(v.message, 'POLICY');
    const existing = ctx.repos.workspace.get(session.id, path);
    const refusal = ctx.runtime.workspaceWriteRefusal(session.id, { path, metadataType: null, fullName: null }, false);
    if (refusal) throw badRequest(refusal);
    ctx.repos.workspace.upsert(session.id, {
      path,
      content: body.content,
      original: existing?.original ?? null,
      metadataType: existing?.metadataType ?? inferred?.metadataType ?? null,
      fullName: existing?.fullName ?? inferred?.fullName ?? null,
      action: existing?.action ?? 'created',
    });
    ctx.runtime.markWorkspaceDirty(session.id);
    ctx.runtime.noteWorkspaceChange(session.id, path);
    ctx.runtime.bus.emit(session.id, {
      type: 'workspace.file',
      path,
      action: existing ? 'modified' : 'created',
      metadataType: inferred?.metadataType ?? null,
      fullName: inferred?.fullName ?? null,
    });
    ctx.repos.audit.log({ userId: user.id, action: 'workspace.edit', target: session.id, details: { path } });
    return ctx.repos.workspace.get(session.id, path);
  });
  app.delete('/sessions/:id/workspace/file', async (req) => {
    const { session } = access(req);
    if (ctx.runtime.isRunning(session.id)) throw badRequest('Cannot edit files while the session is running');
    const q = parse(z.object({ path: z.string() }), req.query);
    const refusal = ctx.runtime.workspaceWriteRefusal(session.id, { path: normalizePath(q.path), metadataType: null, fullName: null }, false);
    if (refusal) throw badRequest(refusal);
    ctx.repos.workspace.remove(session.id, normalizePath(q.path));
    ctx.runtime.noteWorkspaceChange(session.id, normalizePath(q.path));
    ctx.runtime.markWorkspaceDirty(session.id);
    ctx.runtime.bus.emit(session.id, { type: 'workspace.file', path: normalizePath(q.path), action: 'deleted', metadataType: null, fullName: null });
    return { ok: true };
  });

  // ---- deploys ----
  app.get('/sessions/:id/checkpoints', async (req) => {
    const { session } = access(req);
    return ctx.repos.harness.list(session.id).map(({ workspace, control, payload, ...summary }) => summary);
  });
  app.get('/sessions/:id/checkpoints/:checkpointId', async (req) => {
    const { session } = access(req);
    const checkpoint = ctx.repos.harness.get(session.id, (req.params as { checkpointId: string }).checkpointId);
    if (!checkpoint) throw notFound('Checkpoint');
    return { checkpoint, attempts: ctx.repos.harness.attempts(session.id, checkpoint.id) };
  });
  app.get('/sessions/:id/hydration', async (req) => {
    const { session } = access(req);
    return ctx.repos.harness.hydration(session.id) ?? null;
  });
  app.post('/sessions/:id/checkpoints/:checkpointId/reconcile', async (req) => {
    const { user, session } = access(req);
    if (ctx.runtime.isRunning(session.id)) throw badRequest('Stop the session before reconciling an archived job');
    const checkpointId = (req.params as { checkpointId: string }).checkpointId;
    await ctx.runtime.reconcileCheckpoint(session.id, checkpointId);
    ctx.repos.audit.log({ userId: user.id, action: 'checkpoint.reconciled', target: session.id, details: { checkpointId } });
    return { ok: true };
  });
  app.get('/sessions/:id/deploys', async (req) => {
    const { session } = access(req);
    return ctx.repos.deploys.list(session.id);
  });
  app.get('/sessions/:id/deploys/:deployId/export', async (req, reply) => {
    const { session } = access(req);
    const deployId = (req.params as { deployId: string }).deployId;
    const run = ctx.repos.deploys.list(session.id).find((d) => d.id === deployId);
    if (!run) throw notFound('Validation');
    const checkpoints = ctx.repos.harness
      .list(session.id, Number.MAX_SAFE_INTEGER)
      .filter((c) => c.deployId === run.id)
      .map((checkpoint) => ({ checkpoint, attempts: ctx.repos.harness.attempts(session.id, checkpoint.id) }));
    reply
      .type('application/json')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="validation-${run.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json"`);
    return { run, checkpoints };
  });
  app.post('/sessions/:id/validate', async (req) => {
    const { user, session } = access(req);
    if (ctx.runtime.isRunning(session.id)) throw badRequest('Session is running; the agent will validate');
    const body = parse(
      z.object({
        testLevel: z.enum(['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg']).optional(),
        runTests: z.array(z.string()).optional(),
      }),
      req.body ?? {},
    );
    const run = await ctx.runtime.validate(session.id, body);
    ctx.runtime.repairManualValidation(session.id, user.id, run);
    return run;
  });
  // Deploy and commit run the same permission rules as the agent path (`checkCommand` inside
  // executeDeploy/executeCommit): a deny rule has to stop the human pressing the button too.
  app.post('/sessions/:id/deploy', async (req) => {
    const { user, session } = access(req);
    if (ctx.runtime.isRunning(session.id)) throw badRequest('Session is running; the agent will ask for confirmation');
    const ready = ctx.runtime.readyToDeploy(session.id);
    if (!ready.ok) throw badRequest(ready.reason!);
    // The panel shows its own confirm dialog (exact command + plain-language summary) before
    // calling this route, so the authenticated user IS the confirmation; executeDeploy still
    // re-checks policy so a deny rule stops this path exactly as it stops the agent's.
    return ctx.runtime.executeDeploy(session.id, user.id, { confirmedBy: user.id });
  });
  app.post('/sessions/:id/commit', async (req) => {
    const { user, session } = access(req);
    if (ctx.runtime.isRunning(session.id)) throw badRequest('Session is running; the agent will ask for confirmation');
    const body = parse(CommitRequest, req.body ?? {});
    const message = body.message?.trim() || `Harness: ${session.title}`.slice(0, 72);
    return ctx.runtime.executeCommit(session.id, user.id, message, !!body.createPullRequest, { confirmedBy: user.id });
  });
  app.get('/sessions/:id/docs', async (req) => {
    const { session } = access(req);
    return ctx.repos.docs.bySession(session.id);
  });
  app.get('/sessions/:id/todos', async (req) => {
    const { session } = access(req);
    return ctx.repos.todos.get(session.id);
  });
  app.get('/sessions/:id/notes', async (req) => {
    const { session } = access(req);
    return ctx.repos.notes.list(session.id);
  });
  app.get('/sessions/:id/snapshot', async (req) => {
    const { session } = access(req);
    return ctx.runtime.snapshot(session.id);
  });
  app.post('/sessions/:id/resume', async (req, reply) => {
    const { user, session } = access(req);
    ctx.runtime.resume(session.id, user.id);
    reply.status(202);
    return { ok: true, status: 'running' };
  });
  app.get('/sessions/:id/permissions', async (req) => {
    const { session } = access(req);
    return ctx.repos.permissions.list(session.id);
  });
  app.delete('/sessions/:id/permissions/:command', async (req) => {
    const { session } = access(req);
    ctx.repos.permissions.revoke(session.id, (req.params as any).command);
    return { ok: true };
  });
  app.get('/docs/:docId', async (req) => {
    const d = ctx.repos.docs.byId((req.params as any).docId);
    if (!d) throw notFound('Doc');
    const user = requireClientAccess(ctx, req, d.clientId);
    const s = ctx.repos.sessions.byId(d.sessionId);
    if (s && s.userId !== user.id && !isClientAdmin(ctx, user, s.clientId)) throw forbidden('Not your session');
    return d;
  });
}
