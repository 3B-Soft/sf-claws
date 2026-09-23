/**
 * Skill-use evaluation. Builds the real orchestrator prompt with the real seeded skills, offers the
 * model only load_skill, and grades the reply against `cases.ts`. Costs real money: it runs only
 * through `bun run eval` (its own vitest config) and never from `bun run test`.
 *
 *   ANTHROPIC_API_KEY=sk-... bun run eval            # EVAL_MODEL=claude-sonnet-5 for a cheaper pass
 *
 * Replies land in eval/output/<case>.md (gitignored) so a failure can be read, not just counted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
import type { AiModel } from '@sf-claws/shared';
import { makeContext, seedClientOrgUser } from '../test/helpers.js';
import { AnthropicProvider } from '../src/ai/anthropic.js';
import type { LlmMessage, LlmResponse } from '../src/ai/types.js';
import { buildPromptSections } from '../src/agents/prompts.js';
import { TOOLS, toLlmTools, type ToolContext } from '../src/agents/tools.js';
import { CASES, type EvalCase } from './cases.js';

// The key comes from the shell or from packages/server/.env (ANTHROPIC_API_KEY=...). No key is a
// failure, not a skip: a skipped eval looks like a passed one in the summary line.
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'));
} catch {}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Export it, or add ANTHROPIC_API_KEY=sk-... to packages/server/.env, then rerun bun run eval.');
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'output');
const MAX_ROUNDS = 6;

interface Row {
  id: string;
  pass: boolean;
  apt: boolean;
  skills: string[];
  failed: string[];
  costUsd: number;
  rounds: number;
}
const rows: Row[] = [];

/** Typographic dashes to ASCII so a regex written with "-" matches a reply written with "–". */
const DASHES = /[\u2010-\u2015\u2212]/g; // hyphen variants, en/em dash, minus; kept as escapes so the source stays readable
const normalise = (s: string) => s.replace(DASHES, '-').replace(/\u00a0/g, ' ');

describe('skill use', () => {
  const ctx = makeContext({ provider: new AnthropicProvider(apiKey), sf: {} as never });
  ctx.skills.seedFromDir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills'));
  const modelId = process.env.EVAL_MODEL ?? 'claude-opus-5';
  const model = ctx.repos.models.byProviderModel('anthropic', modelId) as AiModel | undefined;
  if (!model) throw new Error(`No model ${modelId} in the default catalogue`);
  const effort = ctx.repos.bindings.list().find((b) => b.role === 'orchestrator')?.effort ?? 'high';
  const loadSkill = TOOLS.find((t) => t.name === 'load_skill')!;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // One client, org and user for the whole run: the helper registers a fixed email, so seeding
  // per case collides. Each case still gets its own session.
  const seeded = seedClientOrgUser(ctx);

  async function run(c: EvalCase): Promise<Row> {
    const { user, client, org } = await seeded;
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const rules = ctx.policy.effective(client.id);
    const system = buildPromptSections({
      role: 'orchestrator',
      client,
      org,
      session,
      rules,
      skillsSection: ctx.skills.promptSection('orchestrator', client.id, org.id),
      memoryIndex: '',
      knowledgeSection: '',
      specialists: [],
      githubConfigured: false,
      tools: ['load_skill'],
      specialistInstructions: null,
    })
      .map((s) => s.text)
      .join('\n\n');
    const toolCtx: ToolContext = {
      app: ctx,
      runtime: ctx.runtime,
      session,
      org,
      client,
      rules,
      agent: { id: 'orchestrator', role: 'orchestrator', parentId: null },
      signal: new AbortController().signal,
      originals: new Map(),
    };
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${c.ask}\n\nAn analyst already investigated. Findings:\n${c.findings.map((f) => `- ${f}`).join('\n')}\n\nThis is an evaluation: the only tool available is load_skill. submit_plan, ask_user and the Salesforce tools are not available, so write the plan (or the answer, for a question) as your reply, in the shape submit_plan would take, and do not ask questions.`,
          },
        ],
      },
    ];
    const skills: string[] = [];
    let costUsd = 0;
    let rounds = 0;
    let reply = '';
    while (rounds < MAX_ROUNDS) {
      rounds++;
      const res: LlmResponse = await ctx.ai
        .provider('anthropic')
        .complete({ model, system, messages, tools: toLlmTools([loadSkill]), effort, maxTokens: 8000 });
      costUsd += ctx.ai.cost(model, res.usage);
      messages.push({
        role: 'assistant',
        content: res.content,
        raw: res.raw ? { provider: 'anthropic', modelId: model.modelId, content: res.raw } : undefined,
      });
      reply += res.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      const calls = res.content.filter((b) => b.type === 'tool_use');
      if (res.stopReason !== 'tool_use' || !calls.length) break;
      const results: LlmMessage['content'] = [];
      for (const call of calls) {
        if (call.type !== 'tool_use') continue;
        const name = String((call.input as { name?: string })?.name ?? '');
        skills.push(name);
        const r = await loadSkill.run(call.input as Record<string, unknown>, toolCtx);
        results.push({ type: 'tool_result', toolUseId: call.id, content: r.text, isError: r.ok === false });
      }
      messages.push({ role: 'user', content: results });
    }
    const text = normalise(reply);
    const failed = [
      ...c.must.filter((re) => !re.test(text)).map((re) => `missing ${re}`),
      ...(c.mustNot ?? []).filter((re) => re.test(text)).map((re) => `forbidden ${re}`),
    ];
    const apt = skills.length > 0 && c.apt.includes(skills[0]);
    fs.writeFileSync(
      path.join(OUT_DIR, `${c.id}.md`),
      `# ${c.id}\n\nSkills loaded: ${skills.join(', ') || 'none'}\nRounds: ${rounds}  Cost: $${costUsd.toFixed(3)}\nFailed: ${failed.join('; ') || 'none'}\n\n---\n\n${reply}\n`,
    );
    return { id: c.id, pass: failed.length === 0, apt, skills, failed, costUsd, rounds };
  }

  for (const c of CASES) {
    it.concurrent(c.id, async () => {
      const row = await run(c);
      rows.push(row);
      expect(row.failed, `${c.id}: ${row.failed.join('; ')}`).toEqual([]);
    });
  }

  afterAll(() => {
    const passed = rows.filter((r) => r.pass).length;
    const apt = rows.filter((r) => r.apt).length;
    const total = rows.reduce((n, r) => n + r.costUsd, 0);
    const lines = rows
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(
        (r) =>
          `${r.pass ? 'PASS' : 'FAIL'}  ${r.apt ? 'apt ' : '    '} ${r.id.padEnd(32)} $${r.costUsd.toFixed(3)}  ${r.rounds}r  ${r.skills.join(' > ') || '(no skill)'}${r.failed.length ? `\n      ${r.failed.join('; ')}` : ''}`,
      );
    process.stdout.write(
      `\n${lines.join('\n')}\n\n${passed}/${rows.length} passed, ${apt}/${rows.length} loaded an apt skill first, $${total.toFixed(2)} on ${modelId}\n`,
    );
  });
});
