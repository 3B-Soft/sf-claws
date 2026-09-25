import { openDb } from '../src/db/db.js';
import { createRepos } from '../src/db/repos/index.js';
import { SecretBox } from '../src/lib/crypto.js';
import { AuthService } from '../src/auth/service.js';
import { GithubService } from '../src/github/service.js';
import { AiRegistry } from '../src/ai/registry.js';
import { SkillsService } from '../src/skills/service.js';
import { PolicyService } from '../src/agents/policy.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { SessionRuntime } from '../src/agents/runtime.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import type { AppContext } from '../src/app-context.js';
import type { SalesforceService } from '../src/salesforce/service.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/ai/types.js';

export function testConfig() {
  return loadConfig({
    MASTER_KEY: 'dGVzdG1hc3RlcmtleXRlc3RtYXN0ZXJrZXl0ZXN0bWFzdGVyaw==',
    JWT_SECRET: 'test-jwt-secret-value',
    DATA_DIR: '/tmp/sf-claws-test',
    LOG_LEVEL: 'error',
    SF_CLIENT_ID: 'x',
    CORS_ORIGINS: '*',
    PUBLIC_URL: 'http://localhost:1',
  });
}

/** Scripted LLM provider: each call pops the next response. */
export class FakeProvider implements LlmProvider {
  readonly provider = 'anthropic' as const;
  public requests: LlmRequest[] = [];
  /**
   * Announce each tool_use block through `onToolCall` before resolving, the way a real streaming
   * provider does, then yield the event loop so anything the agent starts early genuinely runs
   * while `complete` is still pending. Without this the early-start path is untestable.
   */
  public streamToolCalls = false;
  constructor(public script: ((req: LlmRequest) => LlmResponse)[]) {}
  async test() {
    return { ok: true, message: 'fake' };
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const next = this.script.shift();
    const resp = next
      ? next(req)
      : ({
          content: [{ type: 'text', text: 'Done.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
        } as LlmResponse);
    if (this.streamToolCalls && req.onToolCall) {
      for (const b of resp.content) if (b.type === 'tool_use') req.onToolCall({ id: b.id, name: b.name, input: b.input });
      await new Promise((r) => setTimeout(r, 10));
    }
    return resp;
  }
}
export const text = (t: string): LlmResponse => ({
  content: [{ type: 'text', text: t }],
  stopReason: 'end_turn',
  usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
});
export const toolCall = (name: string, input: unknown, id = 'tu_' + Math.random().toString(36).slice(2)): LlmResponse => ({
  content: [{ type: 'tool_use', id, name, input }],
  stopReason: 'tool_use',
  usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 },
});
/** Several tool calls in one assistant message, in the order the model emitted them. */
export const toolCalls = (calls: { name: string; input: unknown }[]): LlmResponse => ({
  content: calls.map((c, i) => ({ type: 'tool_use' as const, id: `tu_${i}_${Math.random().toString(36).slice(2)}`, name: c.name, input: c.input })),
  stopReason: 'tool_use',
  usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 },
});

export function makeContext(opts: { provider?: LlmProvider; sf?: Partial<SalesforceService>; fetch?: typeof fetch; githubToken?: string } = {}): AppContext {
  const config = testConfig();
  const db = openDb(':memory:');
  const repos = createRepos(db);
  const log = createLogger('error', false);
  const secrets = new SecretBox(config.MASTER_KEY, repos.tenantKeys);
  const auth = new AuthService(repos, config);
  const github = new GithubService(repos, secrets, log, opts.githubToken ?? '');
  const ai = new AiRegistry(repos, secrets, log);
  ai.seedDefaults();
  if (opts.provider) (ai as any).provider = () => opts.provider;
  repos.providers.set('anthropic', secrets.encrypt('sk-test'), null, 'test');
  const skills = new SkillsService(repos, log);
  const policy = new PolicyService(repos);
  const knowledge = new KnowledgeService(repos, secrets, log, opts.fetch, opts.githubToken ?? '');
  const sf = (opts.sf ?? {}) as SalesforceService;
  const base = { config, db, repos, log, secrets, auth, sf, github, ai, skills, policy, knowledge };
  const runtime = new SessionRuntime(base);
  const ctx = { ...base, runtime } as AppContext;
  runtime.bind(ctx);
  return ctx;
}

export async function seedClientOrgUser(ctx: AppContext) {
  const { user } = await ctx.auth.register({ email: 'admin@test.io', password: 'password12345', displayName: 'Admin' });
  const client = ctx.repos.clients.create({ name: 'Acme', slug: 'acme' });
  const org = ctx.repos.orgs.create({
    clientId: client.id,
    label: 'Acme UAT',
    kind: 'sandbox',
    loginUrl: 'https://test.salesforce.com',
    apiVersion: '62.0',
    protected: false,
  });
  ctx.repos.orgs.update(org.id, {
    status: 'connected',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    myDomainHost: 'acme--uat.sandbox.my.salesforce.com',
    sfOrgId: '00D000000000001AAA',
    refreshTokenEnc: ctx.secrets.encrypt('rt'),
    accessTokenEnc: ctx.secrets.encrypt('at'),
  });
  return { user, client, org: ctx.repos.orgs.byId(org.id)! };
}

/** Turn plan mode off for tests that are not about plan mode. */
export function disablePlanMode(ctx: AppContext): void {
  ctx.repos.policies.set('global', { ...(ctx.repos.policies.get('global') ?? {}), requirePlanApproval: 'never' }, 'test');
}

/** Turn the reviewer-verdict gate off for tests that are not about reviewing. */
export function disableReviewerGate(ctx: AppContext): void {
  ctx.repos.policies.set('global', { ...(ctx.repos.policies.get('global') ?? {}), requireReviewerVerdict: 'never' }, 'test');
}

/** Resolve with the first event of a type (with a timeout, so a hang fails loudly). */
export function nextEvent(ctx: AppContext, sessionId: string, type: string, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    const unsub = ctx.runtime.bus.subscribe(sessionId, (e) => {
      if (e.type === type) {
        clearTimeout(t);
        unsub();
        resolve(e);
      }
    });
  });
}

export function waitForIdle(ctx: AppContext, sessionId: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const t = setTimeout(() => reject(new Error('timeout waiting for session to finish')), timeoutMs);
    const check = () => {
      if (finished) return;
      const s = ctx.repos.sessions.byId(sessionId)!;
      if (!ctx.runtime.isRunning(sessionId) && s.status !== 'running') {
        finished = true;
        clearTimeout(t);
        unsub();
        resolve();
      }
    };
    const unsub = ctx.runtime.bus.subscribe(sessionId, () => setTimeout(check, 0));
    setTimeout(check, 0);
  });
}
