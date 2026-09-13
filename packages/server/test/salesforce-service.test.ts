import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeContext, seedClientOrgUser } from './helpers.js';
import {
  SalesforceService,
  detectOrgKind,
  effectiveTestLevel,
  isApexLogId,
  latestApiVersion,
  normalizeDeployResult,
  onlyRequestedTypes,
  orgKindConflict,
  profileRetrieveTypes,
  soqlLiteral,
} from '../src/salesforce/service.js';
import { ConnectionManager } from '../src/salesforce/connection.js';

/**
 * The service against a scripted jsforce connection. `connections.forOrg` returns whatever is in
 * its cache, so a fake connection seeded there exercises the real service code without a network.
 */
function fakeService(conn: Record<string, unknown>) {
  const ctx = makeContext();
  return seedClientOrgUser(ctx).then(({ org }) => {
    const sf = new SalesforceService(ctx.repos, ctx.config, ctx.secrets, ctx.log);
    (sf.connections as any).cache.set(org.id, { version: '62.0', ...conn });
    return { sf, org, ctx };
  });
}

const doneResult = (extra: Record<string, unknown> = {}) => ({
  id: '0Af000000000001',
  done: true,
  success: true,
  status: 'Succeeded',
  checkOnly: false,
  numberComponentsTotal: 1,
  numberComponentsDeployed: 1,
  numberComponentErrors: 0,
  numberTestsTotal: 0,
  numberTestErrors: 0,
  details: {},
  ...extra,
});

