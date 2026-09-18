import { describe, expect, it } from 'vitest';
import { analyzeSessionTiming, type TimingEvent } from './session-timing.js';

const event = (seconds: number, type: string, extra: Partial<TimingEvent> = {}): TimingEvent => ({
  seq: seconds,
  at: new Date(seconds * 1000).toISOString(),
  type,
  ...extra,
});
const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 };

describe('session timing', () => {
  it('unions concurrent models and early tools without counting delegation or user waits as work', () => {
    const t = analyzeSessionTiming([
      event(0, 'session.status', { status: 'running' }),
      event(1, 'tool.call', { tool: 'run_subagent', toolCallId: 'delegate' }),
      event(2, 'model.started', { agentId: 'a', callId: 'm1' }),
      event(3, 'model.started', { agentId: 'b', callId: 'm2' }),
      event(4, 'tool.call', { agentId: 'a', tool: 'describe_sobject', toolCallId: 't1' }),
      event(5, 'model.finished', { agentId: 'b', callId: 'm2', usage, phase: 'research' }),
      event(6, 'model.finished', { agentId: 'a', callId: 'm1', usage, phase: 'research' }),
      event(7, 'tool.result', { agentId: 'a', tool: 'describe_sobject', toolCallId: 't1' }),
      event(8, 'session.status', { status: 'awaiting_plan' }),
      event(10, 'tool.result', { tool: 'run_subagent', toolCallId: 'delegate' }),
      event(12, 'session.status', { status: 'running' }),
      event(14, 'session.status', { status: 'idle' }),
      event(1000, 'github.commit'),
    ]);
    expect(t).toMatchObject({
      activeMs: 10000,
      userWaitMs: 4000,
      modelOnlyMs: 2000,
      modelAndToolMs: 2000,
      toolOnlyMs: 1000,
      unattributedActiveMs: 5000,
      maxConcurrentModelCalls: 2,
    });
    expect(t.attributedUsage.outputTokens).toBe(40);
    expect(t.end).toBe(14000);
    expect(t.phaseUsage).toHaveLength(2);
  });

  it('keeps old cumulative usage unassigned and closes interrupted calls at cancellation, not later commits', () => {
    const t = analyzeSessionTiming([
      event(1, 'session.status', { status: 'running' }),
      event(2, 'tool.call', { tool: 'read_metadata', toolCallId: 't' }),
      event(3, 'session.usage', { ...usage }),
      event(4, 'session.status', { status: 'cancelled' }),
      event(1000, 'github.commit'),
    ]);
    expect(t).toMatchObject({ activeMs: 3000, toolOnlyMs: 2000, incompleteSpans: 1, modelTimingAvailable: false, unattributedUsage: usage });
    expect(t.agents[0].usage).toBeNull();
    expect(t.spans[0].end).toBe(4000);
  });

  it('does not fabricate usage for failed calls and separates compaction from normal calls', () => {
    const t = analyzeSessionTiming([
      event(1, 'session.status', { status: 'running' }),
      event(2, 'model.started', { agentId: 'a', callId: 'failed' }),
      event(3, 'model.finished', { agentId: 'a', callId: 'failed', usage: null, phase: 'build' }),
      event(4, 'model.started', { agentId: 'a', callId: 'summary' }),
      event(5, 'model.finished', { agentId: 'a', callId: 'summary', usage, phase: 'build', purpose: 'compaction' }),
      event(6, 'session.status', { status: 'idle' }),
    ]);
    expect(t.unknownUsageCalls).toBe(1);
    expect(t.phaseUsage.map((r) => r.purpose)).toEqual(['turn', 'compaction']);
    expect(t.agents[0].usage).toEqual(usage);
  });
});
