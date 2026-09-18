/** Accepts persisted events and the explicitly partial records extracted from old Markdown exports. */
export interface TimingEvent {
  type: string;
  seq: number;
  at: string;
  agentId?: string;
  role?: string;
  status?: string;
  tool?: string;
  toolCallId?: string;
  callId?: string;
  phase?: string;
  purpose?: string;
  outcome?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
}

type Interval = { start: number; end: number };
type Span = Interval & { agentId: string; kind: 'model' | 'tool'; incomplete: boolean };
const WRAPPERS = new Set(['run_subagent', 'investigate_product_repo', 'consult_specialist', 'ask_user', 'submit_plan']);
const WAITING = new Set(['awaiting_confirmation', 'awaiting_plan']);
const tokens = () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });

/** Union/sweep intervals so early tool execution and parallel calls never double-count wall time. */
function partition(active: Interval[], waits: Interval[], spans: Span[]) {
  const changes = new Map<number, number[]>();
  const add = (range: Interval, index: number) => {
    if (range.end <= range.start) return;
    for (const [at, delta] of [
      [range.start, 1],
      [range.end, -1],
    ]) {
      const entry = changes.get(at) ?? [0, 0, 0, 0];
      entry[index] += delta;
      changes.set(at, entry);
    }
  };
  active.forEach((r) => add(r, 0));
  waits.forEach((r) => add(r, 1));
  spans.forEach((r) => add(r, r.kind === 'model' ? 2 : 3));
  const result = { activeMs: 0, userWaitMs: 0, modelOnlyMs: 0, toolOnlyMs: 0, modelAndToolMs: 0, unattributedActiveMs: 0, maxConcurrentModelCalls: 0 };
  const current = [0, 0, 0, 0];
  let previous = 0;
  for (const [at, delta] of [...changes].sort((a, b) => a[0] - b[0])) {
    const duration = at - previous;
    if (current[1] > 0) result.userWaitMs += duration;
    if (current[0] > 0) {
      result.activeMs += duration;
      if (current[2] && current[3]) result.modelAndToolMs += duration;
      else if (current[2]) result.modelOnlyMs += duration;
      else if (current[3]) result.toolOnlyMs += duration;
      else result.unattributedActiveMs += duration;
    }
    if (duration > 0) result.maxConcurrentModelCalls = Math.max(result.maxConcurrentModelCalls, current[2]);
    delta.forEach((n, i) => {
      current[i] += n;
    });
    previous = at;
  }
  return result;
}