describe('SOQL and id helpers', () => {
  it('escapes backslashes before quotes so a literal cannot break out', () => {
    expect(soqlLiteral(`O'Brien`)).toBe(`'O\\'Brien'`);
    expect(soqlLiteral(`a\\b`)).toBe(`'a\\\\b'`);
    // The old escape turned `\'` into `\\'`: the backslash escaped itself and the quote closed the literal.
    expect(soqlLiteral(`x\\'`)).toBe(`'x\\\\\\''`);
  });

  it('recognises ApexLog ids and nothing else', () => {
    expect(isApexLogId('07L5g00000ABCDE')).toBe(true);
    expect(isApexLogId('07L5g00000ABCDEEAA')).toBe(true);
    expect(isApexLogId('001000000000001')).toBe(false);
    expect(isApexLogId('07L5g00000ABCDE/../../x')).toBe(false);
  });

  it('rejects a non-ApexLog id before touching the org', async () => {
    const request = vi.fn();
    const { sf, org } = await fakeService({ tooling: { request } });
    await expect(sf.apexLogBody(org.id, '../sobjects/User')).rejects.toThrow(/not an ApexLog id/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('query', () => {
  it('flattens relationship fields without prefixing columns with the row index', async () => {
    const { sf, org } = await fakeService({
      query: async () => ({
        totalSize: 2,
        done: true,
        records: [
          { attributes: {}, Id: '001a', Owner: { attributes: {}, Name: 'Ann' } },
          { attributes: {}, Id: '001b', Owner: { attributes: {}, Name: 'Bob' } },
        ],
      }),
    });
    const r = await sf.query(org.id, 'SELECT Id, Owner.Name FROM Account');
    expect(r.records).toEqual([
      { Id: '001a', 'Owner.Name': 'Ann' },
      { Id: '001b', 'Owner.Name': 'Bob' },
    ]);
    expect(r.columns).toEqual(['Id', 'Owner.Name']);
  });
});

describe('effectiveTestLevel', () => {
  it('clamps NoTestRun to RunLocalTests on production with Apex, and nowhere else', () => {
    expect(effectiveTestLevel('production', true, 'NoTestRun')).toBe('RunLocalTests');
    expect(effectiveTestLevel('production', false, 'NoTestRun')).toBe('NoTestRun');
    expect(effectiveTestLevel('sandbox', true, 'NoTestRun')).toBe('NoTestRun');
    expect(effectiveTestLevel('production', true, 'RunSpecifiedTests')).toBe('RunSpecifiedTests');
  });
});

describe('org kind detection', () => {
  it('reads the kind from IsSandbox and OrganizationType', () => {
    expect(detectOrgKind({ isSandbox: false, organizationType: 'Enterprise Edition' })).toBe('production');
    expect(detectOrgKind({ isSandbox: true, organizationType: 'Enterprise Edition' })).toBe('sandbox');
    expect(detectOrgKind({ isSandbox: true, organizationType: 'Developer Edition' })).toBe('scratch');
    expect(detectOrgKind({ isSandbox: false, organizationType: 'Developer Edition' })).toBe('developer');
  });

  it('only conflicts on production status', () => {
    expect(orgKindConflict('production', 'sandbox')).toBe(true);
    expect(orgKindConflict('sandbox', 'production')).toBe(true);
    expect(orgKindConflict('sandbox', 'scratch')).toBe(false);
    expect(orgKindConflict('developer', 'sandbox')).toBe(false);
    expect(orgKindConflict('production', 'production')).toBe(false);
  });
});

describe('API version', () => {
  it('picks the highest version the instance lists', () => {
    expect(latestApiVersion([{ version: '61.0' }, { version: '63.0' }, { version: '62.0' }])).toBe('63.0');
    expect(latestApiVersion([])).toBeNull();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps a numeric version, resolves max from /services/data and caches it', async () => {
    const ctx = makeContext();
    const cm = new ConnectionManager(ctx.repos, ctx.config, ctx.secrets, ctx.log);
    const fetch = vi.fn(async () => ({ ok: true, json: async () => [{ version: '62.0' }, { version: '64.0' }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await cm.resolveApiVersion('org_1', '62.0', 'https://x.my.salesforce.com')).toBe('62.0');
    expect(fetch).not.toHaveBeenCalled();
    expect(await cm.resolveApiVersion('org_1', 'max', 'https://x.my.salesforce.com/')).toBe('64.0');
    expect(await cm.resolveApiVersion('org_1', 'max', 'https://x.my.salesforce.com/')).toBe('64.0');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://x.my.salesforce.com/services/data');
  });

  it('falls back to the default when the lookup fails', async () => {
    const ctx = makeContext();
    const cm = new ConnectionManager(ctx.repos, ctx.config, ctx.secrets, ctx.log);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    expect(await cm.resolveApiVersion('org_2', 'max', 'https://x.my.salesforce.com')).toBe('62.0');
  });
});

describe('profile retrieval context', () => {
  it('leaves a request without Profiles alone', () => {
    expect(profileRetrieveTypes([{ type: 'ApexClass', members: ['Foo'] }])).toEqual([{ name: 'ApexClass', members: ['Foo'] }]);
  });

  it('adds the workspace members when given, wildcards otherwise', () => {
    const withRelated = profileRetrieveTypes([{ type: 'Profile', members: ['Admin'] }], [{ type: 'CustomObject', members: ['Account'] }]);
    expect(withRelated).toEqual([
      { name: 'Profile', members: ['Admin'] },
      { name: 'CustomObject', members: ['Account'] },
    ]);
    const wildcard = profileRetrieveTypes([{ type: 'Profile', members: ['Admin'] }]);
    expect(wildcard.find((t) => t.name === 'CustomObject')!.members).toEqual(['*']);
    expect(wildcard.find((t) => t.name === 'ApexClass')!.members).toEqual(['*']);
    // A type the caller already named keeps its explicit members rather than being widened.
    const explicit = profileRetrieveTypes([
      { type: 'Profile', members: ['Admin'] },
      { type: 'ApexClass', members: ['Foo'] },
    ]);
    expect(explicit.find((t) => t.name === 'ApexClass')!.members).toEqual(['Foo']);
  });

  it('returns only the requested types after the context was retrieved', () => {
    const files = [
      { path: 'profiles/Admin.profile-meta.xml', content: '' },
      { path: 'objects/Account/Account.object-meta.xml', content: '' },
      { path: 'classes/Foo.cls', content: '' },
    ];
    expect(onlyRequestedTypes(files, [{ type: 'Profile' }]).map((f) => f.path)).toEqual(['profiles/Admin.profile-meta.xml']);
  });
});

describe('normalizeDeployResult', () => {
  it('names the per-run coverage honestly and records a reusable validation id', () => {
    const r = normalizeDeployResult(
      doneResult({
        checkOnly: true,
        numberTestsTotal: 4,
        details: { runTestResult: { codeCoverage: [{ numLocations: 10, numLocationsNotCovered: 2 }] } },
      }),
    );
    expect(r.runCoverage).toBe(80);
    expect(r.codeCoverage).toBe(80);
    expect(r.orgWideCoverage).toBeNull();
    expect(r.validationId).toBe('0Af000000000001');
    expect(r.cancelled).toBe(false);
  });

  it('does not offer Quick Deploy for a validation that ran no tests or failed', () => {
    expect(normalizeDeployResult(doneResult({ checkOnly: true, numberTestsTotal: 0 })).validationId).toBeNull();
    expect(normalizeDeployResult(doneResult({ checkOnly: false, numberTestsTotal: 3 })).validationId).toBeNull();
    expect(normalizeDeployResult(doneResult({ checkOnly: true, numberTestsTotal: 3, success: false, errorMessage: 'boom' })).validationId).toBeNull();
  });

  it('reports a cancelled deploy as cancelled, not failed', () => {
    const r = normalizeDeployResult(doneResult({ success: false, status: 'Canceled' }));
    expect(r.cancelled).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe('deploy lifecycle', () => {
  it('cancels the Salesforce deploy past the deadline and returns the cancelled outcome', async () => {
    const statuses = [{ id: 'd1', done: false, status: 'InProgress' }, doneResult({ id: 'd1', success: false, status: 'Canceled' })];
    const cancelDeploy = vi.fn(async () => ({ done: true, id: 'd1' }));
    const { sf, org } = await fakeService({
      metadata: { deploy: () => Promise.resolve({ id: 'd1' }), checkDeployStatus: async () => statuses.shift(), cancelDeploy },
      tooling: { query: vi.fn() },
    });
    const progress: string[] = [];
    const r = await sf.deploy(
      org.id,
      [
        { path: 'classes/Foo.cls', content: 'public class Foo {}' },
        { path: 'classes/Foo.cls-meta.xml', content: META },
      ],
      {
        checkOnly: false,
        testLevel: 'NoTestRun',
        timeoutMs: 0,
        onProgress: (m) => progress.push(m),
      },
    );
    expect(cancelDeploy).toHaveBeenCalledWith('d1');
    expect(r.cancelled).toBe(true);
    expect(r.ok).toBe(false);
    expect(progress.some((m) => /Cancelling deploy d1/.test(m))).toBe(true);
  });

  it('cancels when the caller aborts', async () => {
    const statuses = [{ id: 'd2', done: false, status: 'Pending' }, doneResult({ id: 'd2', success: false, status: 'Canceled' })];
    const cancelDeploy = vi.fn(async () => ({ done: true, id: 'd2' }));
    const ac = new AbortController();
    ac.abort();
    const { sf, org } = await fakeService({
      metadata: { deploy: () => Promise.resolve({ id: 'd2' }), checkDeployStatus: async () => statuses.shift(), cancelDeploy },
    });
    const r = await sf.deploy(
      org.id,
      [
        { path: 'classes/Foo.cls', content: 'public class Foo {}' },
        { path: 'classes/Foo.cls-meta.xml', content: META },
      ],
      {
        checkOnly: true,
        testLevel: 'NoTestRun',
        signal: ac.signal,
      },
    );
    expect(cancelDeploy).toHaveBeenCalledTimes(1);
    expect(r.cancelled).toBe(true);
  });

  it('adds org-wide coverage after a RunLocalTests run', async () => {
    const query = vi.fn(async (soql: string) => (/ApexOrgWideCoverage/.test(soql) ? { records: [{ PercentCovered: 81 }] } : { records: [] }));
    const { sf, org } = await fakeService({
      metadata: {
        deploy: () => Promise.resolve({ id: 'd3' }),
        checkDeployStatus: async () =>
          doneResult({
            id: 'd3',
            checkOnly: true,
            numberTestsTotal: 2,
            details: { runTestResult: { codeCoverage: [{ numLocations: 4, numLocationsNotCovered: 1 }] } },
          }),
      },
      tooling: { query },
    });
    const r = await sf.deploy(
      org.id,
      [
        { path: 'classes/Foo.cls', content: 'public class Foo {}' },
        { path: 'classes/Foo.cls-meta.xml', content: META },
      ],
      {
        checkOnly: true,
        testLevel: 'RunLocalTests',
      },
    );
    expect(r.runCoverage).toBe(75);
    expect(r.orgWideCoverage).toBe(81);
    expect(r.validationId).toBe('d3');
  });

  it('quick-deploys a validation without re-running tests', async () => {
    const deployRecentValidation = vi.fn(async () => 'd4');
    const query = vi.fn();
    const { sf, org } = await fakeService({
      metadata: { deployRecentValidation, checkDeployStatus: async () => doneResult({ id: 'd4' }) },
      tooling: { query },
    });
    const r = await sf.quickDeploy(org.id, 'validation-1');
    expect(deployRecentValidation).toHaveBeenCalledWith({ id: 'validation-1' });
    expect(r.ok).toBe(true);
    expect(r.sfDeployId).toBe('d4');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Tooling helpers', () => {
  it('creates a DebugLevel and TraceFlag when none exist, and extends an existing flag otherwise', async () => {
    const created: Record<string, unknown[]> = { DebugLevel: [], TraceFlag: [] };
    const updated: unknown[] = [];
    let flagExists = false;
    const { sf, org } = await fakeService({
      identity: async () => ({ user_id: '005000000000001' }),
      tooling: {
        query: async (soql: string) => {
          if (/FROM DebugLevel/.test(soql)) return { records: created.DebugLevel.length ? [{ Id: 'dl1' }] : [] };
          if (/FROM TraceFlag/.test(soql)) return { records: flagExists ? [{ Id: 'tf1' }] : [] };
          return { records: [] };
        },
        sobject: (name: string) => ({
          create: async (rec: unknown) => {
            created[name].push(rec);
            return { success: true, id: name === 'DebugLevel' ? 'dl1' : 'tf1' };
          },
          update: async (rec: unknown) => {
            updated.push(rec);
            return { success: true };
          },
        }),
      },
    });
    const first = await sf.ensureTraceFlag(org.id, { minutes: 30 });
    expect(first).toMatchObject({ traceFlagId: 'tf1', debugLevelId: 'dl1', userId: '005000000000001', created: true });
    expect(created.DebugLevel).toHaveLength(1);
    expect(created.TraceFlag[0]).toMatchObject({ TracedEntityId: '005000000000001', LogType: 'USER_DEBUG', DebugLevelId: 'dl1' });

    flagExists = true;
    const second = await sf.ensureTraceFlag(org.id, { minutes: 10, userId: '005000000000001' });
    expect(second.created).toBe(false);
    expect(created.TraceFlag).toHaveLength(1);
    expect(updated[0]).toMatchObject({ Id: 'tf1', DebugLevelId: 'dl1' });
  });

  it('lists installed packages with a dotted version', async () => {
    const { sf, org } = await fakeService({
      tooling: {
        query: async () => ({
          totalSize: 1,
          done: true,
          records: [
            {
              Id: '0A3x',
              SubscriberPackage: { attributes: {}, Name: 'Widgets', NamespacePrefix: 'wdg', Description: null },
              SubscriberPackageVersion: { attributes: {}, Id: '04tx', Name: 'Spring', MajorVersion: 2, MinorVersion: 4, PatchVersion: 0, BuildNumber: 7 },
            },
          ],
        }),
      },
    });
    expect(await sf.listInstalledPackages(org.id)).toEqual([
      { id: '0A3x', name: 'Widgets', namespace: 'wdg', version: '2.4.0.7', versionName: 'Spring', versionId: '04tx', description: null },
    ]);
  });

  it('activates a flow version through FlowDefinition and escapes the name', async () => {
    const queries: string[] = [];
    const updates: unknown[] = [];
    const { sf, org } = await fakeService({
      tooling: {
        query: async (soql: string) => {
          queries.push(soql);
          return { records: [{ Id: '300x', ActiveVersionNumber: 1 }] };
        },
        sobject: () => ({
          update: async (rec: unknown) => {
            updates.push(rec);
            return { success: true };
          },
        }),
      },
    });
    await sf.flowSetActiveVersion(org.id, "Weird'Name", 3);
    expect(queries[0]).toContain(`DeveloperName='Weird\\'Name'`);
    expect(updates[0]).toEqual({ Id: '300x', Metadata: { activeVersionNumber: 3 } });
    await sf.flowSetActiveVersion(org.id, 'Other', null);
    expect(updates[1]).toEqual({ Id: '300x', Metadata: { activeVersionNumber: 0 } });
  });

  it('reports dependents, and degrades to a note when the beta object is unavailable', async () => {
    const { sf, org } = await fakeService({
      tooling: {
        query: async () => ({ records: [{ MetadataComponentId: '01p', MetadataComponentName: 'Caller', MetadataComponentType: 'ApexClass' }] }),
      },
    });
    expect(await sf.componentDependencies(org.id, 'ApexClass', 'Foo')).toEqual({
      available: true,
      note: null,
      dependents: [{ type: 'ApexClass', name: 'Caller', id: '01p' }],
    });

    const unavailable = await fakeService({
      tooling: {
        query: async () => {
          throw new Error("sObject type 'MetadataComponentDependency' is not supported.");
        },
      },
    });
    const r = await unavailable.sf.componentDependencies(unavailable.org.id, 'ApexClass', 'Foo');
    expect(r.available).toBe(false);
    expect(r.note).toMatch(/not available/);
    expect(r.dependents).toEqual([]);
  });

  it('lists folders through the folder type of each in-folder metadata type', async () => {
    const asked: string[] = [];
    const { sf, org } = await fakeService({
      metadata: {
        list: async (q: { type: string }[]) => {
          asked.push(q[0].type);
          return [{ fullName: 'Sales', id: '00l', lastModifiedByName: 'x', lastModifiedDate: '2026-01-01' }];
        },
      },
    });
    expect(await sf.listFolders(org.id, 'Report')).toEqual([{ fullName: 'Sales', id: '00l', lastModifiedDate: '2026-01-01' }]);
    await sf.listFolders(org.id, 'EmailTemplate');
    await sf.listFolders(org.id, 'Dashboard');
    expect(asked).toEqual(['ReportFolder', 'EmailFolder', 'DashboardFolder']);
  });
});

const META = `<?xml version="1.0" encoding="UTF-8"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>`;
