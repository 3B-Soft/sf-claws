import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeContext } from './helpers.js';
import { DeepseekProvider } from '../src/ai/deepseek.js';
import { OpenAiProvider } from '../src/ai/openai.js';
import { DeepinfraProvider } from '../src/ai/deepinfra.js';
import { splitSystemPrompt, SYSTEM_CACHE_BOUNDARY } from '../src/ai/types.js';
import type { AiModel } from '@sf-claws/shared';
import type { LlmRequest } from '../src/ai/types.js';

/**
 * A stand-in for an OpenAI-compatible endpoint: records the request body and replays a scripted
 * chat-completions SSE stream. Real provider calls are never made in tests.
 */
function fakeEndpoint(chunks: unknown[]): { server: Server; url: Promise<string>; bodies: any[] } {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
  });
  return { server, url, bodies };
}

function model(over: Partial<AiModel> = {}): AiModel {
  return {
    id: 'm1',
    provider: 'deepseek',
    modelId: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    enabled: true,
    inputCostPerM: 0.28,
    outputCostPerM: 0.42,
    cachedInputCostPerM: 0.028,
    maxOutputTokens: 64000,
    contextWindow: 128000,
    supportsThinking: true,
    createdAt: new Date().toISOString(),
    ...over,
  } as AiModel;
}

function request(m: AiModel, over: Partial<LlmRequest> = {}): LlmRequest {
  return { model: m, system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], effort: 'high', ...over };
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});

let open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.map((s) => new Promise((r) => s.close(r))));
  open = [];
});

describe('DeepSeek provider', () => {
  it('streams reasoning_content as thinking, caps output with max_tokens and sends no reasoning_effort', async () => {
    const ep = fakeEndpoint([
      chunk({ reasoning_content: 'weighing ' }),
      chunk({ reasoning_content: 'options' }),
      chunk({ content: 'Use a formula field.' }),
      chunk({}, 'stop'),
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 } },
    ]);
    open.push(ep.server);
    const thinking: string[] = [];
    const p = new DeepseekProvider('sk-test', await ep.url);
    const res = await p.complete(request(model(), { maxTokens: 1000, onThinking: (d) => thinking.push(d) }));

    // DeepSeek decides its own thinking budget, so the effort knob must not be sent.
    expect(ep.bodies[0].reasoning_effort).toBeUndefined();
    expect(ep.bodies[0].max_tokens).toBe(1000);
    expect(ep.bodies[0].max_completion_tokens).toBeUndefined();

    expect(thinking.join('')).toBe('weighing options');
    expect(res.content).toEqual([
      { type: 'thinking', text: 'weighing options' },
      { type: 'text', text: 'Use a formula field.' },
    ]);
    expect(res.stopReason).toBe('end_turn');
    // prompt_cache_hit_tokens is DeepSeek's spelling of cached input, and is not billed twice.
    expect(res.usage).toEqual({ inputTokens: 60, outputTokens: 20, cachedInputTokens: 40 });
  });

  it('maps tool calls and reports the provider on errors', async () => {
    const ep = fakeEndpoint([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'soql_query', arguments: '{"soql":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"SELECT Id FROM Account"}' } }] }),
      chunk({}, 'tool_calls'),
    ]);
    open.push(ep.server);
    const p = new DeepseekProvider('sk-test', await ep.url);
    const res = await p.complete(request(model({ modelId: 'deepseek-chat', supportsThinking: false })));
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'soql_query', input: { soql: 'SELECT Id FROM Account' } }]);

    const dead = new DeepseekProvider('sk-test', 'http://127.0.0.1:1/v1');
    await expect(p.complete({ ...request(model()), signal: AbortSignal.abort() })).rejects.toMatchObject({ provider: 'deepseek' });
    await expect(dead.complete(request(model()))).rejects.toMatchObject({ provider: 'deepseek', retryable: true });
  });

  it('is reachable through the registry once a key is stored, and ships disabled in the catalogue', async () => {
    const ctx = makeContext();
    ctx.ai.seedDefaults();
    const seeded = ctx.repos.models.list().filter((m) => m.provider === 'deepseek');
    expect(seeded.map((m) => m.modelId).sort()).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    // A new provider must not start enabled: no key is configured yet, and role bindings stay on Claude.
    expect(seeded.every((m) => !m.enabled)).toBe(true);

    expect(() => ctx.ai.provider('deepseek')).toThrow(/No API key configured/);
    ctx.repos.providers.set('deepseek', ctx.secrets.encrypt('sk-test'), null, 'test');
    expect(ctx.ai.provider('deepseek')).toBeInstanceOf(DeepseekProvider);
  });

  it('sends the admin sampling dials only where the provider accepts them', async () => {
    const ep = fakeEndpoint([chunk({ content: 'ok' }), chunk({}, 'stop')]);
    open.push(ep.server);
    const p = new DeepinfraProvider('sk-test', await ep.url);
    await p.complete(request(model({ provider: 'deepinfra', modelId: 'deepseek-ai/DeepSeek-V3', supportsThinking: false, temperature: 0.2, topP: 0.9 })));
    expect(ep.bodies[0].temperature).toBe(0.2);
    expect(ep.bodies[0].top_p).toBe(0.9);

    // A thinking model gets neither: the reasoning families reject anything but their default.
    await p.complete(request(model({ provider: 'deepinfra', supportsThinking: true, temperature: 0.2, topP: 0.9 })));
    expect(ep.bodies[1].temperature).toBeUndefined();
    expect(ep.bodies[1].top_p).toBeUndefined();

    // Unset means unset — no key at all, so the provider default applies.
    await p.complete(request(model({ provider: 'deepinfra', supportsThinking: false })));
    expect('temperature' in ep.bodies[2]).toBe(false);
    expect('top_p' in ep.bodies[2]).toBe(false);
  });

  it('strips the cache boundary marker from a prompt sent to a compatible endpoint', async () => {
    const ep = fakeEndpoint([chunk({ content: 'ok' }), chunk({}, 'stop')]);
    open.push(ep.server);
    const p = new DeepinfraProvider('sk-test', await ep.url);
    await p.complete(request(model({ provider: 'deepinfra' }), { system: `stable half\n${SYSTEM_CACHE_BOUNDARY}\nvolatile half` }));
    expect(ep.bodies[0].messages[0].content).not.toContain(SYSTEM_CACHE_BOUNDARY);
    expect(ep.bodies[0].messages[0].content).toContain('volatile half');
  });

  it('splits a system prompt at the cache boundary, and copes when there is none', () => {
    expect(splitSystemPrompt(`above\n${SYSTEM_CACHE_BOUNDARY}\nbelow`)).toEqual({ stable: 'above', dynamic: 'below' });
    // No marker means everything is stable, which is the safe reading: nothing gets cached that moves.
    expect(splitSystemPrompt('just one half')).toEqual({ stable: 'just one half', dynamic: '' });
  });

  it('leaves the OpenAI dialect on max_completion_tokens and reasoning_effort', async () => {
    const ep = fakeEndpoint([chunk({ content: 'ok' }), chunk({}, 'stop')]);
    open.push(ep.server);
    const p = new OpenAiProvider('sk-test', await ep.url);
    await p.complete(request(model({ provider: 'openai', modelId: 'gpt-5' }), { effort: 'xhigh' }));
    expect(ep.bodies[0].max_completion_tokens).toBe(16000);
    expect(ep.bodies[0].max_tokens).toBeUndefined();
    expect(ep.bodies[0].reasoning_effort).toBe('high');
  });
});
