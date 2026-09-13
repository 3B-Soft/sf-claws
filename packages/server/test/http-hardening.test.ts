import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildApp, isEventStreamRequest } from '../src/http/app.js';
import { createLogger, redactUrl, serializeRequest } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { makeContext, testConfig } from './helpers.js';

describe('rate limiter allow list', () => {
  it('matches the event stream on the routed path, never on the query string', () => {
    expect(isEventStreamRequest({ url: '/api/v1/sessions/abc/events?after=0&token=x' })).toBe(true);
    expect(isEventStreamRequest({ url: '/api/v1/auth/login?x=/events' })).toBe(false);
    expect(isEventStreamRequest({ url: '/api/v1/auth/login', routeOptions: { url: '/api/v1/auth/login' } })).toBe(false);
    expect(isEventStreamRequest({ url: '/api/v1/sessions/abc/events', routeOptions: { url: '/api/v1/sessions/:id/events' } })).toBe(true);
    expect(isEventStreamRequest({ url: '/api/v1/sessions/abc/events/extra' })).toBe(false);
  });

  describe('against the app', () => {
    let app: FastifyInstance;
    const ctx = makeContext();
    beforeAll(async () => {
      app = await buildApp(ctx);
      await app.ready();
    });
    afterAll(async () => {
      await app.close();
    });

    it('still throttles the login route when the query string mentions /events', async () => {
      let last = 0;
      for (let i = 0; i < 21; i++) {
        const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login?x=/events', payload: { email: 'nobody@t.io', password: 'wrong-password' } });
        last = r.statusCode;
      }
      expect(last).toBe(429);
    });

    it('does not accept ?token= outside the event stream', async () => {
      const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'a@t.io', password: 'password12345', displayName: 'A' } });
      const token = reg.json().token;
      const viaQuery = await app.inject({ method: 'GET', url: `/api/v1/auth/me?token=${token}` });
      expect(viaQuery.statusCode).toBe(401);
      const viaHeader = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
      expect(viaHeader.statusCode).toBe(200);
    });
  });
});

describe('access log redaction', () => {
  it('replaces credential query parameters and keeps the rest', () => {
    expect(redactUrl('/api/v1/sessions/s1/events?after=3&token=eyJhbGc.x.y')).toBe('/api/v1/sessions/s1/events?after=3&token=[REDACTED]');
    expect(redactUrl('/api/v1/oauth/salesforce/callback?code=abc&state=def')).toBe('/api/v1/oauth/salesforce/callback?code=[REDACTED]&state=[REDACTED]');
    expect(redactUrl('/api/v1/clients?x=1')).toBe('/api/v1/clients?x=1');
    expect(redactUrl('/api/v1/clients')).toBe('/api/v1/clients');
  });

  it('is wired into the logger as the request serializer', () => {
    const log = createLogger('info', false);
    const serializers = (log as any)[pino.symbols.serializersSym];
    const out = serializers.req({ method: 'GET', url: '/api/v1/sessions/s1/events?token=secret-jwt', headers: {}, ip: '127.0.0.1' });
    expect(JSON.stringify(out)).not.toContain('secret-jwt');
    expect(out.url).toContain('token=[REDACTED]');
    expect(serializeRequest({ method: 'POST', url: '/x?token=t', ip: '1.2.3.4' })).toMatchObject({
      method: 'POST',
      url: '/x?token=[REDACTED]',
      remoteAddress: '1.2.3.4',
    });
  });
});

describe('trust proxy', () => {
  it('defaults off and parses the usual truthy spellings', () => {
    expect(testConfig().TRUST_PROXY).toBe(false);
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) expect(loadConfig({ ...overrides(), TRUST_PROXY: v }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ ...overrides(), TRUST_PROXY: '0' }).TRUST_PROXY).toBe(false);
  });

  it('ignores X-Forwarded-For unless the flag is on', async () => {
    const seen: string[] = [];
    const build = async (trust: boolean) => {
      const ctx = makeContext();
      ctx.config.TRUST_PROXY = trust;
      const app = await buildApp(ctx);
      app.get('/whoami', async (req) => {
        seen.push(req.ip);
        return { ip: req.ip };
      });
      await app.ready();
      const r = await app.inject({ method: 'GET', url: '/whoami', headers: { 'x-forwarded-for': '203.0.113.9' }, remoteAddress: '10.0.0.1' });
      await app.close();
      return r.json().ip as string;
    };
    expect(await build(false)).toBe('10.0.0.1');
    expect(await build(true)).toBe('203.0.113.9');
  });
});

function overrides() {
  return {
    MASTER_KEY: 'dGVzdG1hc3RlcmtleXRlc3RtYXN0ZXJrZXl0ZXN0bWFzdGVyaw==',
    JWT_SECRET: 'test-jwt-secret-value',
    DATA_DIR: '/tmp/sf-claws-test',
    LOG_LEVEL: 'error',
  };
}
