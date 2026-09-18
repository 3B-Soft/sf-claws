import JSZip from 'jszip';
import type { Connection } from 'jsforce';
import type { DeployFailure, OrgKind, OrgLimits, WorkspaceFile } from '@sf-claws/shared';
import {
  resolveToolingMembers,
  submitToolingCompile,
  pollToolingCompile,
  reconcileToolingContainer,
  type ToolingMember,
  type ToolingJob,
} from './tooling-compile.js';
import { SourceFormatRegistry } from '@sf-claws/shared';
import type { Repos } from '../db/repos/index.js';
import type { Config } from '../config.js';
import type { SecretBox } from '../lib/crypto.js';
import type { Logger } from '../logger.js';
import { ConnectionManager } from './connection.js';
export { API_VERSION_MAX, DEFAULT_API_VERSION, latestApiVersion } from './connection.js';
import { buildDeployPackage, mdapiZipToSource } from './sdr.js';
import type { SourceFile } from './sdr.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { newId, pkcePair } from '../lib/crypto.js';

export interface QueryResult {
  totalSize: number;
  done: boolean;
  records: Record<string, unknown>[];
  columns: string[];
}
export interface DeployOutcome {
  ok: boolean;
  sfDeployId: string;
  status: string;
  checkOnly: boolean;
  componentsTotal: number;
  componentsDeployed: number;
  componentsFailed: number;
  testsTotal: number;
  testsFailed: number;
  /**
   * Coverage over the classes this run touched, from the result's `codeCoverage` entries. It is
   * not the number Salesforce holds production to — that is `orgWideCoverage`.
   */
  runCoverage: number | null;
  /** @deprecated Same value as `runCoverage`; kept until every caller reads the honest name. */
  codeCoverage: number | null;
  /**
   * `ApexOrgWideCoverage.PercentCovered` after a RunLocalTests or RunAllTestsInOrg run. Null when
   * the run did not execute a test level that refreshes it, or when the query failed.
   */
  orgWideCoverage: number | null;
  /**
   * The id to hand to `quickDeploy` — set on a successful check-only deploy that ran tests.
   * Salesforce keeps a validation usable for Quick Deploy for ten days.
   */
  validationId: string | null;
  /** True when the deploy was cancelled (by timeout, by the caller's signal or in Setup). */
  cancelled: boolean;
  failures: DeployFailure[];
  testFailures: { name: string; method: string | null; message: string; stackTrace: string | null }[];
  coverageWarnings: string[];
  errorMessage: string | null;
}
export type TestLevel = 'NoTestRun' | 'RunSpecifiedTests' | 'RunLocalTests' | 'RunAllTestsInOrg';

export interface DeployOptions {
  preparedZip?: Buffer;
  onSubmitted?: (id: string) => void;
  checkOnly: boolean;
  testLevel: TestLevel;
  runTests?: string[];
  deleted?: { type: string; fullName: string }[];
  onProgress?: (status: string) => void;
  /** Abort the poll and cancel the Salesforce deploy when this fires (session cancel, shutdown). */
  signal?: AbortSignal;
  /** How long to wait before cancelling the deploy. Default 30 minutes. */
  timeoutMs?: number;
}

/** What `completeOAuth` learned about the org, so the caller can set `kind` and `protected`. */
export interface OAuthCompletion {
  orgId: string;
  isSandbox: boolean;
  organizationType: string | null;
  /** The kind the org's own record implies; compare with what the admin registered. */
  detectedKind: OrgKind;
  /** True when the registered kind and the detected kind disagree on production status. */
  kindMismatch: boolean;
}

export class SalesforceService {
  readonly connections: ConnectionManager;
  constructor(
    private repos: Repos,
    config: Config,
    private secrets: SecretBox,
    private log: Logger,
  ) {
    this.connections = new ConnectionManager(repos, config, secrets, log);
  }

  // ------------------------------------------------------------------ OAuth
  startOAuth(orgId: string, userId: string): { url: string } {
    const org = this.repos.orgs.byId(orgId);
    if (!org) throw new HttpError(404, 'NOT_FOUND', 'Org not found');
    const { verifier } = pkcePair();
    const oauth2 = this.connections.oauth2(org, verifier);
    const state = newId('st');
    this.repos.oauthStates.create(state, orgId, userId, verifier);
    const url = oauth2.getAuthorizationUrl({ scope: 'api refresh_token web openid', state, prompt: 'login consent' } as any);
    return { url };
  }

