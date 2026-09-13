import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, disablePlanMode, FakeProvider, text, toolCall, waitForIdle } from './helpers.js';
import { buildSystemPrompt } from '../src/agents/prompts.js';
import { PolicyRules } from '@sf-claws/shared';

const promptFor = (ctx: any, sessionId: string) => {
  const session = ctx.repos.sessions.byId(sessionId)!;
  return buildSystemPrompt({
    role: 'orchestrator',
    client: ctx.repos.clients.byId(session.clientId)!,
    org: ctx.repos.orgs.byId(session.orgId)!,
    session,
    rules: PolicyRules.parse({}),
    skillsSection: '',
    memoryIndex: '',
    knowledgeSection: '',
    githubConfigured: false,
  });
};

describe('standing instructions', () => {
  it('puts the client and org instructions in every prompt, org last so the specific one wins', async () => {
    const ctx = makeContext();
    const { user, client, org } = await seedClientOrgUser(ctx);
    ctx.repos.clients.update(client.id, { instructions: 'Always use the ACME_ prefix for custom fields.' });
    ctx.repos.orgs.update(org.id, { instructions: 'This sandbox has no Person Accounts enabled.' });
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });

    const prompt = promptFor(ctx, session.id);
    expect(prompt).toContain('Standing instructions for this client');
    expect(prompt).toContain('ACME_ prefix');
    expect(prompt).toContain('no Person Accounts enabled');
    expect(prompt.indexOf('ACME_ prefix')).toBeLessThan(prompt.indexOf('no Person Accounts'));
    // Stable for the session, so it must sit in the cacheable half.
    expect(prompt.indexOf('ACME_ prefix')).toBeLessThan(prompt.indexOf('<!-- session-specific context below -->'));
  });

  it('says nothing at all when no instructions are set', async () => {
    const ctx = makeContext();
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    expect(promptFor(ctx, session.id)).not.toContain('Standing instructions');
  });
});

describe('page context', () => {
  it('follows the user around the org instead of freezing at session start', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: { limits: async () => ({ orgId: 'o', fetchedAt: new Date().toISOString(), limits: [], warnings: [] }) } as any });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({
      userId: user.id,
      orgId: org.id,
      uiMode: 'visual',
      pageContext: { url: 'https://acme.my.salesforce.com/lightning/r/Account/001A/view', recordId: '001A', objectApiName: 'Account' },
    });
    expect(promptFor(ctx, session.id)).toContain('record 001A');

    ctx.runtime.updatePageContext(session.id, {
      url: 'https://acme.my.salesforce.com/lightning/setup/Flows/home',
      setupPage: 'Flows',
    });
    const moved = promptFor(ctx, session.id);
    expect(moved).toContain('setup page Flows');
    expect(moved).not.toContain('record 001A');

    provider.script = [() => text('ok')];
    ctx.runtime.startTurn(session.id, user.id, 'what is here?');
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.events.listAfter(session.id).some((e: any) => e.type === 'session.page')).toBe(true);
  });

  it('ignores an unchanged or empty context rather than emitting noise', async () => {
    const ctx = makeContext();
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual', pageContext: { recordId: '001A' } });
    ctx.runtime.updatePageContext(session.id, { recordId: '001A' });
    ctx.runtime.updatePageContext(session.id, {});
    ctx.runtime.updatePageContext(session.id, { url: '' });
    expect(ctx.repos.events.listAfter(session.id).filter((e: any) => e.type === 'session.page')).toHaveLength(0);
  });
});

