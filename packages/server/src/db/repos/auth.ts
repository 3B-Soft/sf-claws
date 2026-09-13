import type { User, UserRole, UserStatus, UiMode, AuditEntry } from '@sf-claws/shared';
import { type Db, nowIso, rowToObj } from '../db.js';
import { newId } from '../../lib/crypto.js';

export interface UserRow extends User {
  passwordHash: string;
}

const USER_COLS = 'id, email, display_name, role, status, ui_mode, created_at, approved_at, approved_by, last_seen_at';

export class UsersRepo {
  constructor(private db: Db) {}
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM users').get() as any).c;
  }
  list(): User[] {
    return this.db
      .prepare(`SELECT ${USER_COLS} FROM users ORDER BY created_at`)
      .all()
      .map((r) => rowToObj<User>(r));
  }
  byId(id: string): User | undefined {
    return rowToObj<User>(this.db.prepare(`SELECT ${USER_COLS} FROM users WHERE id=?`).get(id));
  }
  byEmail(email: string): (User & { passwordHash: string }) | undefined {
    return rowToObj(this.db.prepare(`SELECT ${USER_COLS}, password_hash FROM users WHERE email=?`).get(email));
  }
  create(input: { email: string; displayName: string; passwordHash: string; role: UserRole; status: UserStatus }): User {
    const id = newId('usr');
    const now = nowIso();
    this.db
      .prepare(`INSERT INTO users (id, email, display_name, password_hash, role, status, ui_mode, created_at, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, 'visual', ?, ?)`)
      .run(id, input.email.toLowerCase(), input.displayName, input.passwordHash, input.role, input.status, now, input.status === 'active' ? now : null);
    return this.byId(id)!;
  }
  update(
    id: string,
    patch: Partial<{
      role: UserRole;
      status: UserStatus;
      displayName: string;
      uiMode: UiMode;
      approvedBy: string;
      approvedAt: string;
      lastSeenAt: string;
      passwordHash: string;
    }>,
  ): User | undefined {
    const map: Record<string, string> = {
      role: 'role',
      status: 'status',
      displayName: 'display_name',
      uiMode: 'ui_mode',
      approvedBy: 'approved_by',
      approvedAt: 'approved_at',
      lastSeenAt: 'last_seen_at',
      passwordHash: 'password_hash',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]}=?`);
      vals.push(v);
    }
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    return this.byId(id);
  }
  touch(id: string): void {
    this.db.prepare('UPDATE users SET last_seen_at=? WHERE id=?').run(nowIso(), id);
  }
}

export class TokensRepo {
  constructor(private db: Db) {}
  create(input: { jti: string; userId: string; kind: 'web' | 'extension'; expiresAt: string; userAgent?: string }): void {
    this.db
      .prepare('INSERT INTO auth_tokens (id, user_id, kind, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.jti, input.userId, input.kind, nowIso(), input.expiresAt, input.userAgent ?? null);
  }
  isActive(jti: string): boolean {
    const r = this.db.prepare('SELECT revoked_at, expires_at FROM auth_tokens WHERE id=?').get(jti) as any;
    return !!r && !r.revoked_at && r.expires_at > nowIso();
  }
  revoke(jti: string): void {
    this.db.prepare('UPDATE auth_tokens SET revoked_at=? WHERE id=?').run(nowIso(), jti);
  }
  revokeAllForUser(userId: string): void {
    this.db.prepare('UPDATE auth_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(nowIso(), userId);
  }
  purgeExpired(): void {
    this.db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(nowIso());
  }
}

export class DeviceCodesRepo {
  constructor(private db: Db) {}
  create(code: string, expiresAt: string): void {
    this.db.prepare('INSERT INTO device_codes (code, created_at, expires_at) VALUES (?, ?, ?)').run(code, nowIso(), expiresAt);
  }
  get(code: string): { code: string; expiresAt: string; approvedUserId: string | null; token: string | null; consumedAt: string | null } | undefined {
    return rowToObj(this.db.prepare('SELECT code, expires_at, approved_user_id, token, consumed_at FROM device_codes WHERE code=?').get(code));
  }
  approve(code: string, userId: string, token: string): void {
    this.db.prepare('UPDATE device_codes SET approved_user_id=?, token=? WHERE code=?').run(userId, token, code);
  }
  consume(code: string): void {
    this.db.prepare('UPDATE device_codes SET consumed_at=?, token=NULL WHERE code=?').run(nowIso(), code);
  }
  purgeExpired(): void {
    this.db.prepare('DELETE FROM device_codes WHERE expires_at < ?').run(nowIso());
  }
}

export class AuditRepo {
  constructor(private db: Db) {}
  log(entry: { userId?: string | null; action: string; target?: string | null; details?: unknown; ip?: string | null }): void {
    this.db
      .prepare('INSERT INTO audit_log (id, at, user_id, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        newId('aud'),
        nowIso(),
        entry.userId ?? null,
        entry.action,
        entry.target ?? null,
        entry.details === undefined ? null : JSON.stringify(entry.details),
        entry.ip ?? null,
      );
  }
  list(limit = 200): AuditEntry[] {
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?')
      .all(limit)
      .map((r) => rowToObj<AuditEntry>(r, { json: ['details'] }));
  }
}

/**
 * Wrapped per-tenant data keys for envelope encryption (see lib/crypto.ts). The wrapped key is
 * useless without the server master key, so storing it beside the data it protects is safe.
 */
export class TenantKeysRepo {
  constructor(private db: Db) {}
  get(keyId: string): string | undefined {
    const r = this.db.prepare('SELECT wrapped_key FROM tenant_keys WHERE key_id=?').get(keyId) as { wrapped_key: string } | undefined;
    return r?.wrapped_key;
  }
  put(keyId: string, wrappedKey: string): void {
    this.db
      .prepare(`INSERT INTO tenant_keys (key_id, wrapped_key, created_at) VALUES (?, ?, ?)
      ON CONFLICT(key_id) DO UPDATE SET wrapped_key=excluded.wrapped_key, rotated_at=excluded.created_at`)
      .run(keyId, wrappedKey, nowIso());
  }
}