  /**
   * Finish the OAuth web-server flow. The org's own record decides whether it is a sandbox; a
   * registered production org that turns out to be a sandbox (or the reverse) is refused unless
   * `allowKindMismatch` is set, because every deploy rule downstream keys off `kind`. The refusal
   * happens before any token is stored, so a mismatched org stays disconnected.
   */
  async completeOAuth(code: string, state: string, opts: { allowKindMismatch?: boolean } = {}): Promise<OAuthCompletion> {
    const st = this.repos.oauthStates.consume(state);
    if (!st) throw badRequest('OAuth state is invalid or expired. Start the connection again.');
    const org = this.repos.orgs.byId(st.orgId);
    if (!org) throw new HttpError(404, 'NOT_FOUND', 'Org not found');
    const oauth2 = this.connections.oauth2(org, st.codeVerifier);
    const jsforce = (await import('jsforce')).default;
    const conn = new jsforce.Connection({ oauth2, version: org.apiVersion });
    try {
      const userInfo = await conn.authorize(code);
      const identity = await conn.identity();
      const instanceUrl = conn.instanceUrl;
      const myDomainHost = new URL(instanceUrl).hostname;
      const info = await organizationInfo(conn);
      const detectedKind = detectOrgKind(info);
      const kindMismatch = orgKindConflict(org.kind, detectedKind);
      if (kindMismatch && !opts.allowKindMismatch) {
        const message = `Org "${org.label}" is registered as ${org.kind} but Salesforce reports ${describeOrg(info)}. Fix the org kind (or reconnect with the override) before connecting.`;
        this.repos.orgs.update(org.id, { status: 'error', lastError: message });
        throw new HttpError(409, 'ORG_KIND_MISMATCH', message, { detectedKind, isSandbox: info.isSandbox, organizationType: info.organizationType });
      }
      this.repos.orgs.update(org.id, {
        status: 'connected',
        sfOrgId: userInfo.organizationId,
        instanceUrl,
        myDomainHost,
        username: identity.username,
        lastConnectedAt: new Date().toISOString(),
        lastError: null,
        // Per-tenant key: one client's leaked ciphertext must not be decryptable alongside another's.
        accessTokenEnc: conn.accessToken ? this.secrets.encryptFor(org.clientId, conn.accessToken) : null,
        refreshTokenEnc: conn.refreshToken ? this.secrets.encryptFor(org.clientId, conn.refreshToken) : null,
      });
      if (kindMismatch) this.log.warn({ orgId: org.id, registered: org.kind, detectedKind }, 'Org kind mismatch accepted by override');
      this.connections.invalidate(org.id);
      this.repos.harness.invalidate(org.id);
      this.repos.audit.log({
        userId: st.userId,
        action: 'org.connected',
        target: org.id,
        details: { username: identity.username, sfOrgId: userInfo.organizationId, isSandbox: info.isSandbox, organizationType: info.organizationType },
      });
      return { orgId: org.id, isSandbox: info.isSandbox, organizationType: info.organizationType, detectedKind, kindMismatch };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      this.repos.orgs.update(org.id, { status: 'error', lastError: String((e as Error).message) });
      throw new HttpError(502, 'SF_OAUTH_FAILED', `Salesforce authorization failed: ${(e as Error).message}`);
    }
  }

  async disconnect(orgId: string): Promise<void> {
    const secrets = this.repos.orgs.secrets(orgId);
    const org = this.repos.orgs.byId(orgId);
    if (org && secrets.refreshTokenEnc) {
      try {
        await this.connections.oauth2(org).revokeToken(this.secrets.decrypt(secrets.refreshTokenEnc));
      } catch {
        /* best effort */
      }
    }
    this.repos.orgs.update(orgId, { status: 'disconnected', accessTokenEnc: null, refreshTokenEnc: null });
    this.connections.invalidate(orgId);
    this.repos.harness.invalidate(orgId);
  }

  async status(orgId: string): Promise<{ status: string; identity: unknown | null; error: string | null }> {
    const org = this.repos.orgs.byId(orgId);
    if (!org) throw new HttpError(404, 'NOT_FOUND', 'Org not found');
    if (org.status === 'disconnected') return { status: 'disconnected', identity: null, error: null };
    try {
      const { conn } = await this.connections.forOrg(orgId);
      const id = await conn.identity();
      this.repos.orgs.update(orgId, { status: 'connected', lastError: null });
      return {
        status: 'connected',
        identity: { username: id.username, displayName: id.display_name, orgId: id.organization_id, userId: id.user_id },
        error: null,
      };
    } catch (e) {
      this.connections.handleAuthError(orgId, e);
      return { status: this.repos.orgs.byId(orgId)?.status ?? 'error', identity: null, error: (e as Error).message };
    }
  }

  private async conn(orgId: string): Promise<Connection> {
    const { conn } = await this.connections.forOrg(orgId);
    return conn;
  }

