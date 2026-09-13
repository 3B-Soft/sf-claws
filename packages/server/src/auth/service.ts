import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { User, UserRole } from '@sf-claws/shared';
import type { Repos } from '../db/repos/index.js';
import type { Config } from '../config.js';
import { hashPassword, verifyPassword, newId, randomCode } from '../lib/crypto.js';
import { HttpError, unauthorized, forbidden, badRequest, notFound } from '../lib/errors.js';

export interface AuthContext {
  user: User;
  jti: string;
}

export class AuthService {
  private secret: Uint8Array;
  constructor(
    private repos: Repos,
    private config: Config,
  ) {
    this.secret = new TextEncoder().encode(config.JWT_SECRET);
  }

  /** First user becomes super admin (unless bootstrap admin env is configured). Others are pending. */
  async register(input: { email: string; password: string; displayName: string }): Promise<{ user: User; token?: string; expiresAt?: string }> {
    if (this.repos.users.byEmail(input.email)) throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    const first = this.repos.users.count() === 0;
    const user = this.repos.users.create({
      email: input.email,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      role: first ? 'superadmin' : 'user',
      status: first ? 'active' : 'pending',
    });
    this.repos.audit.log({ userId: user.id, action: first ? 'auth.bootstrap_superadmin' : 'auth.register', target: user.email });
    if (first) {
      const t = await this.issueToken(user, 'web');
      return { user, ...t };
    }
    return { user };
  }

  async login(email: string, password: string, userAgent?: string): Promise<{ user: User; token: string; expiresAt: string }> {
    const row = this.repos.users.byEmail(email);
    if (!row || !(await verifyPassword(password, row.passwordHash))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    if (row.status === 'pending') throw new HttpError(403, 'USER_PENDING', 'Your account is awaiting approval by an administrator');
    if (row.status === 'disabled') throw new HttpError(403, 'USER_DISABLED', 'Your account has been disabled');
    const { passwordHash: _ph, ...user } = row;
    this.repos.users.touch(user.id);
    this.repos.audit.log({ userId: user.id, action: 'auth.login', target: user.email });
    const t = await this.issueToken(user, 'web', userAgent);
    return { user, ...t };
  }

  async issueToken(user: User, kind: 'web' | 'extension', userAgent?: string): Promise<{ token: string; expiresAt: string }> {
    const jti = newId('tok');
    const exp = new Date(Date.now() + this.config.JWT_TTL_HOURS * 3600_000);
    const token = await new SignJWT({ role: user.role, kind })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(Math.floor(exp.getTime() / 1000))
      .setIssuer('sf-claws')
      .sign(this.secret);
    this.repos.tokens.create({ jti, userId: user.id, kind, expiresAt: exp.toISOString(), userAgent });
    return { token, expiresAt: exp.toISOString() };
  }

  async verify(token: string): Promise<AuthContext> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.secret, { issuer: 'sf-claws' }));
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    const jti = payload.jti as string;
    const sub = payload.sub as string;
    if (!jti || !sub || !this.repos.tokens.isActive(jti)) throw unauthorized('Token revoked or expired');
    const user = this.repos.users.byId(sub);
    if (!user) throw unauthorized('User no longer exists');
    if (user.status !== 'active')
      throw forbidden(
        user.status === 'pending' ? 'Account awaiting approval' : 'Account disabled',
        user.status === 'pending' ? 'USER_PENDING' : 'USER_DISABLED',
      );
    return { user, jti };
  }

  logout(jti: string): void {
    this.repos.tokens.revoke(jti);
  }

  // ---- device pairing (Chrome extension) ----
  startDevice(): { code: string; expiresAt: string; verifyUrl: string } {
    this.repos.deviceCodes.purgeExpired();
    const code = randomCode(8);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.repos.deviceCodes.create(code, expiresAt);
    return { code, expiresAt, verifyUrl: `${this.config.PUBLIC_URL}/pair?code=${code}` };
  }
  async approveDevice(code: string, user: User): Promise<void> {
    const dc = this.repos.deviceCodes.get(code.toUpperCase());
    if (!dc || dc.expiresAt < new Date().toISOString() || dc.consumedAt) throw notFound('Pairing code');
    if (dc.approvedUserId) throw badRequest('Code already approved');
    const t = await this.issueToken(user, 'extension');
    this.repos.deviceCodes.approve(dc.code, user.id, t.token);
    this.repos.audit.log({ userId: user.id, action: 'auth.device_approved', target: dc.code });
  }
  pollDevice(code: string): { status: 'pending' } | { status: 'approved'; token: string; user: User; expiresAt: string } {
    const dc = this.repos.deviceCodes.get(code.toUpperCase());
    if (!dc || dc.consumedAt) throw notFound('Pairing code');
    if (dc.expiresAt < new Date().toISOString()) throw new HttpError(410, 'CODE_EXPIRED', 'Pairing code expired');
    if (!dc.approvedUserId || !dc.token) return { status: 'pending' };
    const user = this.repos.users.byId(dc.approvedUserId)!;
    this.repos.deviceCodes.consume(dc.code);
    return { status: 'approved', token: dc.token, user, expiresAt: new Date(Date.now() + this.config.JWT_TTL_HOURS * 3600_000).toISOString() };
  }

  async bootstrapAdminIfConfigured(): Promise<void> {
    const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: password } = this.config;
    if (!email || !password || this.repos.users.byEmail(email)) return;
    this.repos.users.create({ email, displayName: 'Super Admin', passwordHash: await hashPassword(password), role: 'superadmin', status: 'active' });
    this.repos.audit.log({ action: 'auth.bootstrap_superadmin', target: email });
  }
}

export const ROLE_RANK: Record<UserRole, number> = { user: 1, admin: 2, superadmin: 3 };
export function hasRole(user: User, min: UserRole): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[min];
}
