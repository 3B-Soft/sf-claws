import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCalls, waitForIdle } from './helpers.js';
import { anthropicSystemBlocks } from '../src/ai/anthropic.js';
import { splitSystemPrompt, SYSTEM_CACHE_BOUNDARY } from '../src/ai/types.js';
import { DYNAMIC_BOUNDARY, buildPromptSections, buildMemoryIndex, parseReviewVerdict, compactInstructionsFrom, stripAnalysis } from '../src/agents/prompts.js';
import { PromptCacheProbe, describeCacheBreak } from '../src/agents/cache-probe.js';
import { PolicyRules } from '@sf-claws/shared';

/**
 * The cache boundary is only worth anything if the provider splits on it. These pin the split at
 * the provider, the objective's place outside the cached prefix, and the probe that names the
 * section responsible when the cache read shrinks.
 */
describe('prompt cache split', () => {
  it('sends the Anthropic system prompt as two blocks with the breakpoint on the stable one only', () => {
    const blocks = anthropicSystemBlocks(`stable part\n\n${DYNAMIC_BOUNDARY}\n\ndynamic part`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('stable part');
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].text).toBe('dynamic part');
    expect(blocks[1].cache_control).toBeUndefined();
    // No boundary (the summariser's prompt): one cached block, nothing else.
    expect(anthropicSystemBlocks('just one block')).toHaveLength(1);
    expect(DYNAMIC_BOUNDARY).toBe(SYSTEM_CACHE_BOUNDARY);
    expect(splitSystemPrompt('a')).toEqual({ stable: 'a', dynamic: '' });
  });

  it('puts the session state, memory index and spend ceilings after the boundary and everything else before it', async () => {
    const ctx = makeContext();
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const sections = buildPromptSections({
      role: 'orchestrator',
      client: ctx.repos.clients.byId(session.clientId)!,
      org: ctx.repos.orgs.byId(session.orgId)!,
      session: ctx.repos.sessions.byId(session.id)!,
      rules: PolicyRules.parse({ maxSessionCostUsd: 5 }),
      skillsSection: '',
      memoryIndex: '## Memory\n- yesterday — Added a field',
      knowledgeSection: '',
      githubConfigured: false,
      tools: ['todo_write', 'ask_user', 'read_tool_output', 'request_deploy'],
    });
    const names = sections.map((s) => s.name);
    const boundary = names.indexOf('boundary');
    expect(boundary).toBeGreaterThan(0);
    for (const dynamic of ['session', 'memory']) expect(names.indexOf(dynamic)).toBeGreaterThan(boundary);
    for (const stable of ['identity', 'context', 'rules', 'policy', 'guidance']) expect(names.indexOf(stable)).toBeLessThan(boundary);
    const text = sections.map((s) => s.text).join('\n\n');
    // Ceilings are raised mid-session as the documented recovery path, so they cannot sit in the cached half.
    expect(text.indexOf('Spend ceiling')).toBeGreaterThan(text.indexOf(DYNAMIC_BOUNDARY));
    expect(sections.find((s) => s.name === 'policy')!.text).not.toContain('Spend ceiling');
    expect(text).toContain('<system-reminder>');
  });

  it('describes only the tools a role actually holds', async () => {
    const ctx = makeContext();
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const base = {
      client: ctx.repos.clients.byId(session.clientId)!,
      org: ctx.repos.orgs.byId(session.orgId)!,
      session: ctx.repos.sessions.byId(session.id)!,
      rules: PolicyRules.parse({}),
      skillsSection: '',
      memoryIndex: '',
      knowledgeSection: '',
      githubConfigured: false,
    };
    const researcher = buildPromptSections({ ...base, role: 'researcher', tools: ['grep_repo', 'read_repo_file', 'scratchpad_write'] })
      .map((s) => s.text)
      .join('\n');
    expect(researcher).not.toContain('read_tool_output');
    expect(researcher).not.toContain('todo_write');
    expect(researcher).not.toContain('VISUAL');
    const builder = buildPromptSections({ ...base, role: 'metadata_builder', tools: ['write_workspace_file', 'validate_deployment', 'scratchpad_write'] })
      .map((s) => s.text)
      .join('\n');
    expect(builder).not.toContain('VISUAL');
    expect(builder).toContain('COMPONENTS TOUCHED');
    expect(builder).not.toContain('KEY FILES');
  });

  it('gives two sub-agents with different objectives a byte-identical system prompt', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCalls([
          { name: 'run_subagent', input: { role: 'analyst', objective: 'Count the accounts' } },
          { name: 'run_subagent', input: { role: 'analyst', objective: 'List the validation rules on Contact' } },
        ]),
      () => text('FINDINGS: a'),
      () => text('FINDINGS: b'),
      () => text('done'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'look around');
    await waitForIdle(ctx, session.id);
    const subs = provider.requests.filter((r) => (r.messages[0].content[0] as { text?: string }).text?.includes('Your objective for this run'));
    expect(subs).toHaveLength(2);
    expect(subs[0].system).toBe(subs[1].system);
    expect(subs[0].system).not.toContain('Count the accounts');
    const objectives = subs.map((r) => (r.messages[0].content[0] as { text: string }).text);
    expect(objectives.some((o) => o.includes('Count the accounts'))).toBe(true);
    expect(objectives.some((o) => o.includes('validation rules on Contact'))).toBe(true);
  });

  it('runs a worker at the effort the orchestrator picks, capped at the orchestrator binding', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    const { user, org } = await seedClientOrgUser(ctx);
    ctx.repos.bindings.setAll(ctx.repos.bindings.list().map((b) => ({ ...b, effort: b.role === 'orchestrator' ? 'high' : 'xhigh' })));
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCalls([
          { name: 'run_subagent', input: { role: 'analyst', objective: 'Count the accounts', effort: 'low' } },
          { name: 'run_subagent', input: { role: 'analyst', objective: 'Trace the Contact trigger', effort: 'max' } },
          { name: 'run_subagent', input: { role: 'analyst', objective: 'List the Contact fields' } },
        ]),
      () => text('a'),
      () => text('b'),
      () => text('c'),
      () => text('done'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'look around');
    await waitForIdle(ctx, session.id);
    const effortFor = (objective: string) => provider.requests.find((r) => (r.messages[0].content[0] as { text?: string }).text?.includes(objective))!.effort;
    expect(effortFor('Count the accounts')).toBe('low');
    expect(effortFor('Trace the Contact trigger')).toBe('high');
    expect(effortFor('List the Contact fields')).toBe('high');
  });
});