  private wrap<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return fn().catch((e) => {
      this.connections.handleAuthError(orgId, e);
      const msg = (e as any)?.message ?? String(e);
      throw new HttpError(502, 'SF_ERROR', `Salesforce error: ${msg}`, { name: (e as any)?.name, errorCode: (e as any)?.errorCode });
    });
  }

  // ------------------------------------------------------------------ Data
  async query(orgId: string, soql: string, opts: { tooling?: boolean; limit?: number } = {}): Promise<QueryResult> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const api = opts.tooling ? conn.tooling : conn;
      const res: any = await api.query(soql, { autoFetch: true, maxFetch: opts.limit ?? 200 } as any);
      // Not `.map(flattenRecord)`: map's second argument is the row index, which flattenRecord
      // would take as the column prefix and return `0Id`, `1Id`...
      const records = (res.records ?? []).map((r: any) => flattenRecord(r));
      const columns = columnsFromSoql(soql, records);
      return { totalSize: res.totalSize, done: res.done, records, columns };
    });
  }

  async describeGlobal(orgId: string): Promise<{ name: string; label: string; custom: boolean; queryable: boolean; keyPrefix: string | null }[]> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const r = await conn.describeGlobal();
      return r.sobjects.map((s) => ({ name: s.name, label: s.label, custom: s.custom, queryable: s.queryable, keyPrefix: s.keyPrefix ?? null }));
    });
  }

  async describe(orgId: string, sobject: string): Promise<unknown> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const d = await conn.describe(sobject);
      return {
        name: d.name,
        label: d.label,
        labelPlural: d.labelPlural,
        custom: d.custom,
        keyPrefix: d.keyPrefix,
        createable: d.createable,
        updateable: d.updateable,
        deletable: d.deletable,
        recordTypeInfos: d.recordTypeInfos?.map((r) => ({
          name: r.name,
          developerName: (r as any).developerName,
          recordTypeId: r.recordTypeId,
          available: r.available,
          master: r.master,
        })),
        childRelationships: d.childRelationships
          ?.filter((c) => c.relationshipName)
          .map((c) => ({ childSObject: c.childSObject, field: c.field, relationshipName: c.relationshipName })),
        fields: d.fields.map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          length: f.length,
          precision: f.precision,
          scale: f.scale,
          custom: f.custom,
          nillable: f.nillable,
          createable: f.createable,
          updateable: f.updateable,
          calculated: f.calculated,
          calculatedFormula: (f as any).calculatedFormula ?? null,
          referenceTo: f.referenceTo,
          relationshipName: f.relationshipName,
          picklistValues: f.picklistValues?.filter((p) => p.active).map((p) => ({ label: p.label, value: p.value, default: p.defaultValue })),
          inlineHelpText: f.inlineHelpText,
          externalId: f.externalId,
          unique: f.unique,
          nameField: f.nameField,
          filterable: f.filterable,
          sortable: f.sortable,
        })),
      };
    });
  }

  async createRecord(orgId: string, sobject: string, fields: Record<string, unknown>): Promise<{ id: string }> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const r: any = await conn.sobject(sobject).create(fields);
      if (!r.success) throw new Error(JSON.stringify(r.errors));
      return { id: r.id };
    });
  }
  async updateRecord(orgId: string, sobject: string, id: string, fields: Record<string, unknown>): Promise<void> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const r: any = await conn.sobject(sobject).update({ Id: id, ...fields });
      if (!r.success) throw new Error(JSON.stringify(r.errors));
    });
  }

  async deleteRecord(orgId: string, sobject: string, id: string): Promise<void> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const r: any = await conn.sobject(sobject).destroy(id);
      if (!r.success) throw new Error(JSON.stringify(r.errors));
    });
  }

  /** Org limits (REST /limits) normalised with usage percentages and warnings. Cached for 60s. */
  async limits(orgId: string, warnPercent = 80, force = false): Promise<OrgLimits> {
    const cached = this.repos.limits.get(orgId);
    if (cached && !force && Date.now() - Date.parse(cached.fetchedAt) < 60_000) return cached;
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const raw: Record<string, { Max: number; Remaining: number }> = (await conn.limits()) as any;
      const limits = Object.entries(raw)
        .filter(([, v]) => v && typeof v.Max === 'number' && v.Max > 0)
        .map(([name, v]) => {
          const usedPercent = Math.round(((v.Max - v.Remaining) / v.Max) * 1000) / 10;
          return { name, max: v.Max, remaining: v.Remaining, usedPercent, warning: usedPercent >= warnPercent };
        })
        .sort((a, b) => b.usedPercent - a.usedPercent);
      const warnings = limits
        .filter((l) => l.warning)
        .map((l) => `${l.name}: ${l.usedPercent}% used (${l.remaining.toLocaleString()} of ${l.max.toLocaleString()} remaining)`);
      const snap: OrgLimits = { orgId, fetchedAt: new Date().toISOString(), limits, warnings };
      this.repos.limits.set(orgId, snap);
      return snap;
    });
  }

  // --------------------------------------------------------------- Metadata
  async describeMetadata(
    orgId: string,
  ): Promise<{ xmlName: string; directoryName: string; suffix: string | null; inFolder: boolean; metaFile: boolean; childXmlNames: string[] }[]> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const r = await conn.metadata.describe();
      return r.metadataObjects
        .map((m) => ({
          xmlName: m.xmlName,
          directoryName: m.directoryName,
          suffix: m.suffix ?? null,
          inFolder: m.inFolder,
          metaFile: m.metaFile,
          childXmlNames: (m.childXmlNames as string[]) ?? [],
        }))
        .sort((a, b) => a.xmlName.localeCompare(b.xmlName));
    });
  }

  async listMetadata(
    orgId: string,
    type: string,
    folder?: string,
  ): Promise<
    {
      fullName: string;
      fileName: string;
      id: string;
      lastModifiedByName: string;
      lastModifiedDate: string;
      manageableState: string | null;
      namespacePrefix: string | null;
    }[]
  > {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const r: any = await conn.metadata.list([{ type, folder } as any]);
      const arr = Array.isArray(r) ? r : r ? [r] : [];
      return arr
        .map((p: any) => ({
          fullName: p.fullName,
          fileName: p.fileName,
          id: p.id,
          lastModifiedByName: p.lastModifiedByName,
          lastModifiedDate: p.lastModifiedDate,
          manageableState: p.manageableState ?? null,
          namespacePrefix: p.namespacePrefix ?? null,
        }))
        .sort((a: any, b: any) => a.fullName.localeCompare(b.fullName));
    });
  }

  /**
   * Retrieve components as source-format files.
   *
   * A Profile only carries permissions for components that are in the same retrieve request, so
   * asking for a Profile on its own returns a near-empty skeleton. When the request includes
   * Profiles, `related` (the workspace's objects, classes and fields, when the caller has them) is
   * added to the manifest; without it the request falls back to `*` for the types a Profile most
   * often references. Either way only the types the caller asked for are returned, unless
   * `keepRelated` is set. See `profileRetrieveTypes` for the trade-off.
   */
  async retrieve(
    orgId: string,
    components: { type: string; members: string[] }[],
    opts: { related?: { type: string; members: string[] }[]; keepRelated?: boolean } = {},
  ): Promise<SourceFile[]> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const apiVersion = conn.version;
      const types = profileRetrieveTypes(components, opts.related);
      const locator = conn.metadata.retrieve({
        apiVersion: Number(apiVersion),
        singlePackage: true,
        unpackaged: { types, version: apiVersion } as any,
      } as any);
      const start: any = await locator;
      const id: string = start.id;
      const deadline = Date.now() + 5 * 60_000;
      let result: any;
      for (;;) {
        result = await conn.metadata.checkRetrieveStatus(id);
        if (result.done === true || result.done === 'true') break;
        if (Date.now() > deadline) throw new Error('Retrieve timed out');
        await sleep(1500);
      }
      if (result.success === false || result.success === 'false') throw new Error(result.errorMessage ?? 'Retrieve failed');
      if (!result.zipFile) return [];
      // SDR reads the archive directly, so binary members and bundle layouts are handled by the
      // same code Salesforce's own CLI uses rather than by our path heuristics.
      const files = await mdapiZipToSource(await unwrapRetrieveZip(Buffer.from(result.zipFile, 'base64')));
      if (opts.keepRelated || types.length === components.length) return files;
      return onlyRequestedTypes(files, components);
    });
  }

  /** Read one component's source-format XML (first matching file). */
  async readComponent(orgId: string, type: string, fullName: string): Promise<SourceFile[]> {
    return this.retrieve(orgId, [{ type, members: [fullName] }]);
  }

  /**
   * Deploy (or validate with checkOnly) a set of source-format files. Polls until done and
   * returns a normalized outcome. Past `timeoutMs` (default 30 minutes) or when `signal` aborts,
   * the Salesforce deploy is cancelled and the outcome reports `cancelled` rather than an error —
   * an abandoned poll would otherwise leave Salesforce finishing a deploy nobody is watching.
   */
  async deploy(orgId: string, files: SourceFile[], opts: DeployOptions): Promise<DeployOutcome> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const buffer = opts.preparedZip ?? (await buildDeployPackage(files, conn.version, opts.deleted ?? [])).zipBuffer;
      const locator = conn.metadata.deploy(buffer, {
        checkOnly: opts.checkOnly,
        testLevel: opts.testLevel,
        runTests: opts.runTests ?? [],
        rollbackOnError: true,
        singlePackage: true,
        ignoreWarnings: false,
        allowMissingFiles: false,
        autoUpdatePackage: false,
        performRetrieve: false,
        purgeOnDelete: false,
      });
      const start: any = await locator;
      opts.onSubmitted?.(start.id);
      return this.finishDeploy(conn, start.id, opts);
    }).finally(() => {
      if (!opts.checkOnly) this.repos.harness.invalidate(orgId);
    });
  }

  async prepareDeploy(orgId: string, files: SourceFile[], deleted: { type: string; fullName: string }[]): Promise<string> {
    const org = this.repos.orgs.byId(orgId)!;
    return (await buildDeployPackage(files, org.apiVersion, deleted)).zipBuffer.toString('base64');
  }
  async prepareToolingCompile(orgId: string, files: WorkspaceFile[]): Promise<ToolingMember[] | null> {
    if (this.repos.orgs.byId(orgId)?.kind === 'production') return null;
    return this.wrap(orgId, async () => resolveToolingMembers(await this.conn(orgId), files));
  }
  async toolingCompile(
    orgId: string,
    members: ToolingMember[],
    callbacks: { onContainer: (id: string) => void; onSubmitted: (id: string) => void; onProgress?: (message: string) => void },
  ): Promise<DeployOutcome> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const job = await submitToolingCompile(conn, members, callbacks.onContainer);
      callbacks.onSubmitted(job.id);
      return pollToolingCompile(conn, job, callbacks);
    });
  }
  async resumeValidation(orgId: string, engine: 'metadata' | 'tooling', id: string, opts: DeployOptions & { containerId?: string }): Promise<DeployOutcome> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      return engine === 'metadata' ? this.finishDeploy(conn, id, opts) : pollToolingCompile(conn, { id, containerId: opts.containerId! }, opts);
    });
  }
  async findToolingJob(orgId: string, containerId: string): Promise<ToolingJob | null> {
    return this.wrap(orgId, async () => reconcileToolingContainer(await this.conn(orgId), containerId));
  }
  async cleanupToolingContainer(orgId: string, containerId: string): Promise<void> {
    await this.wrap(orgId, async () => {
      await (await this.conn(orgId)).tooling.sobject('MetadataContainer').destroy(containerId);
    });
  }

  /**
   * Quick Deploy: deploy the components a check-only run already validated, without re-running
   * its tests. Salesforce accepts the validation id for ten days, provided the validation ran
   * tests (RunLocalTests, RunAllTestsInOrg or RunSpecifiedTests) and every test passed.
   */
  async quickDeploy(orgId: string, validationId: string, opts: Pick<DeployOptions, 'onProgress' | 'signal' | 'timeoutMs'> = {}): Promise<DeployOutcome> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const id = await conn.metadata.deployRecentValidation({ id: validationId });
      // Quick Deploy runs no tests, so the test level only matters for the coverage query: none.
      return this.finishDeploy(conn, typeof id === 'string' ? id : (id as any).id, { ...opts, checkOnly: false, testLevel: 'NoTestRun' });
    }).finally(() => this.repos.harness.invalidate(orgId));
  }

  /** Poll a started deploy to completion, cancelling it on timeout or abort. */
  private async finishDeploy(conn: Connection, id: string, opts: DeployOptions): Promise<DeployOutcome> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
    let result: any;
    let delay = 1000;
    let cancelRequested = false;
    for (;;) {
      result = await conn.metadata.checkDeployStatus(id, true);
      opts.onProgress?.(
        `${result.status}${result.stateDetail ? ' — ' + result.stateDetail : ''} (${result.numberComponentsDeployed ?? 0}/${result.numberComponentsTotal ?? 0} components, ${result.numberTestsCompleted ?? 0}/${result.numberTestsTotal ?? 0} tests)`,
      );
      if (result.done === true || result.done === 'true') break;
      if (!cancelRequested && (opts.signal?.aborted || Date.now() >= deadline)) {
        // Cancel is itself asynchronous: keep polling (briefly) so the outcome reflects what
        // Salesforce actually did rather than what we asked for.
        cancelRequested = true;
        await this.requestCancel(conn, id);
        opts.onProgress?.(`Cancelling deploy ${id}`);
        continue;
      }
      if (cancelRequested && Date.now() > deadline + 60_000) {
        throw new Error(`Deploy ${id} was asked to cancel but Salesforce has not confirmed it. Check Setup > Deployment Status.`);
      }
      await sleep(cancelRequested ? 2000 : delay);
      delay = Math.min(delay * 1.4, 8000);
    }
    const outcome = normalizeDeployResult(result);
    if (!outcome.cancelled && refreshesOrgWideCoverage(opts.testLevel)) outcome.orgWideCoverage = await this.orgWideCoverageWith(conn);
    return outcome;
  }

  private async requestCancel(conn: Connection, sfDeployId: string): Promise<void> {
    try {
      await conn.metadata.cancelDeploy(sfDeployId);
    } catch (e) {
      this.log.warn({ sfDeployId, err: (e as Error).message }, 'cancelDeploy failed');
    }
  }

  /** Ask Salesforce to cancel a running deploy. Best effort: a deploy past the point of no return keeps going. */
  async cancelDeploy(orgId: string, sfDeployId: string): Promise<void> {
    const conn = await this.conn(orgId);
    await this.requestCancel(conn, sfDeployId);
  }

  /** `ApexOrgWideCoverage.PercentCovered`, the number production deploys are held to (75%). */
  async orgWideCoverage(orgId: string): Promise<number | null> {
    return this.wrap(orgId, async () => this.orgWideCoverageWith(await this.conn(orgId)));
  }

  private async orgWideCoverageWith(conn: Connection): Promise<number | null> {
    try {
      const r: any = await conn.tooling.query('SELECT PercentCovered FROM ApexOrgWideCoverage');
      const pc = r.records?.[0]?.PercentCovered;
      return pc == null ? null : Number(pc);
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'ApexOrgWideCoverage query failed');
      return null;
    }
  }

  // ---------------------------------------------------------------- Tooling
  async recentApexLogs(orgId: string, limit = 20): Promise<Record<string, unknown>[]> {
    const r = await this.query(
      orgId,
      `SELECT Id, LogUser.Name, Operation, Application, Status, LogLength, DurationMilliseconds, StartTime, Request FROM ApexLog ORDER BY StartTime DESC LIMIT ${Math.min(limit, 100)}`,
      { tooling: true },
    );
    return r.records;
  }
  async apexLogBody(orgId: string, logId: string, maxChars = 60_000): Promise<string> {
    // The id is interpolated into a URL path; anything but an ApexLog id could address another resource.
    if (!isApexLogId(logId)) throw badRequest(`"${logId}" is not an ApexLog id.`);
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const body: string = (await conn.tooling.request(`/sobjects/ApexLog/${logId}/Body`)) as any;
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return text.length > maxChars ? text.slice(0, maxChars) + `\n... [truncated ${text.length - maxChars} chars]` : text;
    });
  }
  async executeAnonymous(
    orgId: string,
    apex: string,
  ): Promise<{
    compiled: boolean;
    success: boolean;
    line: number | null;
    column: number | null;
    compileProblem: string | null;
    exceptionMessage: string | null;
    exceptionStackTrace: string | null;
  }> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const r: any = await conn.tooling.executeAnonymous(apex);
      if (r.success) this.repos.harness.invalidate(orgId);
      return {
        compiled: r.compiled,
        success: r.success,
        line: r.line ?? null,
        column: r.column ?? null,
        compileProblem: r.compileProblem ?? null,
        exceptionMessage: r.exceptionMessage ?? null,
        exceptionStackTrace: r.exceptionStackTrace ?? null,
      };
    });
  }
  async runTests(orgId: string, classNames: string[]): Promise<unknown> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const jobId: string = (await conn.tooling.request({
        method: 'POST',
        url: '/runTestsAsynchronous',
        body: JSON.stringify({ classNames: classNames.join(',') }),
        headers: { 'content-type': 'application/json' },
      })) as any;
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        const job: any = await conn.tooling.query(`SELECT Status FROM ApexTestQueueItem WHERE ParentJobId=${soqlLiteral(jobId)}`);
        const statuses = job.records.map((r: any) => r.Status);
        if (statuses.every((s: string) => ['Completed', 'Failed', 'Aborted'].includes(s))) break;
        if (Date.now() > deadline) throw new Error('Test run timed out');
        await sleep(3000);
      }
      const res: any = await conn.tooling.query(
        `SELECT ApexClass.Name, MethodName, Outcome, Message, StackTrace, RunTime FROM ApexTestResult WHERE AsyncApexJobId=${soqlLiteral(jobId)}`,
      );
      return res.records.map((r: any) => ({
        className: r.ApexClass?.Name,
        method: r.MethodName,
        outcome: r.Outcome,
        message: r.Message,
        stackTrace: r.StackTrace,
        runTime: r.RunTime,
      }));
    });
  }
  async flowVersions(orgId: string, developerName: string): Promise<Record<string, unknown>[]> {
    const r = await this.query(
      orgId,
      `SELECT Id, VersionNumber, Status, ProcessType, Description, LastModifiedDate FROM Flow WHERE Definition.DeveloperName=${soqlLiteral(developerName)} ORDER BY VersionNumber DESC`,
      { tooling: true },
    );
    return r.records;
  }

  /**
   * Activate one version of a flow (or deactivate the flow with `null`) through the Tooling
   * FlowDefinition record. Salesforce validates that the version exists and can be activated.
   */
  async flowSetActiveVersion(orgId: string, developerName: string, versionNumber: number | null): Promise<{ id: string; activeVersionNumber: number | null }> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const def: any = await conn.tooling.query(`SELECT Id, ActiveVersionNumber FROM FlowDefinition WHERE DeveloperName=${soqlLiteral(developerName)}`);
      const rec = def.records?.[0];
      if (!rec) throw new Error(`Flow "${developerName}" not found`);
      const r: any = await conn.tooling.sobject('FlowDefinition').update({ Id: rec.Id, Metadata: { activeVersionNumber: versionNumber ?? 0 } } as any);
      if (r && r.success === false) throw new Error(JSON.stringify(r.errors));
      this.repos.harness.invalidate(orgId);
      return { id: rec.Id, activeVersionNumber: versionNumber };
    });
  }

  /**
   * Make sure Apex logs are captured for a user for the next `minutes`. Reuses a DebugLevel by
   * developer name (creating it when missing) and extends an existing USER_DEBUG TraceFlag for
   * that user rather than stacking a second one, which Salesforce rejects.
   */
  async ensureTraceFlag(
    orgId: string,
    opts: { userId?: string; minutes: number; debugLevel?: string },
  ): Promise<{ traceFlagId: string; debugLevelId: string; userId: string; expirationDate: string; created: boolean }> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      const userId = opts.userId ?? (await conn.identity()).user_id;
      const minutes = Math.max(1, Math.min(opts.minutes, 24 * 60));
      const levelName = opts.debugLevel ?? 'SF_CLAWS';
      const levels: any = await conn.tooling.query(`SELECT Id FROM DebugLevel WHERE DeveloperName=${soqlLiteral(levelName)}`);
      let debugLevelId: string = levels.records?.[0]?.Id;
      if (!debugLevelId) {
        const created: any = await conn.tooling.sobject('DebugLevel').create({
          DeveloperName: levelName,
          MasterLabel: levelName,
          ApexCode: 'FINEST',
          ApexProfiling: 'INFO',
          Callout: 'INFO',
          Database: 'INFO',
          System: 'DEBUG',
          Validation: 'INFO',
          Visualforce: 'INFO',
          Workflow: 'INFO',
        } as any);
        if (!created.success) throw new Error(JSON.stringify(created.errors));
        debugLevelId = created.id;
      }
      const start = new Date();
      const expirationDate = new Date(start.getTime() + minutes * 60_000).toISOString();
      const existing: any = await conn.tooling.query(
        `SELECT Id FROM TraceFlag WHERE TracedEntityId=${soqlLiteral(userId)} AND LogType='USER_DEBUG' ORDER BY ExpirationDate DESC LIMIT 1`,
      );
      const existingId: string | undefined = existing.records?.[0]?.Id;
      if (existingId) {
        const r: any = await conn.tooling
          .sobject('TraceFlag')
          .update({ Id: existingId, StartDate: start.toISOString(), ExpirationDate: expirationDate, DebugLevelId: debugLevelId } as any);
        if (r && r.success === false) throw new Error(JSON.stringify(r.errors));
        return { traceFlagId: existingId, debugLevelId, userId, expirationDate, created: false };
      }
      const r: any = await conn.tooling.sobject('TraceFlag').create({
        TracedEntityId: userId,
        LogType: 'USER_DEBUG',
        DebugLevelId: debugLevelId,
        StartDate: start.toISOString(),
        ExpirationDate: expirationDate,
      } as any);
      if (!r.success) throw new Error(JSON.stringify(r.errors));
      return { traceFlagId: r.id, debugLevelId, userId, expirationDate, created: true };
    });
  }

  /** Managed and unlocked packages installed in the org (Tooling `InstalledSubscriberPackage`). */
  async listInstalledPackages(
    orgId: string,
  ): Promise<
    { id: string; name: string; namespace: string | null; version: string; versionName: string | null; versionId: string; description: string | null }[]
  > {
    const r = await this.query(
      orgId,
      'SELECT Id, SubscriberPackage.Name, SubscriberPackage.NamespacePrefix, SubscriberPackage.Description, SubscriberPackageVersion.Id, SubscriberPackageVersion.Name, SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion, SubscriberPackageVersion.PatchVersion, SubscriberPackageVersion.BuildNumber FROM InstalledSubscriberPackage ORDER BY SubscriberPackage.Name',
      { tooling: true, limit: 500 },
    );
    return r.records.map((p) => ({
      id: String(p['Id']),
      name: String(p['SubscriberPackage.Name'] ?? ''),
      namespace: (p['SubscriberPackage.NamespacePrefix'] as string | null) ?? null,
      version: [
        p['SubscriberPackageVersion.MajorVersion'],
        p['SubscriberPackageVersion.MinorVersion'],
        p['SubscriberPackageVersion.PatchVersion'],
        p['SubscriberPackageVersion.BuildNumber'],
      ]
        .filter((n) => n != null)
        .join('.'),
      versionName: (p['SubscriberPackageVersion.Name'] as string | null) ?? null,
      versionId: String(p['SubscriberPackageVersion.Id'] ?? ''),
      description: (p['SubscriberPackage.Description'] as string | null) ?? null,
    }));
  }

  /**
   * What references a component, from Tooling `MetadataComponentDependency`. The object is a beta
   * some orgs do not expose, so an unavailable API degrades to a `note` rather than an error: the
   * caller (typically a delete) must then say the check could not be made, not that nothing
   * depends on the component.
   */
  async componentDependencies(
    orgId: string,
    type: string,
    name: string,
  ): Promise<{ available: boolean; note: string | null; dependents: { type: string; name: string; id: string }[] }> {
    return this.wrap(orgId, async () => {
      const conn = await this.conn(orgId);
      try {
        const r: any = await conn.tooling.query(
          `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentType=${soqlLiteral(type)} AND RefMetadataComponentName=${soqlLiteral(name)}`,
        );
        const dependents = (r.records ?? []).map((d: any) => ({ type: d.MetadataComponentType, name: d.MetadataComponentName, id: d.MetadataComponentId }));
        return { available: true, note: null, dependents };
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (/MetadataComponentDependency|INVALID_TYPE|not supported/i.test(msg)) {
          return {
            available: false,
            note: `Dependency lookup is not available in this org (${msg.split('\n')[0]}). Check references manually before deleting.`,
            dependents: [],
          };
        }
        throw e;
      }
    });
  }

  /** Folders for in-folder metadata (Report, Dashboard, EmailTemplate, Document), via Metadata API list. */
  async listFolders(
    orgId: string,
    type: 'Report' | 'Dashboard' | 'EmailTemplate' | 'Document',
  ): Promise<{ fullName: string; id: string; lastModifiedDate: string }[]> {
    const folderType = type === 'EmailTemplate' ? 'EmailFolder' : `${type}Folder`;
    const rows = await this.listMetadata(orgId, folderType);
    return rows.map((r) => ({ fullName: r.fullName, id: r.id, lastModifiedDate: r.lastModifiedDate }));
  }
}

