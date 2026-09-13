/**
 * Tool-result budgeting.
 *
 * Two separate limits, because they fail differently:
 *
 *  - Per tool: one debug log or one wide describe can be enormous on its own.
 *  - Per turn: six parallel reads each just under their own limit still add up to a message that
 *    swamps the context window. Capping each call individually does not catch this.
 *
 * Over-limit output is not thrown away. It is persisted as an artifact and replaced with a preview
 * plus a handle, so the agent can page back into the part it needs (`read_tool_output`) — the
 * interesting line is usually in the tail that naive truncation removes.
 */
import type { LlmBlock } from '../ai/types.js';

/** Default ceiling for a single tool result, in characters. */
export const DEFAULT_RESULT_LIMIT = 40_000;
/** Ceiling for everything one turn's tools return together. */
export const TURN_RESULT_LIMIT = 120_000;
/** How much of an over-limit result stays inline as a preview. */
const PREVIEW_CHARS = 2000;

export interface BudgetOptions {
  limitFor: (toolName: string) => number;
  /** Persist the full body and return a handle the agent can read back, or null if declined. */
  persist: (tool: string, content: string) => string | null;
  turnLimit?: number;
}

interface Sized {
  index: number;
  block: Extract<LlmBlock, { type: 'tool_result' }>;
  tool: string;
}

/** One executed tool call: the result block, tagged with the tool that produced it. */
export interface ResultEntry {
  tool: string;
  block: LlmBlock;
}

/**
 * Apply per-tool then per-turn limits to one turn's tool results, preserving order and every
 * tool_use/tool_result pairing.
 */
export function budgetTurnResults(entries: ResultEntry[], opts: BudgetOptions): LlmBlock[] {
  const out = entries.map((e) => e.block);
  const sized: Sized[] = [];
  out.forEach((b, index) => {
    if (b.type === 'tool_result' && typeof b.content === 'string') sized.push({ index, block: b, tool: entries[index].tool });
  });

  // Pass 1 — per-tool limits.
  for (const s of sized) {
    const limit = opts.limitFor(s.tool);
    if (!Number.isFinite(limit) || s.block.content.length <= limit) continue;
    out[s.index] = spill(s.block, s.tool, opts.persist);
  }

  // Pass 2 — per-turn aggregate, trimming the largest remaining results first so one huge result
  // cannot starve several small useful ones.
  const turnLimit = opts.turnLimit ?? TURN_RESULT_LIMIT;
  let total = out.reduce((n, b) => n + (b.type === 'tool_result' && typeof b.content === 'string' ? b.content.length : 0), 0);
  if (total <= turnLimit) return out;

  const remaining = sized
    .map((s) => ({ ...s, block: out[s.index] as Extract<LlmBlock, { type: 'tool_result' }> }))
    .filter((s) => s.block.type === 'tool_result' && typeof s.block.content === 'string')
    .sort((a, b) => b.block.content.length - a.block.content.length);

  for (const s of remaining) {
    if (total <= turnLimit) break;
    const before = s.block.content.length;
    if (before <= PREVIEW_CHARS) continue;
    out[s.index] = spill(s.block, s.tool, opts.persist);
    total -= before - (out[s.index] as Extract<LlmBlock, { type: 'tool_result' }>).content.length;
  }
  return out;
}

function spill(block: Extract<LlmBlock, { type: 'tool_result' }>, tool: string, persist: BudgetOptions['persist']): LlmBlock {
  const full = block.content;
  let handle: string | null = null;
  try {
    handle = persist(tool, full);
  } catch {
    handle = null;
  }
  const preview = full.slice(0, PREVIEW_CHARS);
  const note = handle
    ? `\n\n[Output truncated: ${full.length} characters total. The full output is saved as artifact ${handle} — read it with read_tool_output({ handle: "${handle}", offset, limit }).]`
    : `\n\n[Output truncated: ${full.length} characters total.]`;
  return { ...block, content: preview + note };
}
