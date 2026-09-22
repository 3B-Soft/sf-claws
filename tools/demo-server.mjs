/**
 * Demo server: the real SF Claws control plane on a temporary database, seeded with a plausible
 * session so the UI can be driven, reviewed and screenshotted without a Salesforce org, a model
 * provider or a GitHub token.
 *
 * Everything the UI sees is real — real routes, real SQLite, real SSE. Only the *inputs* are
 * fabricated: the session's event log is written directly, the way a completed turn would have
 * left it. That keeps the screenshots honest: if a component renders wrong here, it renders wrong
 * in production too.
 *
 *   bun tools/demo-server.mjs [--port 8799]
 *
 * Prints the credentials and the ids it created, then stays up until interrupted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext } from '../packages/server/dist/index.js';
import { buildApp } from '../packages/server/dist/http/app.js';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8799;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-claws-demo-'));

const EMAIL = 'demo@sfclaws.dev';
const PASSWORD = 'demo-password-1234';

const ctx = await createContext({
  DATA_DIR: dataDir,
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  JWT_SECRET: 'demo-jwt-secret-not-for-production',
  LOG_LEVEL: 'error',
  SF_CLIENT_ID: 'demo',
  CORS_ORIGINS: '*',
  PUBLIC_URL: `http://localhost:${port}`,
  PORT: String(port),
});
ctx.ai.seedDefaults();
ctx.skills.seedFromDir(path.resolve(process.cwd(), 'packages/server/skills'));

// ---------------------------------------------------------------- seed
const { user } = await ctx.auth.register({ email: EMAIL, password: PASSWORD, displayName: 'Dana Okafor' });
const client = ctx.repos.clients.create({ name: 'Northwind Energy', slug: 'northwind', description: 'Utilities · 400 seats' });
ctx.repos.clients.update(client.id, {
  instructions: [
    '# Conventions',
    '- Custom fields are prefixed `NW_` and always carry a description.',
    '- Flows are named `<Object>_<Trigger>_<Purpose>`, e.g. `Contract_BeforeSave_SetRenewalDate`.',
    '',
    '# What we run',
    '- Vlocity Energy is installed. Never modify its managed components; extend with our own instead.',
  ].join('\n'),
});
const org = ctx.repos.orgs.create({
  clientId: client.id,
  label: 'Northwind UAT',
  kind: 'sandbox',
  loginUrl: 'https://test.salesforce.com',
  apiVersion: '62.0',
  protected: false,
});
ctx.repos.orgs.update(org.id, {
  status: 'connected',
  instanceUrl: 'https://northwind--uat.sandbox.my.salesforce.com',
  myDomainHost: 'northwind--uat.sandbox.my.salesforce.com',
  sfOrgId: '00D5g000004XyZ1EAK',
  username: 'dana@northwind.com.uat',
  lastConnectedAt: new Date().toISOString(),
  accessTokenEnc: ctx.secrets.encrypt('demo'),
  refreshTokenEnc: ctx.secrets.encrypt('demo'),
  instructions: 'Person Accounts are not enabled in this sandbox. It is refreshed from production every Friday at 18:00 UTC.',
});

const session = ctx.runtime.createSession({
  userId: user.id,
  orgId: org.id,
  uiMode: 'visual',
  title: 'Add a renewal date to Contract',
  pageContext: {
    url: 'https://northwind--uat.sandbox.my.salesforce.com/lightning/o/Contract/list',
    objectApiName: 'Contract',
  },
});

// createSession already emitted its own events; continue after them rather than colliding.
let seq = ctx.repos.events.listAfter(session.id).reduce((m, e) => Math.max(m, e.seq || 0), 0);
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const ev = (e, minutesAgo) => ctx.repos.events.append(session.id, ++seq, { ...e, sessionId: session.id, seq, at: at(minutesAgo) });

ev({ type: 'user.message', text: 'Contracts need a renewal date that is 12 months after the start date, and it should show on the contract page.' }, 9);
ev({ type: 'agent.spawned', agentId: 'orchestrator', role: 'orchestrator', parentId: null, objective: null }, 9);
ev(
  {
    type: 'tool.call',
    agentId: 'orchestrator',
    role: 'orchestrator',
    toolCallId: 't1',
    tool: 'describe_sobject',
    label: 'Describe Contract',
    input: { sobject: 'Contract' },
  },
  9,
);
ev(
  {
    type: 'tool.result',
    agentId: 'orchestrator',
    role: 'orchestrator',
    toolCallId: 't1',
    tool: 'describe_sobject',
    ok: true,
    durationMs: 640,
    resultChars: 4820,
    preview: 'Contract: 41 fields. StartDate (Date), ContractTerm (Number), EndDate (Date, read-only, formula)…',
  },
  9,
);
ev(
  {
    type: 'todo.updated',
    items: [
      { id: 't1', content: 'Check what date fields Contract already has', status: 'completed' },
      { id: 't2', content: 'Add NW_Renewal_Date__c as a formula field', status: 'completed' },
      { id: 't3', content: 'Add it to the Contract layout', status: 'in_progress' },
      { id: 't4', content: 'Validate against the sandbox', status: 'pending' },
      { id: 't5', content: 'Document the change', status: 'pending' },
    ],
  },
  7,
);
ev(
  {
    type: 'assistant.message',
    agentId: 'orchestrator',
    role: 'orchestrator',
    messageId: 'm1',
    text: [
      'Contract already has **Start Date** and a read-only **End Date** formula, so I will add a separate field rather than touch the existing one.',
      '',
      'I have staged a formula field **Renewal Date** (`NW_Renewal_Date__c`) that adds 12 months to Start Date, and added it to the Contract layout under Dates. Nothing is in the org yet — I will validate it next, then ask you before anything is saved.',
    ].join('\n'),
  },
  6,
);
ev(
  {
    type: 'workspace.file',
    path: 'objects/Contract/fields/NW_Renewal_Date__c.field-meta.xml',
    action: 'created',
    metadataType: 'CustomField',
    fullName: 'Contract.NW_Renewal_Date__c',
  },
  6,
);
ev(
  {
    type: 'workspace.file',
    path: 'layouts/Contract-Contract Layout.layout-meta.xml',
    action: 'modified',
    metadataType: 'Layout',
    fullName: 'Contract-Contract Layout',
  },
  5,
);
ev(
  {
    type: 'deploy.validation',
    deployId: 'dep1',
    ok: true,
    attempt: 1,
    componentsTotal: 2,
    componentsFailed: 0,
    testsTotal: 0,
    testsFailed: 0,
    codeCoverage: null,
    failures: [],
  },
  4,
);
ev(
  {
    type: 'confirmation.requested',
    confirmationId: 'cf1',
    kind: 'deploy',
    title: 'Deploy 2 changes to Northwind UAT?',
    description: 'Adds a Renewal Date field to Contract and puts it on the contract page. Validation passed with no failures.',
    details: {
      org: { label: 'Northwind UAT', kind: 'sandbox', protected: false },
      validation: { attempt: 1, componentsTotal: 2, testsTotal: 0, codeCoverage: null },
      files: [
        {
          path: 'objects/Contract/fields/NW_Renewal_Date__c.field-meta.xml',
          action: 'created',
          metadataType: 'CustomField',
          fullName: 'Contract.NW_Renewal_Date__c',
        },
        { path: 'layouts/Contract-Contract Layout.layout-meta.xml', action: 'modified', metadataType: 'Layout', fullName: 'Contract-Contract Layout' },
      ],
    },
    options: [
      { id: 'deploy', label: 'Deploy to Northwind UAT', style: 'primary' },
      { id: 'cancel', label: 'Not now', style: 'secondary' },
    ],
    command: null,
  },
  3,
);
const usage = { inputTokens: 48210, outputTokens: 3140, cachedInputTokens: 41800, costUsd: 0.1873 };
ev({ type: 'session.usage', ...usage }, 3);
ctx.repos.sessions.addUsage(session.id, usage);
ctx.repos.usage.add({
  sessionId: session.id,
  userId: user.id,
  clientId: client.id,
  role: 'orchestrator',
  provider: 'anthropic',
  modelId: 'claude-opus-5',
  ...usage,
  durationMs: 8400,
});
ev({ type: 'session.status', status: 'awaiting_confirmation', message: 'Deploy 2 changes to Northwind UAT?' }, 3);

ctx.repos.confirmations.create({
  sessionId: session.id,
  kind: 'deploy',
  title: 'Deploy 2 changes to Northwind UAT?',
  payload: {
    description: 'Adds a Renewal Date field to Contract and puts it on the contract page. Validation passed with no failures.',
    details: {},
    options: [
      { id: 'deploy', label: 'Deploy to Northwind UAT', style: 'primary' },
      { id: 'cancel', label: 'Not now', style: 'secondary' },
    ],
  },
});
ctx.repos.workspace.upsert(session.id, {
  path: 'objects/Contract/fields/NW_Renewal_Date__c.field-meta.xml',
  content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>NW_Renewal_Date__c</fullName>
    <label>Renewal Date</label>
    <type>Date</type>
    <formula>ADDMONTHS(StartDate, 12)</formula>
    <description>Twelve months after the contract start date. Added for the 2026 renewals programme.</description>
</CustomField>
`,
  original: null,
  metadataType: 'CustomField',
  fullName: 'Contract.NW_Renewal_Date__c',
  action: 'created',
});
ctx.repos.workspace.upsert(session.id, {
  path: 'layouts/Contract-Contract Layout.layout-meta.xml',
  content: `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <label>Dates</label>
        <layoutColumns>
            <layoutItems><behavior>Readonly</behavior><field>StartDate</field></layoutItems>
            <layoutItems><behavior>Readonly</behavior><field>NW_Renewal_Date__c</field></layoutItems>
        </layoutColumns>
        <style>TwoColumnsTopToBottom</style>
    </layoutSections>
</Layout>
`,
  original: `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <label>Dates</label>
        <layoutColumns>
            <layoutItems><behavior>Readonly</behavior><field>StartDate</field></layoutItems>
        </layoutColumns>
        <style>TwoColumnsTopToBottom</style>
    </layoutSections>
</Layout>
`,
  metadataType: 'Layout',
  fullName: 'Contract-Contract Layout',
  action: 'modified',
});
ctx.repos.todos.set(session.id, [
  { id: 't1', content: 'Check what date fields Contract already has', activeForm: 'Checking Contract fields', status: 'completed' },
  { id: 't2', content: 'Add NW_Renewal_Date__c as a formula field', activeForm: 'Adding the field', status: 'completed' },
  { id: 't3', content: 'Add it to the Contract layout', activeForm: 'Updating the layout', status: 'in_progress' },
  { id: 't4', content: 'Validate against the sandbox', activeForm: 'Validating', status: 'pending' },
  { id: 't5', content: 'Document the change', activeForm: 'Writing documentation', status: 'pending' },
]);
ctx.repos.sessions.update(session.id, { status: 'awaiting_confirmation' });

const app = await buildApp(ctx);
await app.listen({ port, host: '127.0.0.1' });

const token = (await ctx.auth.login(EMAIL, PASSWORD, 'demo')).token;
process.stdout.write(
  `${JSON.stringify({ url: `http://localhost:${port}`, email: EMAIL, password: PASSWORD, token, clientId: client.id, orgId: org.id, sessionId: session.id, dataDir }, null, 2)}\n`,
);

const shutdown = async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