// ----------------------------------------------------------------------- pure helpers

/** Quote a string as a SOQL literal, escaping the backslash before the quote. */
export function soqlLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** ApexLog ids start with 07L; 15 or 18 characters. */
export function isApexLogId(id: string): boolean {
  return /^07L[A-Za-z0-9]{12,15}$/.test(id);
}

/**
 * The test level a deploy actually runs. Production with Apex staged never runs `NoTestRun`:
 * Salesforce would refuse it anyway, but only after the user approved a deploy the card described
 * as test-free. Everything else passes through.
 */
export function effectiveTestLevel(orgKind: OrgKind, hasApex: boolean, requested: TestLevel): TestLevel {
  if (orgKind === 'production' && hasApex && requested === 'NoTestRun') return 'RunLocalTests';
  return requested;
}

/** Test levels after which `ApexOrgWideCoverage` reflects the run. */
export function refreshesOrgWideCoverage(level: TestLevel): boolean {
  return level === 'RunLocalTests' || level === 'RunAllTestsInOrg';
}

export interface OrganizationInfo {
  isSandbox: boolean;
  organizationType: string | null;
  name?: string | null;
}

/** `Organization.IsSandbox` and `OrganizationType`. Throws rather than guessing when unreadable. */
async function organizationInfo(conn: Connection): Promise<OrganizationInfo> {
  const o = await conn.query<{ IsSandbox: boolean; OrganizationType: string; Name: string }>(
    'SELECT IsSandbox, OrganizationType, Name FROM Organization LIMIT 1',
  );
  const rec = o.records[0];
  if (!rec) throw new Error('Organization record not readable');
  return { isSandbox: rec.IsSandbox === true, organizationType: rec.OrganizationType ?? null, name: rec.Name ?? null };
}

