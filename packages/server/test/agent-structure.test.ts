import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCall, waitForIdle, disablePlanMode } from './helpers.js';
import { TOOLS, toolsForRole, globToRegExp, type ToolContext } from '../src/agents/tools.js';
import { forkMessages } from '../src/agents/fork.js';
import { unansweredToolUseIds } from '../src/agents/conversation.js';
import { searchWeb } from '../src/agents/web-tools.js';
import { validateArgs } from '../src/agents/coerce.js';
import type { LlmMessage } from '../src/ai/types.js';

async function setup(provider = new FakeProvider([])) {
  const app = makeContext({ provider });
  const { user, org, client } = await seedClientOrgUser(app);
  const session = app.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
  const ctx: ToolContext = {
    app,
    runtime: app.runtime,
    session: app.repos.sessions.byId(session.id)!,
    org: app.repos.orgs.byId(org.id)!,
    client,
    rules: app.policy.effective(client.id),
    agent: { id: 'orchestrator', role: 'orchestrator', parentId: null },
    signal: new AbortController().signal,
    originals: new Map(),
  };
  return { app, ctx, session, user, org, provider };
}
const call = (name: string, input: unknown, ctx: ToolContext) => TOOLS.find((t) => t.name === name)!.run(input, ctx);

describe('agent definitions and capabilities', () => {
  it('enforces exploration/planning boundaries and preserves implementation and verification tools', () => {
    for (const role of ['explore', 'plan', 'analyst'] as const) {
      const names = toolsForRole(role).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['glob', 'grep', 'web_search', 'send_message']));
      for (const forbidden of [
        'write_workspace_file',
        'execute_anonymous_apex',
        'create_record',
        'validate_deployment',
        'run_subagent',
        'investigate_product_repo',
      ])
        expect(names).not.toContain(forbidden);
    }
    expect(toolsForRole('general').map((t) => t.name)).toContain('write_workspace_file');
    const verify = toolsForRole('verify').map((t) => t.name);
    expect(verify).toEqual(expect.arrayContaining(['validate_deployment', 'run_apex_tests']));
    expect(verify).not.toContain('write_workspace_file');
    expect(verify).not.toContain('request_deploy');
  });
  it('publishes callable schemas with optional defaults and no duplicate tools', () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const [name, input] of [
      ['glob', { pattern: '**/*.cls' }],
      ['grep', { pattern: 'Hello' }],
      ['web_search', { query: 'docs' }],
      ['brief', { message: 'Checking' }],
      ['send_message', { to: 'parent', message: 'found it' }],
    ] as const) {
      expect(validateArgs(input, TOOLS.find((t) => t.name === name)!.inputSchema)).toBeNull();
    }
  });
});

