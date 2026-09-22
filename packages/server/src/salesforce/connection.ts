import jsforce, { type Connection, type OAuth2 } from 'jsforce';
import type { Repos, OrgRow } from '../db/repos/index.js';
import type { Config } from '../config.js';
import type { SecretBox } from '../lib/crypto.js';
import type { Logger } from '../logger.js';
import { HttpError } from '../lib/errors.js';

/** Default Metadata/REST API version for orgs that have not opted into `max`. */
export const DEFAULT_API_VERSION = '62.0';
/** The sentinel an org stores as `apiVersion` to track the latest version its instance offers. */
export const API_VERSION_MAX = 'max';

/** Highest version in a `/services/data` listing, as Salesforce formats it (`"63.0"`). */
export function latestApiVersion(listing: { version: string }[]): string | null {
  const versions = listing.map((v) => Number(v.version)).filter((n) => Number.isFinite(n));
  return versions.length ? Math.max(...versions).toFixed(1) : null;
}

/**
 * Creates jsforce connections for registered orgs using stored (encrypted) OAuth tokens and
 * persists refreshed access tokens. One Connection per org is cached per process.
 */
export class ConnectionManager {
  private cache = new Map<string, Connection>();
  private browserSessions = new Map<string, { accessToken: string; instanceUrl: string; salesforceUserId: string }>();
  private maxVersions = new Map<string, { version: string; at: number }>();
  constructor(
    private repos: Repos,
    private config: Config,
    private secrets: SecretBox,
    private log: Logger,
  ) {}

  /**
   * OAuth client for an org's own Connected App. An org saved without a consumer key falls back to
   * the server-wide SF_CLIENT_ID/SECRET; the secret never mixes across the two, since a refresh token
   * only works with the app that issued it.
   */
  oauth2(org: OrgRow, codeVerifier?: string): OAuth2 {
    const clientId = org.consumerKey || this.config.SF_CLIENT_ID;
    if (!clientId) throw new HttpError(400, 'SF_NOT_CONFIGURED', `Org "${org.label}" has no Connected App Consumer Key. Add one to the org before connecting.`);
    let clientSecret = this.config.SF_CLIENT_SECRET || undefined;
    if (org.consumerKey) {
      const enc = this.repos.orgs.secrets(org.id).consumerSecretEnc;
      clientSecret = enc ? this.secrets.decrypt(enc) : undefined;
    }
    const o = new jsforce.OAuth2({
      clientId,
      clientSecret,
      redirectUri: `${this.config.PUBLIC_URL}/api/v1/oauth/salesforce/callback`,
      loginUrl: org.loginUrl,
    });
    if (codeVerifier) o.codeVerifier = codeVerifier;
    return o;
  }

  invalidate(orgId: string): void {
    this.cache.delete(orgId);
  }

  /** Browser session IDs deliberately live in process memory only. */
  setBrowserSession(orgId: string, accessToken: string, instanceUrl: string, salesforceUserId: string): void {
    this.cache.delete(orgId);
    this.browserSessions.set(orgId, { accessToken, instanceUrl: instanceUrl.replace(/\/$/, ''), salesforceUserId });
  }

  browserSessionUser(orgId: string): string | null {
    return this.browserSessions.get(orgId)?.salesforceUserId ?? null;
  }

  clearBrowserSession(orgId: string): void {
    this.cache.delete(orgId);
    this.browserSessions.delete(orgId);
  }

  async forOrg(orgId: string): Promise<{ conn: Connection; org: OrgRow }> {
    const org = this.repos.orgs.byId(orgId);
    if (!org) throw new HttpError(404, 'NOT_FOUND', 'Org not found');
    const cached = this.cache.get(orgId);
    if (cached) return { conn: cached, org };
    const client = this.repos.clients.byId(org.clientId);
    if (client?.salesforceAuthMode === 'browser_session') {
      const session = this.browserSessions.get(orgId);
      if (!session)
        throw new HttpError(409, 'BROWSER_SESSION_REQUIRED', `Open "${org.label}" in Salesforce and reopen SF Claws so it can use the active browser session.`);
      const conn = new jsforce.Connection({
        instanceUrl: session.instanceUrl,
        accessToken: session.accessToken,
        version: await this.resolveApiVersion(orgId, org.apiVersion, session.instanceUrl),
        maxRequest: 50,
      });
      conn.on('error', (err: Error) => this.log.warn({ orgId, err: err.message }, 'Salesforce browser-session connection error'));
      this.cache.set(orgId, conn);
      return { conn, org };
    }
    const secrets = this.repos.orgs.secrets(orgId);
    if (!secrets.refreshTokenEnc || !org.instanceUrl)
      throw new HttpError(409, 'ORG_DISCONNECTED', `Org "${org.label}" is not connected. Ask an admin to connect it.`);
    const conn = new jsforce.Connection({
      oauth2: this.oauth2(org),
      instanceUrl: org.instanceUrl,
      accessToken: secrets.accessTokenEnc ? this.secrets.decrypt(secrets.accessTokenEnc) : undefined,
      refreshToken: this.secrets.decrypt(secrets.refreshTokenEnc),
      version: await this.resolveApiVersion(orgId, org.apiVersion, org.instanceUrl),
      maxRequest: 50,
    });
    conn.on('refresh', (accessToken: string) => {
      this.repos.orgs.update(orgId, { accessTokenEnc: this.secrets.encryptFor(org.clientId, accessToken), status: 'connected', lastError: null });
      this.log.info({ orgId }, 'Salesforce access token refreshed');
    });
    conn.on('error', (err: Error) => this.log.warn({ orgId, err: err.message }, 'Salesforce connection error'));
    this.cache.set(orgId, conn);
    return { conn, org };
  }

  /**
   * The API version a connection runs at. A numeric `apiVersion` is used as stored (62.0 by
   * default, so nothing changes for existing orgs). The sentinel `max` asks the instance for the
   * latest version it offers (`/services/data`, unauthenticated) and caches the answer per org for
   * an hour; when that lookup fails the default applies rather than blocking the connection.
   */
  async resolveApiVersion(orgId: string, configured: string, instanceUrl: string): Promise<string> {
    if (configured !== API_VERSION_MAX) return configured;
    const cached = this.maxVersions.get(orgId);
    if (cached && Date.now() - cached.at < 60 * 60_000) return cached.version;
    try {
      const res = await fetch(`${instanceUrl.replace(/\/$/, '')}/services/data`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const version = latestApiVersion((await res.json()) as { version: string }[]);
      if (!version) throw new Error('no versions listed');
      this.maxVersions.set(orgId, { version, at: Date.now() });
      return version;
    } catch (e) {
      this.log.warn({ orgId, err: (e as Error).message }, `Could not resolve the org's maximum API version; using ${DEFAULT_API_VERSION}`);
      return DEFAULT_API_VERSION;
    }
  }

  /** Mark org expired if the refresh token was revoked. */
  handleAuthError(orgId: string, err: unknown): void {
    const msg = String((err as any)?.message ?? err);
    if (/invalid_grant|expired access\/refresh token|INVALID_SESSION_ID|inactive user/i.test(msg)) {
      this.repos.orgs.update(orgId, { status: 'expired', lastError: msg });
      this.cache.delete(orgId);
      this.browserSessions.delete(orgId);
    }
  }
}
