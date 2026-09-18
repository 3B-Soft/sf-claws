import { describe, it, expect, vi } from 'vitest';
import type { WorkspaceFile } from '@sf-claws/shared';
import { makeContext, seedClientOrgUser } from './helpers.js';
import { SalesforceService, normalizeDeployResult } from '../src/salesforce/service.js';
import { toolingEligible, resolveToolingMembers, pollToolingCompile } from '../src/salesforce/tooling-compile.js';

const apex: WorkspaceFile = {
  path: 'classes/A.cls',
  content: 'public class A { Integer x; }',
  original: 'public class A {}',
  metadataType: 'ApexClass',
  fullName: 'A',
  action: 'modified',
};
const meta: WorkspaceFile = { ...apex, path: 'classes/A.cls-meta.xml', content: '<ApexClass/>', original: '<ApexClass/>' };
const ok = () => normalizeDeployResult({ id: '0Af000000000001', success: true, status: 'Succeeded', checkOnly: true });

describe('Tooling compile fast path', () => {
  it('accepts only existing body-only Apex changes', () => {
    expect(toolingEligible([apex, meta])).toBe(true);
    expect(toolingEligible([{ ...apex, action: 'created', original: null }])).toBe(false);
    expect(toolingEligible([{ ...apex, action: 'deleted' }])).toBe(false);
    expect(toolingEligible([apex, { ...meta, content: '<changed/>' }])).toBe(false);
    expect(toolingEligible([apex, { ...meta, metadataType: 'CustomField' }])).toBe(false);
  });

  it('never creates a live class to make a missing member eligible', async () => {
    const conn = { tooling: { query: vi.fn(async () => ({ records: [] })), sobject: vi.fn() } };
    expect(await resolveToolingMembers(conn as any, [apex])).toBeNull();
    expect(conn.tooling.sobject).not.toHaveBeenCalled();
    expect(conn.tooling.query.mock.calls[0][0]).toContain('NamespacePrefix=null');
  });

  it('creates only temporary members and hardcodes IsCheckOnly, then polls and cleans up', async () => {
    const calls: { type: string; value: any }[] = [];
    const destroyed: string[] = [];
    const conn = {
      version: '62.0',
      tooling: {
        query: async () => ({ records: [{ Id: '01p000000000001', Name: 'A', ApiVersion: 62 }] }),
        sobject: (type: string) => ({
          create: async (value: any) => {
            calls.push({ type, value });
            return { success: true, id: type === 'MetadataContainer' ? 'container' : type === 'ContainerAsyncRequest' ? 'job' : 'member' };
          },
          retrieve: async () => ({ State: 'Completed', DeployDetails: { componentSuccesses: [{ fullName: 'A' }] } }),
          destroy: async (id: string) => {
            destroyed.push(id);
            return { success: true };
          },
        }),
      },
    };
    const ctx = makeContext();
    const { org } = await seedClientOrgUser(ctx);
    const sf = new SalesforceService(ctx.repos, ctx.config, ctx.secrets, ctx.log);
    (sf.connections as any).cache.set(org.id, conn);
    const members = await sf.prepareToolingCompile(org.id, [apex, meta]);
    const onContainer = vi.fn();
    const onSubmitted = vi.fn();
    expect((await sf.toolingCompile(org.id, members!, { onContainer, onSubmitted })).ok).toBe(true);
    expect(calls.map((c) => c.type)).toEqual(['MetadataContainer', 'ApexClassMember', 'ContainerAsyncRequest']);
    expect(calls.at(-1)!.value.IsCheckOnly).toBe(true);
    expect(calls[1].value).toMatchObject({ ContentEntityId: '01p000000000001', Body: apex.content });
    expect(onSubmitted).toHaveBeenCalledWith('job');
    await sf.cleanupToolingContainer(org.id, 'container');
    expect(destroyed).toEqual(['container']);
    ctx.db.close();
  });

  it('normalizes compilation diagnostics without claiming tests or coverage ran', async () => {
    const conn = {
      tooling: {
        sobject: () => ({
          retrieve: async () => ({
            State: 'Failed',
            DeployDetails: { componentFailures: [{ componentType: 'ApexClass', fullName: 'A', problem: 'Unexpected token', lineNumber: 3 }] },
          }),
        }),
      },
    };
    const result = await pollToolingCompile(conn as any, { id: 'job', containerId: 'container' });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ fullName: 'A', lineNumber: 3 });
    expect(result.validationId).toBeNull();
    expect(result.codeCoverage).toBeNull();
    expect(result.testsTotal).toBe(0);
  });

  it('routes only eligible slices to Tooling; full checks and mixed groups stay Metadata', async () => {
    const prepareToolingCompile = vi.fn(async () => [{ type: 'ApexClass' as const, id: '01p000000000001', name: 'A', path: apex.path, body: apex.content }]);
    const toolingCompile = vi.fn(async () => ok());
    const deploy = vi.fn(async () => ok());
    const ctx = makeContext({ sf: { prepareToolingCompile, toolingCompile, deploy } });
    const { org, user } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.repos.workspace.upsert(session.id, apex);
    ctx.repos.workspace.upsert(session.id, meta);
    const slice = await ctx.runtime.validate(session.id, { paths: [apex.path] });
    expect(slice.scope).toBe('slice');
    expect(slice.testLevel).toBe('NoTestRun');
    expect(toolingCompile).toHaveBeenCalledTimes(1);
    expect(deploy).not.toHaveBeenCalled();
    expect(ctx.runtime.readyToDeploy(session.id).ok).toBe(false);
    await ctx.runtime.validate(session.id);
    expect(deploy).toHaveBeenCalledTimes(1);
    ctx.repos.workspace.upsert(session.id, {
      ...meta,
      path: 'objects/Account/fields/A__c.field-meta.xml',
      metadataType: 'CustomField',
      fullName: 'Account.A__c',
      action: 'created',
      original: null,
    });
    await ctx.runtime.validate(session.id, { paths: [apex.path] });
    expect(deploy).toHaveBeenCalledTimes(2);
    expect(toolingCompile).toHaveBeenCalledTimes(1);
    ctx.db.close();
  });
});
