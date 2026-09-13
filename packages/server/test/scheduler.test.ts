import { describe, it, expect } from 'vitest';
import { partitionBySafety, mapWithConcurrency, runScheduled } from '../src/agents/scheduler.js';
import { coerceArgs, coerceValue } from '../src/agents/coerce.js';
import { repairOrphanedToolUses, unansweredToolUseIds } from '../src/agents/conversation.js';
import { backoffMs, shouldRetry } from '../src/agents/backoff.js';
import { checkCostCeilings, monthStartIso } from '../src/agents/cost.js';
import { budgetTurnResults, DEFAULT_RESULT_LIMIT } from '../src/agents/budget.js';
import { evictSupersededToolResults, EVICTED_RESULT_TEXT } from '../src/agents/agent.js';
import type { LlmBlock, LlmMessage } from '../src/ai/types.js';

const rules = { maxTurnCostUsd: 0, maxSessionCostUsd: 0, maxClientMonthlyCostUsd: 0, costCeilingDocReserveUsd: 0.25 };

describe('tool scheduling', () => {
  it('groups consecutive safe calls and isolates unsafe ones, preserving order', () => {
    const items = [
      { n: 'read', safe: true },
      { n: 'read2', safe: true },
      { n: 'write', safe: false },
      { n: 'read3', safe: true },
      { n: 'write2', safe: false },
      { n: 'write3', safe: false },
    ];
    const batches = partitionBySafety(items, (i) => i.safe);
    expect(batches.map((b) => ({ safe: b.safe, items: b.items.map((i) => i.n) }))).toEqual([
      { safe: true, items: ['read', 'read2'] },
      { safe: false, items: ['write'] },
      { safe: true, items: ['read3'] },
      // Unsafe calls never share a batch: each must complete before the next begins.
      { safe: false, items: ['write2'] },
      { safe: false, items: ['write3'] },
    ]);
  });

  it('runs unsafe calls strictly one at a time and safe calls in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const items = [
      { n: 'r1', safe: true },
      { n: 'r2', safe: true },
      { n: 'r3', safe: true },
      { n: 'w1', safe: false },
      { n: 'w2', safe: false },
    ];
    await runScheduled(items, {
      isSafe: (i) => i.safe,
      limit: 6,
      run: async (i) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (!i.safe) expect(inFlight).toBe(1); // the whole point: writes never overlap
        await new Promise((r) => setTimeout(r, 5));
        order.push(i.n);
        inFlight--;
        return i.n;
      },
    });
    expect(maxInFlight).toBe(3);
    expect(order.slice(-2)).toEqual(['w1', 'w2']);
  });

  it('returns results in the original order even when parallel work finishes out of order', async () => {
    const items = [30, 5, 20, 1];
    const out = await runScheduled(items, {
      isSafe: () => true,
      run: async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
      },
    });
    expect(out).toEqual([30, 5, 20, 1]);
  });

  it('skips remaining work once the abort flag is set, without dropping results', async () => {
    let aborted = false;
    const items = [
      { n: 'a', safe: false },
      { n: 'b', safe: false },
      { n: 'c', safe: false },
    ];
    const out = await runScheduled(items, {
      isSafe: () => false,
      shouldStop: () => aborted,
      onSkipped: (i) => `skipped:${i.n}`,
      run: async (i) => {
        aborted = true;
        return `ran:${i.n}`;
      },
    });
    expect(out).toEqual(['ran:a', 'skipped:b', 'skipped:c']);
  });

  it('bounds concurrency to the limit', async () => {
    let inFlight = 0;
    let max = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(max).toBe(3);
  });
});

