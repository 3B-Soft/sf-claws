// Build @sf-claws/shared first. Accepts historical Markdown or lossless JSON/NDJSON exports.
import { readFileSync } from 'node:fs';
import { analyzeSessionTiming } from '@sf-claws/shared';
const source = readFileSync(process.argv[2] ?? '_long_session_logs/events_raw.md', 'utf8');
const markdown = source.trimStart().startsWith('#');
const jsonEvents = (() => {
  if (markdown) return [];
  try {
    const data = JSON.parse(source);
    return Array.isArray(data) ? data : (data.events ?? [data]);
  } catch {
    return source
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
})();
const manifest = jsonEvents.find((e) => e.type === 'export.manifest');
const events = markdown
  ? [...source.matchAll(/^#(\d+)([a-z.]+)[^\n]*\n([\s\S]*?)(?=^#\d+[a-z.]|$(?![\s\S]))/gm)].map((m) => {
      const body = m[3].replace(/\\([_*[\]])/g, '$1');
      const str = (key) => [...body.matchAll(new RegExp(`"${key}": "(.*)"[,\\n]`, 'g'))].at(-1)?.[1];
      const num = (key) => Number(body.match(new RegExp(`"${key}": ([0-9.]+)`))?.[1] ?? 0);
      return { seq: Number(m[1]), type: m[2], body, str, num, at: str('at') };
    })
  : jsonEvents
      .filter((e) => e.type !== 'export.manifest')
      .map((e) => ({
        ...e,
        body: JSON.stringify(e, null, 2),
        str: (key) => e[key] ?? e.input?.[key],
        num: (key) => Number(e[key] ?? 0),
      }));
const timingEvents = markdown
  ? events.map((e) => ({
      type: e.type,
      seq: e.seq,
      at: e.at,
      ...Object.fromEntries(['agentId', 'role', 'status', 'tool', 'toolCallId', 'callId', 'phase', 'purpose'].map((k) => [k, e.str(k)])),
      durationMs: e.num('durationMs'),
      ...Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens'].map((k) => [k, e.num(k)])),
    }))
  : jsonEvents.filter((e) => e.type !== 'export.manifest');
const count = (values) => Object.fromEntries([...values.reduce((a, x) => a.set(x, (a.get(x) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]));
const calls = events.filter((e) => e.type === 'tool.call');
const usage = events.filter((e) => e.type === 'session.usage');
const summary = {
  exportNote: markdown
    ? 'Partial Markdown export: collapsed nodes and missing model timing cannot be reconstructed. Usage events are cumulative, not additive.'
    : 'JSON/NDJSON export. session.usage is cumulative; model.finished usage is per call.',
  manifest,
  timing: analyzeSessionTiming(timingEvents),
  eventCount: events.length,
  eventTypes: count(events.map((e) => e.type)),
  tools: count(calls.map((e) => e.str('tool'))),
  describeTargets: count(calls.filter((e) => e.str('tool') === 'describe_sobject').map((e) => e.str('sobject'))),
  skills: count(calls.filter((e) => e.str('tool') === 'load_skill').map((e) => e.str('skillId') ?? e.str('label'))),
  agents: events
    .filter((e) => e.type === 'agent.spawned')
    .map((e) => ({
      seq: e.seq,
      at: e.at,
      id: e.str('agentId'),
      role: e.str('role'),
      tools: calls.filter((c) => c.str('agentId') === e.str('agentId')).length,
    })),
  validations: events
    .filter((e) => e.type === 'deploy.validation')
    .map((e) => ({
      seq: e.seq,
      at: e.at,
      attempt: e.num('attempt'),
      total: e.num('componentsTotal'),
      failed: e.num('componentsFailed'),
      tests: e.num('testsTotal'),
      problems: [...e.body.matchAll(/"problem": "(.*)"/g)].map((m) => m[1]),
    })),
  status: events
    .filter((e) => e.type === 'session.status' && !e.str('message')?.startsWith('Validating:'))
    .map((e) => ({ seq: e.seq, at: e.at, status: e.str('status'), message: e.str('message') })),
  finalUsage: usage.length ? Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'costUsd'].map((k) => [k, usage.at(-1).num(k)])) : null,
  usageSnapshots: usage
    .filter((e, i) => !i || i === usage.length - 1 || (i > 0 && Date.parse(e.at) - Date.parse(usage[i - 1].at) > 120000))
    .map((e) => ({ seq: e.seq, at: e.at, input: e.num('inputTokens'), output: e.num('outputTokens'), cached: e.num('cachedInputTokens') })),
  toolDurationMs: events.filter((e) => e.type === 'tool.result').reduce((n, e) => n + e.num('durationMs'), 0),
};
console.log(JSON.stringify(summary, null, 2));
