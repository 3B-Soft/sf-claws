import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { makeContext, seedClientOrgUser, disablePlanMode, disableReviewerGate } from './helpers.js';
import type { DeployOutcome } from '../src/salesforce/service.js';

const NS = 'http://soap.sforce.com/2006/04/metadata';
const fieldXml = (name: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="${NS}"><fullName>${name}</fullName><label>${name}</label><type>Date</type></CustomField>`;

function okDeploy(files: { path: string }[], opts: { checkOnly: boolean }): DeployOutcome {
  return {
    ok: true,
    sfDeployId: '0Af000',
    status: 'Succeeded',
    checkOnly: opts.checkOnly,
    componentsTotal: files.length,
    componentsDeployed: files.length,
    componentsFailed: 0,
    testsTotal: 0,
    testsFailed: 0,
    codeCoverage: null,
    failures: [],
    testFailures: [],
    coverageWarnings: [],
    errorMessage: null,
  } as DeployOutcome;
}

/**
 * The manual /sessions/:id/deploy and /commit routes exist for the panel's Deploy/Commit buttons,
 * bypassing the agent loop. Review defect 4: these must go through the same permission evaluation
 * as the agent's request_deploy/commit_to_github tools, so an impactDenyList rule stops the human
 * path exactly as it stops the agent's, and the panel's own confirm dialog is the confirmation.
 */
describe('manual deploy/commit routes honour policy like the agent path does', () => {
  let app: FastifyInstance;
  const ctx = makeContext({ sf: { readComponent: async () => [], deploy: async (_o: string, f: any, o: any) => okDeploy(f, o) } as never });
  let token = '';
  let sessionId = '';

  beforeAll(async () => {
    disablePlanMode(ctx);
    disableReviewerGate(ctx);
    app = await buildApp(ctx);
    await app.ready();
    const { user, org } = await seedClientOrgUser(ctx);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: user.email, password: 'password12345' } });
    token = login.json().token;
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    sessionId = session.id;
    ctx.repos.workspace.upsert(session.id, {
      path: 'objects/Account/fields/A__c.field-meta.xml',
      content: fieldXml('A__c'),
      original: null,
      metadataType: 'CustomField',
      fullName: 'Account.A__c',
      action: 'created',
    });
    await ctx.runtime.validate(session.id);
  });
  afterAll(async () => {
    await app.close();
  });
  const auth = () => ({ authorization: `Bearer ${token}` });

  it('refuses a manual deploy when a deny rule matches, the same as the agent tool would be refused', async () => {
    ctx.repos.policies.set('global', { impactDenyList: ['deploy'] }, 'test');
    const res = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/deploy`, headers: auth() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error ?? res.json().code).toBeTruthy();
  });

  it('deploys once the deny rule is lifted, treating the route caller as the confirmation', async () => {
    ctx.repos.policies.set('global', { impactDenyList: [] }, 'test');
    const res = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/deploy`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