describe('durable task board', () => {
  it('enforces prerequisites, rejects cycles atomically, and updates the visible checklist', async () => {
    const { ctx, app, session } = await setup();
    const a = (await call('task_create', { subject: 'Discover', description: 'Find the cause' }, ctx)).output as { id: string };
    const b = (await call('task_create', { subject: 'Implement', description: 'Fix the cause' }, ctx)).output as { id: string };
    await call('task_update', { taskId: b.id, addBlockedBy: [a.id] }, ctx);
    await expect(call('task_update', { taskId: b.id, status: 'in_progress' }, ctx)).rejects.toThrow('dependencies');
    await expect(call('task_update', { taskId: a.id, addBlockedBy: [b.id] }, ctx)).rejects.toThrow('cycle');
    expect(app.repos.agentState.get(session.id).tasks[0].blockedBy).toEqual([]);
    await call('task_update', { taskId: a.id, status: 'completed' }, ctx);
    await call('task_update', { taskId: b.id, owner: 'orchestrator', status: 'in_progress', metadata: { evidence: 'read source' } }, ctx);
    const task = (await call('task_get', { taskId: b.id }, ctx)).output as any;
    expect(task.blockedBy).toEqual([]);
    expect(app.repos.todos.get(session.id).find((t) => t.id === b.id)?.status).toBe('in_progress');
    await call('task_update', { taskId: b.id, metadata: { evidence: null } }, ctx);
    expect(app.repos.agentState.get(session.id).tasks[1].metadata).toEqual({});
    await call('task_update', { taskId: a.id, status: 'deleted' }, ctx);
    expect(app.repos.todos.get(session.id)).toHaveLength(1);
  });
  it('rejects foreign task references and conflicting claims', async () => {
    const { ctx, app, session, user, org } = await setup();
    const second = app.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual', title: 'Other session' });
    const task = app.repos.agentState.createTask(session.id, { subject: 'Task', description: 'Work' });
    expect(() => app.repos.agentState.updateTask(second.id, task.id, { status: 'completed' })).toThrow('not found');
    const other = app.repos.agentState.createTask(second.id, { subject: 'Other', description: 'Other' });
    expect(() => app.repos.agentState.updateTask(session.id, task.id, { addBlockedBy: [other.id] })).toThrow('not found');
    app.repos.agentState.updateTask(session.id, task.id, { owner: 'orchestrator' });
    await expect(call('task_update', { taskId: task.id, owner: 'different' }, ctx)).rejects.toThrow('already claimed');
  });
});

describe('source searches and brief', () => {
  it('matches zero-directory globstars without crossing ordinary stars', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/x/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false);
  });
  it('searches scoped workspace text with paging, flags, multiline and guarded regex', async () => {
    const { ctx, app, session } = await setup();
    for (const path of ['classes/A.cls', 'classes/B.cls'])
      app.repos.workspace.upsert(session.id, {
        path,
        content: 'Hello\nWorld',
        action: 'created',
        agentId: 'orchestrator',
        metadataType: 'ApexClass',
        fullName: path,
      } as any);
    const glob = (await call('glob', { pattern: '**/*.cls', limit: 1 }, ctx)).output as any;
    expect(glob.paths).toEqual(['classes/A.cls']);
    expect(glob.nextOffset).toBe(1);
    const grep = (await call('grep', { pattern: 'hello', ignoreCase: true, outputMode: 'content' }, ctx)).output as any;
    expect(grep.lines).toHaveLength(2);
    const multi = (await call('grep', { pattern: 'Hello\\s+World', multiline: true }, ctx)).output as any;
    expect(multi.filesMatched).toBe(2);
    await expect(call('grep', { pattern: '(a+)+b' }, ctx)).rejects.toThrow('rejected');
    await expect(call('glob', { repo: 'foreign-repo', pattern: '**' }, ctx)).rejects.toThrow('not available');
    await expect(call('brief', { message: 'Results', attachments: ['/etc/passwd'] }, ctx)).rejects.toThrow('not a staged');
    await call('brief', { message: 'Two classes located', attachments: ['classes/A.cls'] }, ctx);
    expect(app.repos.events.listAfter(session.id).some((e) => e.type === 'assistant.message' && e.text.includes('Two classes'))).toBe(true);
  });
});

describe('web search', () => {
  it('requires configuration, filters domains and rejects unsafe result links', async () => {
    const signal = new AbortController().signal;
    await expect(searchWeb({ query: 'docs' }, '', signal)).rejects.toThrow('not configured');
    let requested = '';
    const fetcher = (async (url: any, init: any) => {
      requested = String(url);
      expect(init.headers['X-Subscription-Token']).toBe('test-key');
      return Response.json({
        web: {
          results: [
            { title: 'Good', url: 'https://docs.example.com/a', description: 'Official' },
            { title: 'Wrong', url: 'https://example.com.evil.test/a' },
            { title: 'Unsafe', url: 'javascript:alert(1)' },
          ],
        },
      });
    }) as typeof fetch;
    const results = await searchWeb({ query: 'docs', allowedDomains: ['EXAMPLE.COM'] }, 'test-key', signal, fetcher);
    expect(results).toHaveLength(1);
    expect(results[0].url).toContain('docs.example.com');
    expect(new URL(requested).searchParams.get('q')).toContain('site:example.com');
    await expect(searchWeb({ query: 'docs', allowedDomains: ['example.com'], blockedDomains: ['other.com'] }, 'test-key', signal, fetcher)).rejects.toThrow(
      'not both',
    );
    await expect(searchWeb({ query: 'docs' }, 'test-key', signal, (async () => new Response('', { status: 429 })) as typeof fetch)).rejects.toThrow('429');
  });
});

