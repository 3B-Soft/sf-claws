import type { FastifyRequest } from 'fastify';
import type { User } from '@sf-claws/shared';
import type { AppContext } from '../app-context.js';
import type { OrgRow } from '../db/repos/index.js';
import { forbidden, notFound } from '../lib/errors.js';
import { requireUser } from './context.js';

/**
 * Client membership checks for HTTP routes.
 *
 * The rule is small enough to state in one line: a super admin belongs to every client; everyone
 * else, platform admins included, belongs only to the clients they have been added to. Every route
 * that is addressed by an org id, a client id or a session id goes through one of these helpers,
 * and `test/tenant-isolation.test.ts` walks the route table to prove it.
 *
 * The check runs before body validation on purpose: a non-member must get the same answer whether
 * or not their payload was well formed, so the response never leaks which route shapes exist.
 */

export function isSuperAdmin(user: User): boolean {
  return user.role === 'superadmin';
}

/** Client ids this user may see, or `'all'` for a super admin. */
export function accessibleClientIds(ctx: AppContext, user: User): string[] | 'all' {
  return isSuperAdmin(user) ? 'all' : ctx.repos.clientMembers.clientIdsForUser(user.id);
}

export function canAccessClient(ctx: AppContext, user: User, clientId: string): boolean {
  return isSuperAdmin(user) || !!ctx.repos.clientMembers.get(user.id, clientId);
}

/** A client-level admin sees every session of that client, not only their own. Super admins and platform admins already do. */
export function isClientAdmin(ctx: AppContext, user: User, clientId: string): boolean {
  if (isSuperAdmin(user) || user.role === 'admin') return true;
  return ctx.repos.clientMembers.get(user.id, clientId)?.role === 'admin';
}

/** Filter any list of client-owned rows down to what the caller may see. */
export function filterAccessible<T extends { clientId: string }>(ctx: AppContext, user: User, rows: T[]): T[] {
  const ids = accessibleClientIds(ctx, user);
  if (ids === 'all') return rows;
  const set = new Set(ids);
  return rows.filter((r) => set.has(r.clientId));
}

/** Authenticated caller who is a member of `clientId` (or a super admin). 404 for an unknown client, 403 for a non-member. */
export function requireClientAccess(ctx: AppContext, req: FastifyRequest, clientId: string): User {
  const user = requireUser(req);
  if (!ctx.repos.clients.byId(clientId)) throw notFound('Client');
  if (!canAccessClient(ctx, user, clientId)) throw forbidden('You are not a member of this client', 'NOT_A_MEMBER');
  return user;
}

/** Org variant: resolves the org, then checks membership of the client that owns it. */
export function requireOrgAccess(ctx: AppContext, req: FastifyRequest, orgId: string): { user: User; org: OrgRow } {
  const user = requireUser(req);
  const org = ctx.repos.orgs.byId(orgId);
  if (!org) throw notFound('Org');
  if (!canAccessClient(ctx, user, org.clientId)) throw forbidden('You are not a member of this client', 'NOT_A_MEMBER');
  return { user, org };
}