/**
 * What the org's own record says it is. A sandbox keeps its production's edition, so IsSandbox
 * decides; a scratch org is a sandbox-flagged Developer Edition; a Developer Edition that is not
 * sandbox-flagged is a developer org; the rest is production.
 */
export function detectOrgKind(info: OrganizationInfo): OrgKind {
  const dev = /developer edition/i.test(info.organizationType ?? '');
  if (info.isSandbox) return dev ? 'scratch' : 'sandbox';
  return dev ? 'developer' : 'production';
}

/** Registered and detected kinds conflict when they disagree about production status. */
export function orgKindConflict(registered: OrgKind, detected: OrgKind): boolean {
  return (registered === 'production') !== (detected === 'production');
}

function describeOrg(info: OrganizationInfo): string {
  return `${info.isSandbox ? 'a sandbox' : 'a non-sandbox org'}${info.organizationType ? ` (${info.organizationType})` : ''}`;
}

/**
 * Types a Profile carries permissions for that are cheap enough to wildcard. `CustomObject *`
 * covers custom objects only (standard objects must be named); `CustomField *` covers custom
 * fields on every object. Layouts and record types on standard objects cannot be wildcarded and
 * are left out: the caller passes them in `related` when it knows them.
 *
 * Trade-off: wildcards make a Profile read complete at the cost of retrieving every class and
 * custom object in the org, which on a large org is slow and can hit the 10,000-file retrieve
 * limit. Passing `related` (the workspace's own members) is both faster and more precise.
 */