describe('tool argument coercion', () => {
  const schema = {
    type: 'object',
    properties: {
      limit: { type: 'integer' },
      ratio: { type: 'number' },
      tooling: { type: 'boolean' },
      names: { type: 'array', items: { type: 'string' } },
      nested: { type: 'object', properties: { deep: { type: 'boolean' } } },
    },
  };

  it('coerces stringified numbers and booleans that would otherwise corrupt limits and flags', () => {
    const out = coerceArgs({ limit: '150', ratio: '0.5', tooling: 'false' }, schema);
    expect(out).toEqual({ limit: 150, ratio: 0.5, tooling: false });
    // The bug this prevents: "false" is truthy, so an uncoerced flag flips the wrong way.
    expect(out.tooling).toBe(false);
  });

  it('wraps a lone value where a list is expected and splits comma strings', () => {
    expect(coerceArgs({ names: 'AccountTest' }, schema).names).toEqual(['AccountTest']);
    expect(coerceArgs({ names: 'A, B ,C' }, schema).names).toEqual(['A', 'B', 'C']);
  });

  it('parses stringified objects and recurses into nested schemas', () => {
    expect(coerceArgs({ nested: '{"deep":"true"}' }, schema)).toEqual({ nested: { deep: true } });
  });

  it('leaves values it cannot safely convert alone', () => {
    expect(coerceValue('not-a-number', { type: 'integer' })).toBe('not-a-number');
    expect(coerceValue('maybe', { type: 'boolean' })).toBe('maybe');
  });

  it('truncates floats for integer fields and tolerates junk input', () => {
    expect(coerceValue('12.9', { type: 'integer' })).toBe(12);
    expect(coerceArgs(null, schema)).toEqual({});
    expect(coerceArgs('garbage', schema)).toEqual({});
  });
});

describe('conversation repair', () => {
  const assistantWithCalls = (ids: string[]): LlmMessage => ({
    role: 'assistant',
    content: ids.map((id) => ({ type: 'tool_use', id, name: 'soql_query', input: {} }) as LlmBlock),
  });

  it('finds tool_use blocks that never got a result', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      assistantWithCalls(['a', 'b']),
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: 'ok' }] },
    ];
    expect(unansweredToolUseIds(messages)).toEqual(['b']);
  });

  it('appends synthetic error results so an interrupted history can be replayed', () => {
    const messages: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, assistantWithCalls(['a', 'b'])];
    const repaired = repairOrphanedToolUses(messages);
    expect(repaired).not.toBe(messages);
    expect(unansweredToolUseIds(repaired)).toEqual([]);
    const results = repaired.at(-1)!.content as Extract<LlmBlock, { type: 'tool_result' }>[];
    expect(results.map((r) => r.toolUseId)).toEqual(['a', 'b']);
    expect(results.every((r) => r.isError)).toBe(true);
  });

  it('is a no-op for a healthy conversation', () => {
    const messages: LlmMessage[] = [assistantWithCalls(['a']), { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: 'ok' }] }];
    expect(repairOrphanedToolUses(messages)).toBe(messages);
  });
});

describe('provider backoff', () => {
  it('honours Retry-After above its own schedule', () => {
    expect(backoffMs({ attempt: 1, status: 429, retryAfterSeconds: 12 })).toBe(12_000);
  });

  it('waits longer for overload than for a transient error, and grows with attempts', () => {
    const noJitter = () => 1;
    const overload = backoffMs({ attempt: 1, status: 529 }, noJitter);
    const transient = backoffMs({ attempt: 1 }, noJitter);
    expect(overload).toBeGreaterThan(transient);
    expect(backoffMs({ attempt: 3, status: 529 }, noJitter)).toBeGreaterThan(overload);
  });

  it('applies jitter so parallel sub-agents do not retry in lockstep', () => {
    expect(backoffMs({ attempt: 2 }, () => 0)).toBeLessThan(backoffMs({ attempt: 2 }, () => 1));
  });

  it('stops retrying at the cap and never retries a non-retryable error', () => {
    expect(shouldRetry(1, true)).toBe(true);
    expect(shouldRetry(4, true)).toBe(false);
    expect(shouldRetry(1, false)).toBe(false);
  });
});

