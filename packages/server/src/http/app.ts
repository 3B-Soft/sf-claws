import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { API_PREFIX } from '@sf-claws/shared';
import type { AppContext } from '../app-context.js';
import { HttpError } from '../lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { clientRoutes } from './routes/clients.js';
import { orgRoutes } from './routes/orgs.js';
import { githubRoutes } from './routes/github.js';
import { skillRoutes } from './routes/skills.js';
import { projectRoutes } from './routes/projects.js';
import { sessionRoutes } from './routes/sessions.js';

/**
 * Is this request for a session event stream? Decided on the routed path (or, before routing,
 * the parsed pathname), never on the raw URL: `req.url.includes('/events')` also matched the
 * query string, so `POST /auth/login?x=/events` skipped both the global and the login limiter.
 */
export function isEventStreamRequest(req: { url: string; routeOptions?: { url?: string } }): boolean {
  const routed = req.routeOptions?.url;
  const path = routed ?? new URL(req.url, 'http://localhost').pathname;
  return /^\/api\/v1\/sessions\/[^/]+\/events$/.test(path) || routed === `${API_PREFIX}/sessions/:id/events`;
}

export interface BuildAppOptions {
  /** Observe every registered route (tests walk the route table with it). */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

export async function buildApp(ctx: AppContext, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: ctx.log as any, trustProxy: ctx.config.TRUST_PROXY, bodyLimit: 25 * 1024 * 1024 });
  if (opts.onRoute) app.addHook('onRoute', (route) => opts.onRoute!({ method: route.method, url: route.url }));

  await app.register(cors, () => (req: any, cb: (err: Error | null, opts: Record<string, unknown>) => void) => {
    // Allowed: no Origin (same-origin navigation), the server's own origin (module scripts send Origin),
    // PUBLIC_URL, configured origins and any Chrome extension.
    const origin = req.headers.origin;
    const self = `${req.protocol}://${req.headers.host}`;
    if (!origin || origin === self || origin === ctx.config.PUBLIC_URL || corsAllows(ctx.config.corsOrigins, origin))
      return cb(null, { origin: true, credentials: true });
    cb(new HttpError(403, 'CORS_DENIED', `Origin ${origin} not allowed`), { origin: false });
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', allowList: (req) => isEventStreamRequest(req) });

  // Auth: bearer header, or ?token= on the event stream only (EventSource cannot set headers)
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    let token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token && (req.query as any)?.token && isEventStreamRequest(req)) token = String((req.query as any).token);
    if (!token) return;
    try {
      req.auth = await ctx.auth.verify(token);
    } catch (e) {
      // Only enforce on API routes; static assets are public.
      if (req.url.startsWith(API_PREFIX) && !req.url.startsWith(`${API_PREFIX}/health`)) throw e;
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err?.validation || err?.statusCode === 400) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    if (err?.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    req.log.error({ err }, 'Unhandled error');
    const message = ctx.config.NODE_ENV === 'production' ? 'Internal server error' : String(err?.message ?? err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message } });
  });

  app.get(`${API_PREFIX}/health`, async () => ({
    ok: true,
    version: ctx.config.version,
    setupRequired: ctx.repos.users.count() === 0,
    time: new Date().toISOString(),
  }));

  await app.register(
    async (api) => {
      await authRoutes(api, ctx);
      await adminRoutes(api, ctx);
      await clientRoutes(api, ctx);
      await orgRoutes(api, ctx);
      await githubRoutes(api, ctx);
      await skillRoutes(api, ctx);
      await projectRoutes(api, ctx);
      await sessionRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );

  // Serve the built admin UI (SPA) if configured. /pair?code= is handled by the SPA.
  const dist = ctx.config.ADMIN_UI_DIST ? path.resolve(process.cwd(), ctx.config.ADMIN_UI_DIST) : '';
  if (dist && fs.existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith(API_PREFIX)) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
      return reply.type('text/html').send(fs.readFileSync(path.join(dist, 'index.html')));
    });
    ctx.log.info({ dist }, 'Serving admin UI');
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  }

  return app;
}

export function corsAllows(allowed: string[], origin: string): boolean {
  if (origin.startsWith('chrome-extension://')) return true;
  if (allowed.includes('*')) return true;
  return allowed.some((a) => a === origin || (a.startsWith('*.') && origin.endsWith(a.slice(1))));
}
