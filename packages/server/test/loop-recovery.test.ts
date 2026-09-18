import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCall, toolCalls, waitForIdle, disablePlanMode } from './helpers.js';
import type { LlmRequest, LlmResponse } from '../src/ai/types.js';
import { LlmError } from '../src/ai/types.js';
import { OUTPUT_CONTINUATION_TEXT, compactionBoundary } from '../src/agents/agent.js';
import { projectCallCostUsd, checkCostCeilings } from '../src/agents/cost.js';
import { validateArgs } from '../src/agents/coerce.js';
import type { AppContext } from '../src/app-context.js';

const NS = 'http://soap.sforce.com/2006/04/metadata';
const fieldXml = (label: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="${NS}"><fullName>A__c</fullName><label>${label}</label><type>Date</type></CustomField>`;

/** A provider that answers the summariser (no tools) with a fixed summary and scripts the rest. */
class SummaryAwareProvider extends FakeProvider {
  public summaries = 0;
  override async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!req.tools.length && req.system.includes('hand-over document')) {
      this.summaries++;
      this.requests.push(req);
      return text('<analysis>draft</analysis>\n1. Primary request and intent\nuser asked to look around');
    }
    return super.complete(req);
  }
}

/** Bind the orchestrator to a model with a tiny context window so compaction is reachable in a test. */
function bindTinyOrchestrator(ctx: AppContext): void {
  const tiny = ctx.repos.models.create({
    provider: 'anthropic',
    modelId: 'tiny-context',
    label: 'Tiny',
    enabled: true,
    inputCostPerM: 1,
    outputCostPerM: 1,
    cachedInputCostPerM: 0.1,
    maxOutputTokens: 8000,
    contextWindow: 3000,
    supportsThinking: false,
  });
  ctx.repos.bindings.setAll(ctx.repos.bindings.list().map((b) => (b.role === 'orchestrator' ? { ...b, modelId: tiny.id } : b)));
}

const wideDescribe = (name: string) => ({
  name,
  fields: Array.from({ length: 40 }, (_, i) => ({
    name: `${name}_Field_${i}__c`,
    label: `Field ${i}`,
    type: 'Text',
    length: 255,
    custom: true,
    nillable: true,
  })),
});

describe('fallback model', () => {
  it('records the model that actually answered, for replay and for billing', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const fail = () => {
      throw new LlmError('overloaded', 'anthropic', true, 529, { retryAfterSeconds: 0.001 });
    };
    provider.script = [fail, fail, fail, fail, () => ({ ...text('answered by the fallback'), raw: [{ type: 'text', text: 'answered by the fallback' }] })];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);

    const primary = ctx.ai.resolve('orchestrator', user.id);
    const fallback = primary.fallback!.model;
    expect(fallback.modelId).not.toBe(primary.model.modelId);
    expect(provider.requests.at(-1)!.model.modelId).toBe(fallback.modelId);
    // Billed at the fallback's price, under its id.
    const usage = ctx.repos.usage.bySession(session.id);
    expect(usage).toHaveLength(1);
    expect(usage[0].modelId).toBe(fallback.modelId);
    const timing = ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'model.finished');
    expect(timing.map((e) => e.outcome)).toEqual(['failed', 'failed', 'failed', 'failed', 'completed']);
    expect(timing.at(-1)!.modelId).toBe(fallback.modelId);
    expect(usage[0].costUsd).toBeCloseTo((100 * fallback.inputCostPerM + 20 * fallback.outputCostPerM) / 1_000_000, 10);
    // The raw content is tagged with the fallback, so the primary never replays its signatures.
    const assistant = ctx.repos.messages.list(session.id, 'orchestrator').find((m) => m.role === 'assistant')!;
    expect((assistant.content as { raw?: { modelId: string } }).raw?.modelId).toBe(fallback.modelId);
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('idle');
  });
});

describe('compaction', () => {
  it('keeps the real tail verbatim, cuts at an assistant message, and clears the read memo', async () => {
    const provider = new SummaryAwareProvider([]);
    const describes: string[] = [];
    const ctx = makeContext({
      provider,
      sf: {
        describe: async (_o: string, name: string) => {
          describes.push(name);
          return wideDescribe(name);
        },
      } as never,
    });
    disablePlanMode(ctx);
    bindTinyOrchestrator(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    let repeatResult = '';
    provider.script = [
      () => toolCall('describe_sobject', { sobject: 'Alpha' }),
      () => toolCall('describe_sobject', { sobject: 'Beta' }),
      () => toolCall('describe_sobject', { sobject: 'Gamma' }),
      () => toolCall('describe_sobject', { sobject: 'Delta' }),
      (req) => {
        // Compaction ran before this call: the head is a summary, the tail is intact tool pairs.
        const first = req.messages[0].content[0] as { text: string };
        expect(first.text).toContain('[Conversation so far, compacted');
        expect(first.text).not.toContain('<analysis>');
        expect(first.text).toContain('Continue from where the transcript left off');
        expect(req.messages[1].role).toBe('assistant');
        const results = req.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as { content: string }[];
        expect(results.some((r) => r.content.includes('Delta_Field_39__c'))).toBe(true);
        expect(results.some((r) => r.content.includes('Gamma_Field_39__c'))).toBe(true);
        return toolCall('describe_sobject', { sobject: 'Alpha' });
      },
      (req) => {
        repeatResult = (req.messages.at(-1)!.content[0] as { content: string }).content;
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'look around');
    await waitForIdle(ctx, session.id);
    expect(provider.summaries).toBeGreaterThanOrEqual(1);
    // The earlier Alpha result was summarised away, so the memo must not answer with a stub.
    expect(describes.filter((d) => d === 'Alpha')).toHaveLength(2);
    expect(repeatResult).not.toContain('Unchanged since');
    expect(repeatResult).toContain('Alpha_Field_0__c');
    // The pre-compaction transcript is reachable as an artifact.
    expect(ctx.repos.artifacts.bytesForSession(session.id)).toBeGreaterThan(0);
    // The summariser call was accounted for.
    expect(ctx.repos.usage.bySession(session.id).some((u) => u.role === 'summarizer')).toBe(true);
    expect(ctx.repos.events.listAfter(session.id).some((e) => e.type === 'model.finished' && e.purpose === 'compaction' && e.role === 'summarizer')).toBe(true);
    // The compacted conversation was persisted in a shape the next turn can load.
    provider.script = [() => text('second turn')];
    ctx.runtime.startTurn(session.id, user.id, 'and again');
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('idle');
    expect((provider.requests.at(-1)!.messages[0].content[0] as { text: string }).text).toContain('[Conversation so far, compacted');
  });

  it('chooses a boundary that leaves the tail starting with an assistant message', () => {
    const u = { role: 'user' as const, content: [{ type: 'text' as const, text: 'u' }] };
    const a = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a' }] };
    expect(compactionBoundary([u, a, u, a, u, a, u, a, u], 6)).toBe(3);
    expect(compactionBoundary([u, a, u, a, u, a, u, a, u, a, u], 6)).toBe(5);
    expect(compactionBoundary([u, a, u], 6)).toBeNull();
  });
});

describe('output-limit recovery', () => {
  it('widens the slot and sends a continuation instruction instead of replaying the truncated turn', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    let secondMax = 0;
    provider.script = [
      () => ({ ...text('first half of a long answer'), stopReason: 'max_tokens' }),
      (req) => {
        secondMax = req.maxTokens ?? 0;
        const last = req.messages.at(-1)!;
        expect(last.role).toBe('user');
        expect((last.content[0] as { text: string }).text).toBe(OUTPUT_CONTINUATION_TEXT);
        return text('second half');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'explain everything');
    await waitForIdle(ctx, session.id);
    expect(provider.requests[0].maxTokens).toBe(8000);
    expect(secondMax).toBeGreaterThan(8000);
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('idle');
  });
});

describe('cost projection', () => {
  it('prices a call from its estimated input and the reserved output slot', () => {
    expect(projectCallCostUsd({ inputCostPerM: 5, outputCostPerM: 25 }, 100_000, 8000)).toBeCloseTo(0.7, 10);
  });

  it('refuses a call whose projected price would cross the ceiling, before any money is spent', () => {
    const rules = { maxTurnCostUsd: 0, maxSessionCostUsd: 5, maxClientMonthlyCostUsd: 0, costCeilingDocReserveUsd: 0 };
    const base = { rules, turnCostUsd: 0, sessionCostUsd: 4, clientMonthCostUsd: 0 };
    expect(checkCostCeilings({ ...base, projectedUsd: 0.5 })).toBeNull();
    const err = checkCostCeilings({ ...base, projectedUsd: 1.5 });
    expect(err?.scope).toBe('session');
    expect(err?.message).toContain('would be crossed');
  });
});

describe('stuck-loop detection on validation failures', () => {
  it('stops a builder loop whose cosmetic edits keep producing the same failure set', async () => {
    const provider = new FakeProvider([]);
    let validations = 0;
    const sf = {
      readComponent: async () => [],
      deploy: async (_o: string, files: { path: string }[], opts: { checkOnly: boolean }) => {
        validations++;
        return {
          ok: false,
          sfDeployId: '0Af1',
          status: 'Failed',
          checkOnly: opts.checkOnly,
          componentsTotal: files.length,
          componentsDeployed: 0,
          componentsFailed: 1,
          testsTotal: 0,
          testsFailed: 0,
          codeCoverage: null,
          failures: [
            {
              componentType: 'CustomField',
              fullName: 'Account.A__c',
              fileName: null,
              problem: 'Label is required',
              problemType: 'Error',
              lineNumber: 2,
              columnNumber: 1,
            },
          ],
          testFailures: [],
          coverageWarnings: [],
          errorMessage: null,
        };
      },
    };
    const ctx = makeContext({ provider, sf: sf as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const path = 'objects/Account/fields/A__c.field-meta.xml';
    let calls = 0;
    provider.script = [
      () => toolCall('write_workspace_file', { path, content: fieldXml('One') }),
      () => toolCall('validate_deployment', {}),
      () => toolCall('write_workspace_file', { path, content: fieldXml('Two') }),
      () => toolCall('validate_deployment', {}),
      () => toolCall('write_workspace_file', { path, content: fieldXml('Three') }),
      () => toolCall('validate_deployment', {}),
      (req) => {
        // Only the builder loop counts: the documentation guarantee's doc_writer also draws from the script.
        if (req.tools.some((t) => t.name === 'write_workspace_file')) calls++;
        return text('DOCUMENTED');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'add the field');
    await waitForIdle(ctx, session.id);
    expect(validations).toBe(3);
    expect(calls).toBe(0);
    expect(ctx.repos.compileControl.get(session.id).stopped).toContain('two compiles without a smaller root-error set');
    expect(provider.requests).toHaveLength(6); // no paid wrap-up or documentation after the hard stop
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('failed');
  });
});

describe('forced wrap-up', () => {
  it('asks a sub-agent that hit its step limit for a tool-less report instead of returning junk', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    ctx.repos.bindings.setAll(ctx.repos.bindings.list().map((b) => (b.role === 'analyst' ? { ...b, maxIterations: 2 } : b)));
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    let report = '';
    provider.script = [
      () => toolCall('run_subagent', { role: 'analyst', objective: 'inventory the workspace' }),
      () => toolCall('list_workspace', {}),
      () => toolCall('todo_read', {}),
      (req) => {
        expect(req.tools).toHaveLength(0);
        expect((req.messages.at(-1)!.content[0] as { text: string }).text).toContain('step limit');
        return text('FINDINGS: the workspace is empty. Did not get to: nothing else.');
      },
      (req) => {
        report = (req.messages.at(-1)!.content[0] as { content: string }).content;
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);
    expect(report).toContain('FINDINGS: the workspace is empty');
    expect(ctx.repos.events.listAfter(session.id).some((e) => e.type === 'model.finished' && e.purpose === 'wrap_up' && e.role === 'analyst')).toBe(true);
  });
});

describe('argument validation', () => {
  it('reports missing required arguments and type mismatches in a usable message', () => {
    const schema = {
      type: 'object',
      properties: { sobject: { type: 'string' }, limit: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] } },
      required: ['sobject'],
    };
    expect(validateArgs({ sobject: 'Account' }, schema)).toBeNull();
    expect(validateArgs({}, schema)).toContain('"sobject" is required');
    expect(validateArgs({ sobject: 'Account', mode: 'c' }, schema)).toContain('must be one of a, b');
    expect(validateArgs({ sobject: 'Account', limit: 'lots' }, schema)).toContain('"limit" must be a number');
  });

  it('refuses a tool call with missing required arguments before the tool runs', async () => {
    const provider = new FakeProvider([]);
    let described = 0;
    const ctx = makeContext({
      provider,
      sf: {
        describe: async () => {
          described++;
          return { name: 'x', fields: [] };
        },
      } as never,
    });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCalls([
          { name: 'describe_sobject', input: {} },
          { name: 'todo_write', input: {} },
        ]),
      (req) => {
        const results = req.messages.at(-1)!.content as { content: string; isError: boolean }[];
        expect(results[0].isError).toBe(true);
        expect(results[0].content).toContain('"sobject" is required');
        expect(results[1].isError).toBe(true);
        expect(results[1].content).toContain('"items" is required');
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);
    expect(described).toBe(0);
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('idle');
  });
});

describe('turn hygiene', () => {
  it('unsubscribes the turn listener on normal completion', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [() => toolCall('run_subagent', { role: 'analyst', objective: 'x' }), () => text('FINDINGS: none'), () => text('done')];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);
    expect(ctx.runtime.bus.listenerCount(session.id)).toBe(0);
  });

  it('does not start a paid researcher while the message is still streaming', async () => {
    const order: string[] = [];
    const provider = new FakeProvider([]);
    provider.streamToolCalls = true;
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.runtime.bus.subscribe(session.id, (e) => {
      if (e.type === 'tool.call') order.push(`call:${e.tool}`);
    });
    provider.script = [
      () => {
        setTimeout(() => order.push('completion-returned'), 0);
        return toolCalls([
          { name: 'investigate_product_repo', input: { repo: 'nowhere', question: 'q' } },
          { name: 'list_workspace', input: {} },
        ]);
      },
      () => text('done'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);
    expect(order.indexOf('completion-returned')).toBeLessThan(order.indexOf('call:investigate_product_repo'));
    // The window closed behind it: the read after it did not jump ahead either.
    expect(order.indexOf('completion-returned')).toBeLessThan(order.indexOf('call:list_workspace'));
  });
});

describe('tool results reach the budget layer whole', () => {
  it('spills an oversized query result to an artifact instead of clipping it inside the tool, and keeps describe compact', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({
      provider,
      sf: {
        query: async () => ({
          totalSize: 400,
          done: true,
          records: Array.from({ length: 400 }, (_, i) => ({ Id: `001${i}`, Name: `Account ${i}`, Description: 'x'.repeat(150) })),
        }),
        describe: async () => ({
          ...wideDescribe('Account'),
          urls: { sobject: '/services/data/v62.0/sobjects/Account' },
          recordTypeInfos: [{ name: 'Master', developerName: 'Master', recordTypeId: '012', active: true }],
          childRelationships: [{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' }],
        }),
      } as never,
    });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const results: string[] = [];
    const grab = (req: LlmRequest) => results.push((req.messages.at(-1)!.content[0] as { content: string }).content);
    provider.script = [
      () => toolCall('soql_query', { soql: 'SELECT Id, Name, Description FROM Account' }),
      (req) => {
        grab(req);
        return toolCall('describe_sobject', { sobject: 'Account' });
      },
      (req) => {
        grab(req);
        return toolCall('describe_sobject', { sobject: 'Account', include: ['childRelationships'] });
      },
      (req) => {
        grab(req);
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);
    expect(results[0]).toContain('read_tool_output');
    expect(results[0]).not.toContain('...[truncated');
    expect(ctx.repos.artifacts.bytesForSession(session.id)).toBeGreaterThan(40_000);
    expect(results[1]).not.toContain('"urls"');
    expect(results[1]).not.toContain('"childRelationships"');
    expect(results[1]).not.toContain('"recordTypeInfos"');
    expect(results[1]).toContain('"childRelationshipCount": 1');
    expect(results[2]).toContain('"childRelationships"');
    expect(results[2]).toContain('Contacts');
  });
});