describe('cost ceilings', () => {
  it('allows spend below the ceiling and blocks at or above it', () => {
    expect(
      checkCostCeilings({
        rules: { ...rules, maxSessionCostUsd: 10, costCeilingDocReserveUsd: 0 },
        turnCostUsd: 0,
        sessionCostUsd: 9.99,
        clientMonthCostUsd: 0,
      }),
    ).toBeNull();
    const hit = checkCostCeilings({
      rules: { ...rules, maxSessionCostUsd: 10, costCeilingDocReserveUsd: 0 },
      turnCostUsd: 0,
      sessionCostUsd: 10,
      clientMonthCostUsd: 0,
    });
    expect(hit?.scope).toBe('session');
    expect(hit?.message).toContain('$10.00');
  });

  it('treats 0 as unlimited', () => {
    expect(checkCostCeilings({ rules, turnCostUsd: 9999, sessionCostUsd: 9999, clientMonthCostUsd: 9999 })).toBeNull();
  });

  it('carves the documentation reserve out of the ceiling rather than adding to it', () => {
    const input = { rules: { ...rules, maxSessionCostUsd: 10, costCeilingDocReserveUsd: 1 }, turnCostUsd: 0, sessionCostUsd: 9.5, clientMonthCostUsd: 0 };
    // Ordinary work stops early so documentation can still be written...
    expect(checkCostCeilings(input)?.scope).toBe('session');
    // ...the doc writer may use the reserve...
    expect(checkCostCeilings({ ...input, documenting: true })).toBeNull();
    // ...but the configured ceiling is still a hard cap, even for it.
    expect(checkCostCeilings({ ...input, sessionCostUsd: 10, documenting: true })?.scope).toBe('session');
  });

  it('reports the tightest scope that is breached', () => {
    const hit = checkCostCeilings({
      rules: { ...rules, maxTurnCostUsd: 1, maxSessionCostUsd: 100, costCeilingDocReserveUsd: 0 },
      turnCostUsd: 1.5,
      sessionCostUsd: 2,
      clientMonthCostUsd: 3,
    });
    expect(hit?.scope).toBe('turn');
  });

  it('computes the start of the current UTC month', () => {
    expect(monthStartIso(new Date('2026-03-17T13:45:00Z'))).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('result budgeting', () => {
  const result = (content: string): LlmBlock => ({ type: 'tool_result', toolUseId: 't1', content });

  it('spills an oversized result to an artifact and leaves a readable handle', () => {
    const saved: string[] = [];
    const out = budgetTurnResults([{ tool: 'get_apex_log_body', block: result('x'.repeat(50_000)) }], {
      limitFor: () => 10_000,
      persist: (_t, c) => {
        saved.push(c);
        return 'art_1';
      },
    });
    const block = out[0] as Extract<LlmBlock, { type: 'tool_result' }>;
    expect(saved[0]).toHaveLength(50_000);
    expect(block.content.length).toBeLessThan(3000);
    expect(block.content).toContain('art_1');
    expect(block.content).toContain('read_tool_output');
  });

  it('caps a parallel fan-out that individually fits but collectively does not', () => {
    const entries = Array.from({ length: 6 }, () => ({ tool: 'read_metadata', block: result('y'.repeat(39_000)) }));
    const out = budgetTurnResults(entries, { limitFor: () => DEFAULT_RESULT_LIMIT, persist: () => 'art_x' });
    const total = out.reduce((n, b) => n + (b as any).content.length, 0);
    expect(total).toBeLessThanOrEqual(120_000);
    // Small results survive intact — only the largest are spilled.
    expect(out.some((b) => (b as any).content.length > 3000)).toBe(true);
  });

  it('leaves results that fit completely untouched', () => {
    const entries = [{ tool: 'soql_query', block: result('small') }];
    expect(budgetTurnResults(entries, { limitFor: () => DEFAULT_RESULT_LIMIT, persist: () => 'nope' })[0]).toEqual(result('small'));
  });
});

describe('context eviction', () => {
  const bigResult = (id: string): LlmMessage => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: 'z'.repeat(5000) }] });

  it('evicts only old, large results and keeps the recent ones intact', () => {
    const messages: LlmMessage[] = Array.from({ length: 12 }, (_, i) => bigResult(`t${i}`));
    const out = evictSupersededToolResults(messages);
    const contents = out.map((m) => (m.content[0] as any).content);
    expect(contents.slice(0, 4).every((c) => c === EVICTED_RESULT_TEXT)).toBe(true);
    expect(contents.slice(4).every((c) => c.length === 5000)).toBe(true);
  });

  it('does nothing when everything is recent or small', () => {
    const messages: LlmMessage[] = [bigResult('a'), bigResult('b')];
    expect(evictSupersededToolResults(messages)).toBe(messages);
    const small: LlmMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: `s${i}`, content: 'tiny' }],
    }));
    expect(evictSupersededToolResults(small)).toBe(small);
  });
});