describe('worker lifecycle', () => {
  it('cancels only an owned worker and returns its persisted final status', async () => {
    const { app, provider, session, user, org } = await setup();
    let parentCalls = 0;
    let workerId = '';
    provider.complete = async (req) => {
      if (req.system.startsWith('You are an exploration agent')) {
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) resolve();
          else req.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('Cancelled');
      }
      if (!req.system.startsWith('You are the lead agent')) return text('Documented.');
      parentCalls++;
      if (parentCalls === 1) return toolCall('run_subagent', { role: 'explore', objective: 'Inspect', runInBackground: true });
      if (parentCalls === 2) {
        workerId = app.repos.agentState.get(session.id).workers[0].id;
        const other = app.runtime.createSession({ userId: user.id, orgId: org.id, title: 'Foreign', uiMode: 'visual' });
        expect(() => app.runtime.stopWorker(other.id, 'orchestrator', workerId)).toThrow();
        return toolCall('task_stop', { agentId: workerId });
      }
      return text('Worker stopped.');
    };
    app.runtime.startTurn(session.id, user.id, 'Inspect then stop');
    await waitForIdle(app, session.id);
    expect((await app.runtime.workerOutput(session.id, workerId)).status).toBe('cancelled');
  });

  it('delivers a message arriving during a worker final response before that worker exits', async () => {
    const { app, provider, session, user } = await setup();
    let parentCalls = 0;
    let childCalls = 0;
    let received = false;
    provider.complete = async (req) => {
      if (req.system.startsWith('You are an exploration agent')) {
        childCalls++;
        if (childCalls === 1) {
          const id = app.repos.agentState.get(session.id).workers[0].id;
          await app.runtime.sendAgentMessage(session.id, 'orchestrator', id, 'Also inspect the alternate configuration.');
          return text('First finding');
        }
        received = JSON.stringify(req.messages).includes('alternate configuration');
        return text('Alternate configuration checked.');
      }
      if (!req.system.startsWith('You are the lead agent')) return text('Documented.');
      parentCalls++;
      return parentCalls === 1 ? toolCall('run_subagent', { role: 'explore', objective: 'Inspect' }) : text('Complete.');
    };
    app.runtime.startTurn(session.id, user.id, 'Inspect');
    await waitForIdle(app, session.id);
    expect(received).toBe(true);
    expect(childCalls).toBe(2);
  });

  it('runs a fork with repaired inherited history and retains that history on resume', async () => {
    const { app, provider, session, user } = await setup();
    let parentCalls = 0;
    let childCalls = 0;
    provider.complete = async (req) => {
      if (req.system.startsWith('You are an exploration agent')) {
        childCalls++;
        expect(JSON.stringify(req.messages)).toContain('Inherited context marker');
        expect(unansweredToolUseIds(req.messages)).toEqual([]);
        expect(req.tools.some((t) => t.name === 'run_subagent')).toBe(false);
        return text('Fork report.');
      }
      if (!req.system.startsWith('You are the lead agent')) return text('Documented.');
      parentCalls++;
      if (parentCalls === 1) return toolCall('run_subagent', { role: 'explore', objective: 'Inspect', forkContext: true });
      if (parentCalls === 2)
        return toolCall('send_message', { to: app.repos.agentState.get(session.id).workers[0].id, message: 'Continue checking', resume: true });
      return text('Complete.');
    };
    app.runtime.startTurn(session.id, user.id, 'Inherited context marker');
    await waitForIdle(app, session.id);
    expect(childCalls).toBe(2);
  });

  it('forks without mutating history or leaving dangling tool calls', () => {
    const history: LlmMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'run_subagent', input: {} },
          { type: 'tool_use', id: 'b', name: 'glob', input: {} },
        ],
      },
    ];
    const fork = forkMessages(history);
    expect(unansweredToolUseIds(fork)).toEqual([]);
    expect(history).toHaveLength(1);
    fork[0].content.pop();
    expect(history[0].content).toHaveLength(2);
  });
  it('retains a worker conversation for follow-up and isolates worker output', async () => {
    const { app, provider, session, user, org } = await setup();
    let workerId = '';
    provider.script = [
      () => toolCall('run_subagent', { role: 'explore', objective: 'Find the setting' }),
      () => text('The setting is Enabled__c.'),
      () => {
        workerId = app.repos.agentState.get(session.id).workers[0].id;
        return toolCall('send_message', { to: workerId, message: 'Where was it found?', resume: true });
      },
      (req) => {
        expect(JSON.stringify(req.messages)).toContain('Enabled__c');
        return text('Found in settings.xml:2.');
      },
      () => text('The setting was located.'),
    ];
    app.runtime.startTurn(session.id, user.id, 'Find and explain the setting');
    await waitForIdle(app, session.id);
    expect(workerId).toBeTruthy();
    const worker = await app.runtime.workerOutput(session.id, workerId);
    expect(worker.status).toBe('completed');
    expect(worker.report).toContain('settings.xml:2');
    const second = app.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    await expect(app.runtime.workerOutput(second.id, workerId)).rejects.toThrow();
    await expect(app.runtime.sendAgentMessage(second.id, 'orchestrator', workerId, 'foreign')).rejects.toThrow();
  });
  it('delivers background completion before the session closes', async () => {
    const { app, provider, session, user } = await setup();
    let parentCalls = 0;
    let sawReport = false;
    provider.complete = async (req) => {
      provider.requests.push(req);
      if (req.system.includes('You are an exploration agent')) {
        await new Promise((r) => setTimeout(r, 20));
        return text('Evidence: file.xml:9');
      }
      if (req.system.startsWith('You are the documentation writer')) return text('Documented.');
      parentCalls++;
      if (parentCalls === 1) return toolCall('run_subagent', { role: 'explore', objective: 'Find evidence', runInBackground: true });
      if (JSON.stringify(req.messages).includes('Evidence: file.xml:9')) sawReport = true;
      return text('Reported findings.');
    };
    app.runtime.startTurn(session.id, user.id, 'Investigate');
    await waitForIdle(app, session.id);
    expect(sawReport).toBe(true);
    expect(app.repos.agentState.get(session.id).workers[0].status).toBe('completed');
  });
  it('blocks general workers before plan approval and prevents mutating background workers', async () => {
    const { app, ctx, session, user } = await setup();
    expect(app.runtime.requireApprovedPlan(session.id, 'run_subagent', { role: 'general' })).toContain('no approved plan');
    expect(app.runtime.requireApprovedPlan(session.id, 'run_subagent', { role: 'plan' })).toBeNull();
    disablePlanMode(app);
    app.runtime.startTurn(session.id, user.id, 'Hello');
    await expect(app.runtime.startWorker(ctx, 'general', 'Build', undefined, true)).rejects.toThrow('read-only');
    await waitForIdle(app, session.id);
  });
  it('marks interrupted workers failed on restart', async () => {
    const { app, session } = await setup();
    app.repos.sessions.update(session.id, { status: 'running' });
    app.repos.agentState.change(session.id, (s) =>
      s.workers.push({ id: 'worker', parentId: 'orchestrator', role: 'explore', objective: 'Inspect', status: 'running', report: '', ok: false }),
    );
    app.runtime.recoverOnBoot();
    expect((await app.runtime.workerOutput(session.id, 'worker')).status).toBe('failed');
  });
});
