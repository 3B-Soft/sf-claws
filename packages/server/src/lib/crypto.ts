import crypto from 'node:crypto';

/** Prefix-free, URL safe, time-sortable-ish ids. */
export function newId(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(9).toString('base64url');
  return prefix ? `${prefix}_${t}${r}` : `${t}${r}`;
}

export function randomCode(len = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, built in — no native addon needed)
// ---------------------------------------------------------------------------
const SCRYPT_N = 16384,
  SCRYPT_R = 8,
  SCRYPT_P = 1,
  KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(password, salt, Number(parts[1]), Number(parts[2]), Number(parts[3]));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function scrypt(password: string, salt: Buffer, N = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// ---------------------------------------------------------------------------
// Secrets at rest
// ---------------------------------------------------------------------------

/**
 * Envelope encryption.
 *
 * Every secret is encrypted with AES-256-GCM. Which key does the encrypting is the interesting
 * part: a value written for a specific tenant is encrypted with that tenant's own data key, and
 * only that data key is wrapped by the server master key. One leaked ciphertext, or one tenant's
 * compromised data key, therefore exposes one tenant rather than all of them, and a tenant's key
 * can be rotated without touching anyone else's rows.
 *
 * Two ciphertext formats coexist deliberately:
 *   v1.<iv>.<tag>.<data>            — encrypted directly with the master key
 *   v2.<keyId>.<iv>.<tag>.<data>    — encrypted with the tenant data key identified by keyId
 *
 * v1 stays readable forever so an existing deployment keeps working after an upgrade; new tenant
 * secrets are written as v2.
 */
export interface TenantKeyStore {
  /** The wrapped data key for a tenant, or undefined when none has been created yet. */
  get(keyId: string): string | undefined;
  put(keyId: string, wrappedKey: string): void;
}

export class SecretBox {
  private masterKey: Buffer;
  /** Unwrapped tenant data keys, cached for the process lifetime. */
  private tenantKeys = new Map<string, Buffer>();

  constructor(
    masterKey: string,
    private keyStore?: TenantKeyStore,
  ) {
    // Accept base64 (32 bytes) or any string (derived via sha256).
    const b = Buffer.from(masterKey, 'base64');
    this.masterKey = b.length === 32 ? b : crypto.createHash('sha256').update(masterKey).digest();
  }

  /** Encrypt with the master key (server-wide secrets: provider keys, knowledge source tokens). */
  encrypt(plain: string): string {
    return seal(this.masterKey, plain, 'v1');
  }

  /**
   * Encrypt with a tenant's own data key. Use for anything belonging to one client — Salesforce
   * refresh tokens, GitHub tokens — so the blast radius of a key compromise is one tenant.
   */
  encryptFor(keyId: string, plain: string): string {
    const key = this.tenantKey(keyId, true);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v2.${keyId}.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
  }

  /** Decrypt either format; the ciphertext says which key it needs. */
  decrypt(boxed: string): string {
    const parts = boxed.split('.');
    if (parts[0] === 'v1') return open(this.masterKey, parts[1], parts[2], parts[3]);
    if (parts[0] === 'v2') {
      const key = this.tenantKey(parts[1], false);
      if (!key) throw new Error(`No data key "${parts[1]}" — this secret cannot be decrypted on this server.`);
      return open(key, parts[2], parts[3], parts[4]);
    }
    throw new Error('Unsupported secret format');
  }

  /**
   * Replace a tenant's data key. Existing ciphertexts stay readable only if callers re-encrypt
   * them, so this is a deliberate operation: rotate, then rewrite that tenant's secrets.
   */
  rotateTenantKey(keyId: string): void {
    if (!this.keyStore) throw new Error('No tenant key store configured');
    const fresh = crypto.randomBytes(32);
    this.keyStore.put(keyId, seal(this.masterKey, fresh.toString('base64'), 'v1'));
    this.tenantKeys.set(keyId, fresh);
  }

  private tenantKey(keyId: string, createIfMissing: true): Buffer;
  private tenantKey(keyId: string, createIfMissing: false): Buffer | undefined;
  private tenantKey(keyId: string, createIfMissing: boolean): Buffer | undefined {
    const cached = this.tenantKeys.get(keyId);
    if (cached) return cached;
    if (!this.keyStore) throw new Error('No tenant key store configured — cannot use per-tenant encryption');
    const wrapped = this.keyStore.get(keyId);
    if (wrapped) {
      const key = Buffer.from(this.decryptWithMaster(wrapped), 'base64');
      this.tenantKeys.set(keyId, key);
      return key;
    }
    if (!createIfMissing) return undefined;
    const fresh = crypto.randomBytes(32);
    this.keyStore.put(keyId, seal(this.masterKey, fresh.toString('base64'), 'v1'));
    this.tenantKeys.set(keyId, fresh);
    return fresh;
  }

  private decryptWithMaster(boxed: string): string {
    const [, ivB, tagB, encB] = boxed.split('.');
    return open(this.masterKey, ivB, tagB, encB);
  }
}

function seal(key: Buffer, plain: string, version: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${version}.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

function open(key: Buffer, ivB: string, tagB: string, encB: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

/** PKCE helpers for Salesforce OAuth. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
