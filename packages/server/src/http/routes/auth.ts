import type { FastifyInstance } from 'fastify';
import { RegisterRequest, LoginRequest, SetProviderRequest, AiProvider } from '@sf-claws/shared';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { parse } from '../validate.js';
import { requireUser, ip } from '../context.js';
import { HttpError } from '../../lib/errors.js';

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/auth/register', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const body = parse(RegisterRequest, req.body);
    const r = await ctx.auth.register(body);
    reply.status(201);
    return r.token ? { token: r.token, user: r.user, expiresAt: r.expiresAt } : { user: r.user, pending: true };
  });

  app.post('/auth/login', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const body = parse(LoginRequest, req.body);
    return ctx.auth.login(body.email, body.password, req.headers['user-agent']);
  });

  app.get('/auth/me', async (req) => requireUser(req));

  app.post('/auth/logout', async (req) => {
    if (req.auth) ctx.auth.logout(req.auth.jti);
    return { ok: true };
  });

  app.patch('/auth/me', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ displayName: z.string().min(1).optional(), uiMode: z.enum(['visual', 'pro']).optional() }), req.body);
    return ctx.repos.users.update(user.id, body);
  });

  app.post('/auth/change-password', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string().min(10) }), req.body);
    await ctx.auth.login(user.email, body.currentPassword).catch(() => {
      throw new HttpError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    });
    const { hashPassword } = await import('../../lib/crypto.js');
    ctx.repos.users.update(user.id, { passwordHash: await hashPassword(body.newPassword) });
    ctx.repos.tokens.revokeAllForUser(user.id);
    return { ok: true };
  });

  // ---- Device pairing for the Chrome extension ----
  app.post('/auth/device/start', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async () => ctx.auth.startDevice());

  app.post('/auth/device/approve', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ code: z.string().min(4) }), req.body);
    await ctx.auth.approveDevice(body.code, user);
    ctx.repos.audit.log({ userId: user.id, action: 'auth.device_approve', target: body.code, ip: ip(req) });
    return { ok: true };
  });

  app.get('/auth/device/poll', async (req, reply) => {
    const q = parse(z.object({ code: z.string().min(4) }), req.query);
    const r = ctx.auth.pollDevice(q.code);
    if (r.status === 'pending') return reply.status(202).send({ status: 'pending' });
    return { token: r.token, user: r.user, expiresAt: r.expiresAt };
  });

  // ---- a user's own AI provider keys ----
  // Optional: when set, this user's sessions bill and rate-limit against their own provider
  // account instead of the platform key. Never returns key material, only whether one exists.
  app.get('/me/providers', async (req) => {
    const user = requireUser(req);
    const mine = new Map(ctx.repos.providers.listForUser(user.id).map((p) => [p.provider, p]));
    return AiProvider.options.map((provider) => ({
      provider,
      hasKey: mine.has(provider),
      baseUrl: mine.get(provider)?.baseUrl ?? null,
      updatedAt: mine.get(provider)?.updatedAt ?? null,
      /** True when the platform has a key this user would otherwise fall back to. */
      platformFallback: ctx.ai.hasKey(provider),
    }));
  });

  app.put('/me/providers/:provider', async (req) => {
    const user = requireUser(req);
    const provider = parse(AiProvider, (req.params as { provider: string }).provider);
    const body = parse(SetProviderRequest, req.body);
    ctx.repos.providers.set(provider, ctx.secrets.encrypt(body.apiKey), body.baseUrl ?? null, user.id, user.id);
    ctx.ai.invalidate(user.id);
    ctx.repos.audit.log({ userId: user.id, action: 'provider.user_key_set', target: provider, ip: ip(req) });
    return { ok: true };
  });

  app.delete('/me/providers/:provider', async (req) => {
    const user = requireUser(req);
    const provider = parse(AiProvider, (req.params as { provider: string }).provider);
    ctx.repos.providers.delete(provider, user.id);
    ctx.ai.invalidate(user.id);
    ctx.repos.audit.log({ userId: user.id, action: 'provider.user_key_clear', target: provider, ip: ip(req) });
    return { ok: true };
  });
}
