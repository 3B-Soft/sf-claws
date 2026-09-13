import type { FastifyRequest } from 'fastify';
import type { User, UserRole } from '@sf-claws/shared';
import { forbidden, unauthorized } from '../lib/errors.js';
import { hasRole } from '../auth/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { user: User; jti: string };
  }
}

export function requireUser(req: FastifyRequest): User {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}
export function requireRole(req: FastifyRequest, min: UserRole): User {
  const u = requireUser(req);
  if (!hasRole(u, min)) throw forbidden(`Requires ${min} role`);
  return u;
}
/**
 * Client IP for the audit log. Fastify already resolves X-Forwarded-For into `req.ip` when
 * TRUST_PROXY is on; reading the header here directly would honour it even when it is off, which
 * is exactly the spoof the flag exists to prevent.
 */
export function ip(req: FastifyRequest): string {
  return req.ip;
}