export const PROFILE_CONTEXT_TYPES = ['CustomObject', 'CustomField', 'ApexClass', 'ApexPage', 'CustomTab', 'CustomApplication'] as const;

/** The manifest types for a retrieve, with Profile context added when a Profile is requested. */
export function profileRetrieveTypes(
  components: { type: string; members: string[] }[],
  related?: { type: string; members: string[] }[],
): { name: string; members: string[] }[] {
  const byType = new Map<string, Set<string>>();
  const add = (type: string, members: string[]) => {
    if (!byType.has(type)) byType.set(type, new Set());
    for (const m of members) byType.get(type)!.add(m);
  };
  for (const c of components) add(c.type, c.members);
  if (components.some((c) => c.type === 'Profile')) {
    if (related?.length) for (const r of related) add(r.type, r.members);
    else for (const t of PROFILE_CONTEXT_TYPES) if (!byType.has(t)) add(t, ['*']);
  }
  return [...byType.entries()].map(([name, members]) => ({ name, members: [...members] }));
}

/** Keep only the files whose source directory belongs to a type the caller asked for. */
export function onlyRequestedTypes(files: SourceFile[], components: { type: string }[]): SourceFile[] {
  const dirs = new Set(components.map((c) => SourceFormatRegistry[c.type]?.dir).filter((d): d is string => !!d));
  return files.filter((f) => dirs.has(f.path.split('/')[0]));
}