describe('cache-break probe', () => {
  it('names the section whose hash changed when the cached read drops', () => {
    const probe = new PromptCacheProbe();
    const usage = (cached: number) => ({ inputTokens: 10, outputTokens: 1, cachedInputTokens: cached });
    expect(
      probe.observe(
        'a',
        [
          { name: 'identity', text: 'x' },
          { name: 'session', text: 'y' },
        ],
        [],
        usage(1000),
      ),
    ).toBeNull();
    // Grew: fine.
    expect(
      probe.observe(
        'a',
        [
          { name: 'identity', text: 'x' },
          { name: 'session', text: 'z' },
        ],
        [],
        usage(1200),
      ),
    ).toBeNull();
    const brk = probe.observe(
      'a',
      [
        { name: 'identity', text: 'CHANGED' },
        { name: 'session', text: 'z' },
      ],
      [],
      usage(100),
    );
    expect(brk?.changed).toEqual(['identity']);
    expect(describeCacheBreak(brk!)).toContain('identity');
    // A different agent has its own history.
    expect(probe.observe('b', [{ name: 'identity', text: 'x' }], [], usage(5))).toBeNull();
    const conv = probe.observe('b', [{ name: 'identity', text: 'x' }], [], usage(1));
    expect(conv?.changed).toEqual([]);
    expect(describeCacheBreak(conv!)).toContain('conversation prefix was rewritten');
  });
});

describe('prompt helpers', () => {
  it('parses the reviewer verdict line, last one wins, and tolerates markdown emphasis', () => {
    expect(parseReviewVerdict('BLOCKERS: none\nVERDICT: PASS')).toBe('PASS');
    expect(parseReviewVerdict('**VERDICT: FAIL**')).toBe('FAIL');
    expect(parseReviewVerdict('VERDICT: PASS\n...\nVERDICT: PARTIAL')).toBe('PARTIAL');
    expect(parseReviewVerdict('looks fine')).toBeNull();
  });

  it('extracts a client compact-instructions block and strips the summariser analysis', () => {
    expect(compactInstructionsFrom('# Acme\n## Compact instructions\nKeep every Case number.\n## Other\nx')).toBe('Keep every Case number.');
    expect(compactInstructionsFrom('no such block')).toBeNull();
    expect(stripAnalysis('<analysis>thinking</analysis>\n1. Primary request')).toBe('1. Primary request');
  });
});

describe('memory index', () => {
  it('lists lessons before routine documents, however old they are', () => {
    const doc = (title: string, createdAt: string, tags: string[]) =>
      ({
        id: title,
        sessionId: 's',
        clientId: 'c',
        orgId: 'o',
        path: `${title}.md`,
        title,
        markdown: '',
        summary: '',
        tags,
        createdAt,
        updatedAt: createdAt,
      }) as any;
    const index = buildMemoryIndex(
      [
        doc('Renewal date field', '2026-09-10T00:00:00Z', ['field']),
        doc('Guest email: platform event, not async path', '2026-01-05T00:00:00Z', ['lesson', 'flow']),
      ],
      new Date('2026-09-15T00:00:00Z'),
    );
    expect(index.indexOf('Guest email')).toBeLessThan(index.indexOf('Renewal date field'));
    expect(index).toContain('tagged "lesson"');
  });
});