describe('browser capture', () => {
  const sf = { limits: async () => ({ orgId: 'o', fetchedAt: new Date().toISOString(), limits: [], warnings: [] }) };

  /** Answer the next browser.request the way the panel would. */
  function panel(ctx: any, sessionId: string, reply: (ev: any) => unknown) {
    const unsub = ctx.runtime.bus.subscribe(sessionId, (e: any) => {
      if (e.type !== 'browser.request') return;
      unsub();
      ctx.runtime.resolveBrowserCapture(sessionId, { requestId: e.requestId, dropped: 0, ...(reply(e) as object) });
    });
  }

  it('asks the panel and reports what came back, defaulting to warnings and errors', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    panel(ctx, session.id, () => ({
      console: [
        { at: '2026-09-12T10:00:00.000Z', level: 'log', text: 'component rendered', source: null },
        { at: '2026-09-12T10:00:01.000Z', level: 'error', text: 'TypeError: cannot read property Id of undefined', source: 'aura.js:12' },
      ],
    }));
    provider.script = [
      () => toolCall('read_console_logs', {}),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.content).toContain('TypeError');
        // A log-level entry is not a diagnostic; the default filter drops it.
        expect(last.content).not.toContain('component rendered');
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'the page is broken');
    await waitForIdle(ctx, session.id);
  });

  it('shows failed network calls with their body, and hides the successful ones by default', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    panel(ctx, session.id, () => ({
      network: [
        { at: '2026-09-12T10:00:00.000Z', method: 'GET', url: '/aura?ok', status: 200, durationMs: 30, error: null, responseBody: null },
        { at: '2026-09-12T10:00:01.000Z', method: 'POST', url: '/aura?bad', status: 500, durationMs: 90, error: null, responseBody: 'LIMIT_EXCEEDED' },
      ],
    }));
    provider.script = [
      () => toolCall('read_network_requests', {}),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.content).toContain('/aura?bad');
        expect(last.content).toContain('LIMIT_EXCEEDED');
        expect(last.content).not.toContain('/aura?ok');
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'saving fails silently');
    await waitForIdle(ctx, session.id);
  });

  it('tells the agent capture is unavailable rather than pretending the console was clean', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    panel(ctx, session.id, () => ({ unavailable: 'The active tab is not a Salesforce page.' }));
    provider.script = [
      () => toolCall('read_console_logs', {}),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.isError).toBe(true);
        expect(last.content).toContain('not a Salesforce page');
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'check the console');
    await waitForIdle(ctx, session.id);
  });

  it('refuses a response from another session, since a requestId is a bearer token for a pending call', async () => {
    const ctx = makeContext();
    const { user, org } = await seedClientOrgUser(ctx);
    const a = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const b = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    let requestId = '';
    ctx.runtime.bus.subscribe(a.id, (e: any) => {
      if (e.type === 'browser.request') requestId = e.requestId;
    });
    const pending = ctx.runtime.captureBrowser(a.id, 'orchestrator', 'console', { limit: 10 });
    await new Promise((r) => setTimeout(r, 10));
    expect(requestId).toBeTruthy();
    expect(ctx.runtime.resolveBrowserCapture(b.id, { requestId, dropped: 0, console: [] })).toBe(false);
    expect(ctx.runtime.resolveBrowserCapture(a.id, { requestId, dropped: 0, console: [] })).toBe(true);
    expect((await pending).unavailable).toBeFalsy();
  });
});

describe('session feedback', () => {
  it('keeps "not yet rated" distinct from "rated unhelpful"', async () => {
    const ctx = makeContext();
    const { user, org } = await seedClientOrgUser(ctx);
    const a = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const b = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    // A nullable boolean read back as false made every unrated session render as "not helpful".
    expect(ctx.repos.sessions.byId(a.id)!.helpful).toBeNull();
    ctx.repos.sessions.update(b.id, { helpful: false });
    expect(ctx.repos.sessions.byId(b.id)!.helpful).toBe(false);
    ctx.repos.sessions.update(b.id, { helpful: true });
    expect(ctx.repos.sessions.byId(b.id)!.helpful).toBe(true);
    expect(ctx.repos.sessions.list({ userId: user.id }).find((s) => s.id === a.id)!.helpful).toBeNull();
  });
});