export function normalizeDeployResult(r: any): DeployOutcome {
  const details = r.details ?? {};
  const failuresRaw = arr(details.componentFailures);
  const failures: DeployFailure[] = failuresRaw.map((f: any) => ({
    componentType: f.componentType ?? null,
    fullName: f.fullName ?? null,
    fileName: f.fileName ?? null,
    problem: f.problem ?? 'Unknown problem',
    problemType: f.problemType ?? null,
    lineNumber: f.lineNumber != null ? Number(f.lineNumber) : null,
    columnNumber: f.columnNumber != null ? Number(f.columnNumber) : null,
  }));
  const rt = details.runTestResult ?? {};
  const testFailures = arr(rt.failures).map((t: any) => ({ name: t.name, method: t.methodName ?? null, message: t.message, stackTrace: t.stackTrace ?? null }));
  const coverageWarnings = arr(rt.codeCoverageWarnings).map((w: any) => `${w.name ? w.name + ': ' : ''}${w.message}`);
  let runCoverage: number | null = null;
  const cov = arr(rt.codeCoverage);
  if (cov.length) {
    const total = cov.reduce((a: number, c: any) => a + Number(c.numLocations ?? 0), 0);
    const notCovered = cov.reduce((a: number, c: any) => a + Number(c.numLocationsNotCovered ?? 0), 0);
    runCoverage = total ? Math.round(((total - notCovered) / total) * 1000) / 10 : null;
  }
  const ok = r.success === true || r.success === 'true';
  const checkOnly = r.checkOnly === true || r.checkOnly === 'true';
  const cancelled = r.status === 'Canceled' || r.status === 'Canceling';
  const testsRan = Number(r.numberTestsTotal ?? 0) > 0;
  // Test failures also count as failures for the loop
  for (const t of testFailures)
    failures.push({
      componentType: 'ApexTest',
      fullName: `${t.name}.${t.method ?? ''}`,
      fileName: null,
      problem: `${t.message}${t.stackTrace ? '\n' + t.stackTrace : ''}`,
      problemType: 'TestFailure',
      lineNumber: null,
      columnNumber: null,
    });
  if (r.errorMessage && !failures.length)
    failures.push({
      componentType: null,
      fullName: null,
      fileName: null,
      problem: `${r.errorStatusCode ?? 'Error'}: ${r.errorMessage}`,
      problemType: 'Error',
      lineNumber: null,
      columnNumber: null,
    });
  return {
    ok,
    sfDeployId: r.id,
    status: r.status,
    checkOnly,
    componentsTotal: Number(r.numberComponentsTotal ?? 0),
    componentsDeployed: Number(r.numberComponentsDeployed ?? 0),
    componentsFailed: Number(r.numberComponentErrors ?? 0),
    testsTotal: Number(r.numberTestsTotal ?? 0),
    testsFailed: Number(r.numberTestErrors ?? 0),
    runCoverage,
    codeCoverage: runCoverage,
    orgWideCoverage: null,
    // Quick Deploy needs a validation that ran tests and passed them all.
    validationId: ok && checkOnly && testsRan && !failures.length ? r.id : null,
    cancelled,
    failures,
    testFailures,
    coverageWarnings,
    errorMessage: r.errorMessage ?? null,
  };
}