export function analyzeSessionTiming(input: readonly TimingEvent[], observedThrough?: number) {
  const events = [...input].filter((e) => Number.isFinite(Date.parse(e.at))).sort((a, b) => a.seq - b.seq);
  const lastAt = observedThrough ?? (events.length ? Date.parse(events[events.length - 1].at) : 0);
  const active: Interval[] = [],
    waits: Interval[] = [],
    spans: Span[] = [];
  let state: string | undefined,
    stateAt = 0;
  const agents = new Map<
    string,
    {
      agentId: string;
      role: string;
      start: number;
      end: number;
      finished: boolean;
      modelCalls: number;
      toolCalls: number;
      usage: ReturnType<typeof tokens> | null;
    }
  >();
  const models = new Map<string, TimingEvent>(),
    tools = new Map<string, TimingEvent>();
  const phaseUsage = new Map<
    string,
    { agentId: string; phase: string; purpose: string; calls: number; unknownUsageCalls: number; usage: ReturnType<typeof tokens> }
  >();
  let measuredCalls = 0,
    unknownUsageCalls = 0,
    unmatchedFinishes = 0;
  const ensureAgent = (e: TimingEvent) => {
    const id = e.agentId ?? 'orchestrator';
    let agent = agents.get(id);
    if (!agent) {
      agent = { agentId: id, role: e.role ?? id, start: Date.parse(e.at), end: Date.parse(e.at), finished: false, modelCalls: 0, toolCalls: 0, usage: null };
      agents.set(id, agent);
    }
    agent.end = Math.max(agent.end, Date.parse(e.at));
    return agent;
  };
  const closeState = (end: number) => {
    if (state === 'running') active.push({ start: stateAt, end });
    if (state && WAITING.has(state)) waits.push({ start: stateAt, end });
  };
  for (const e of events) {
    const at = Date.parse(e.at);
    if (e.type === 'session.status' && e.status !== state) {
      closeState(at);
      state = e.status;
      stateAt = at;
    }
    if (e.type === 'agent.spawned') ensureAgent(e);
    if (e.type === 'agent.finished') ensureAgent(e).finished = true;
    if (e.type === 'model.started' && e.callId) {
      models.set(e.callId, e);
      ensureAgent(e).modelCalls++;
    }
    if (e.type === 'tool.call' && e.toolCallId) {
      tools.set(e.toolCallId, e);
      ensureAgent(e).toolCalls++;
    }
    if (e.type === 'model.finished' || e.type === 'tool.result') {
      const isModel = e.type === 'model.finished';
      const map = isModel ? models : tools;
      const key = (isModel ? e.callId : e.toolCallId) ?? '';
      const start = map.get(key);
      map.delete(key);
      if (!start) unmatchedFinishes++;
      const began = start ? Date.parse(start.at) : at - Math.max(0, e.durationMs ?? 0);
      // Parent delegation and human approval waits are containers, not tool execution time.
      if (isModel || !WRAPPERS.has(e.tool ?? start?.tool ?? '')) {
        spans.push({ start: began, end: at, agentId: e.agentId ?? start?.agentId ?? 'orchestrator', kind: isModel ? 'model' : 'tool', incomplete: false });
      }
      const agent = ensureAgent(e);
      if (isModel) {
        measuredCalls++;
        if (!e.usage) unknownUsageCalls++;
        const phase = e.phase ?? 'unknown',
          purpose = e.purpose ?? 'turn';
        const phaseKey = `${agent.agentId}:${phase}:${purpose}`;
        const row = phaseUsage.get(phaseKey) ?? { agentId: agent.agentId, phase, purpose, calls: 0, unknownUsageCalls: 0, usage: tokens() };
        row.calls++;
        if (e.usage) {
          agent.usage ??= tokens();
          for (const name of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
            agent.usage[name] += e.usage[name];
            row.usage[name] += e.usage[name];
          }
        } else row.unknownUsageCalls++;
        phaseUsage.set(phaseKey, row);
      }
    }
  }
  closeState(lastAt);
  // Interrupted spans are visible as incomplete. Do not invent a successful end or token usage.
  for (const [kind, pending] of [
    ['model', models],
    ['tool', tools],
  ] as const) {
    for (const e of pending.values()) {
      if (kind === 'tool' && WRAPPERS.has(e.tool ?? '')) continue;
      const start = Date.parse(e.at);
      // Stop at the end of the containing run, not a Git commit hours after cancellation.
      const end = active.find((r) => r.start <= start && r.end >= start)?.end ?? start;
      spans.push({ start, end, kind, agentId: e.agentId ?? 'orchestrator', incomplete: true });
    }
  }
  const breakdown = partition(active, waits, spans);
  const runStart = active[0]?.start ?? waits[0]?.start ?? 0;
  const runEnd = Math.max(runStart, ...active.map((r) => r.end), ...waits.map((r) => r.end));
  const childLifetimes: Span[] = [...agents.values()]
    .filter((a) => a.agentId !== 'orchestrator')
    .map((a) => ({ start: a.start, end: a.end, agentId: a.agentId, kind: 'model', incomplete: !a.finished }));
  const attributedUsage = tokens();
  for (const row of phaseUsage.values())
    for (const key of Object.keys(attributedUsage) as (keyof typeof attributedUsage)[]) attributedUsage[key] += row.usage[key];
  const cumulative = events.filter((e) => e.type === 'session.usage').at(-1);
  const unattributedUsage = cumulative ? tokens() : null;
  if (cumulative && unattributedUsage) {
    for (const key of Object.keys(unattributedUsage) as (keyof typeof unattributedUsage)[])
      unattributedUsage[key] = Math.max(0, (cumulative[key] ?? 0) - attributedUsage[key]);
  }
  return {
    start: runStart,
    end: runEnd,
    ...breakdown,
    modelTimingAvailable: measuredCalls > 0 || models.size > 0,
    measuredCalls,
    unknownUsageCalls,
    unmatchedFinishes,
    maxConcurrentChildAgents: partition(active, [], childLifetimes).maxConcurrentModelCalls,
    attributedUsage,
    unattributedUsage,
    incompleteSpans: spans.filter((s) => s.incomplete).length,
    notes: [
      'Model spans measure provider request time, including prefill/network/hidden reasoning; they do not isolate decoding.',
      'Delegation and question/plan wrappers are excluded from tool time. Parallel and early-started calls are unioned, with overlap shown separately.',
      'Unattributed active time includes backoff, scheduling and missing telemetry; it is not proven idle time.',
      'Phase labels come from agent role and plan state, not model interpretation. Historical cumulative usage cannot be attributed to agents.',
    ],
    agents: [...agents.values()].map((a) => ({
      ...a,
      ...partition(
        active.map((r) => ({ start: Math.max(r.start, a.start), end: Math.min(r.end, a.end) })).filter((r) => r.end > r.start),
        [],
        spans.filter((s) => s.agentId === a.agentId),
      ),
    })),
    phaseUsage: [...phaseUsage.values()],
    spans,
  };
}