const arr = (x: any): any[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flatten nested relationship records (Account.Owner.Name -> "Owner.Name") and drop attributes. */
export function flattenRecord(rec: any, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec ?? {})) {
    if (k === 'attributes') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && (v as any).attributes && !(v as any).records) {
      Object.assign(out, flattenRecord(v, `${prefix}${k}.`));
    } else if (v && typeof v === 'object' && (v as any).records) {
      out[`${prefix}${k}`] = { subquery: true, totalSize: (v as any).totalSize, records: (v as any).records.map((r: any) => flattenRecord(r)) };
    } else out[`${prefix}${k}`] = v;
  }
  return out;
}

export function columnsFromSoql(soql: string, records: Record<string, unknown>[]): string[] {
  const m = /^\s*select\s+(.*?)\s+from\s/is.exec(soql);
  const cols = new Set<string>();
  if (m && !/\(/.test(m[1]))
    m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((c) => cols.add(c.split(/\s+/).pop()!));
  for (const r of records.slice(0, 50)) for (const k of Object.keys(r)) cols.add(k);
  return [...cols];
}

/**
 * A retrieve archive nests everything under `unpackaged/`. Re-root it so SDR sees a normal package.
 */
async function unwrapRetrieveZip(zipBuffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const names = Object.keys(zip.files);
  if (!names.some((n) => n.startsWith('unpackaged/'))) return zipBuffer;
  const rerooted = new JSZip();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    rerooted.file(name.replace(/^unpackaged\//, ''), await entry.async('nodebuffer'));
  }
  return rerooted.generateAsync({ type: 'nodebuffer' });
}
