/**
 * Conversation-history invariants.
 *
 * Both provider protocols require every `tool_use` block to be answered by a `tool_result` with the
 * same id. We persist the assistant message as soon as it arrives and the results only after the
 * tools have run, so a crash, a restart or a cancellation inside that window leaves the stored
 * conversation with dangling `tool_use` blocks. Replaying it then fails the next request outright,
 * which is what turns a recoverable interruption into a dead session.
 *
 * Every path that loads or resumes a conversation runs it through `repairOrphanedToolUses` first.
 */
import type { LlmMessage, LlmBlock } from '../ai/types.js';

export const ORPHANED_TOOL_RESULT_TEXT =
  'This tool call was interrupted before it produced a result (the session was cancelled or the server restarted). Its outcome is unknown — verify the current state before assuming it succeeded or failed.';

/** Ids of `tool_use` blocks in the message that have no matching `tool_result` later on. */
export function unansweredToolUseIds(messages: LlmMessage[]): string[] {
  const answered = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) if (b.type === 'tool_result') answered.add(b.toolUseId);
  }
  const open: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) if (b.type === 'tool_use' && !answered.has(b.id)) open.push(b.id);
  }
  return open;
}

/**
 * Append synthetic error results for any unanswered `tool_use`, so the history is replayable.
 * Returns the original array when nothing is dangling (the overwhelmingly common case).
 */
export function repairOrphanedToolUses(messages: LlmMessage[], text = ORPHANED_TOOL_RESULT_TEXT): LlmMessage[] {
  const open = unansweredToolUseIds(messages);
  if (!open.length) return messages;
  const results: LlmBlock[] = open.map((id) => ({ type: 'tool_result', toolUseId: id, content: text, isError: true }));
  return [...messages, { role: 'user', content: results }];
}

/** Synthetic results for calls that never ran (used when a turn is aborted mid-batch). */
export function syntheticToolResults(toolUseIds: string[], text = ORPHANED_TOOL_RESULT_TEXT): LlmBlock[] {
  return toolUseIds.map((id) => ({ type: 'tool_result', toolUseId: id, content: text, isError: true }));
}

/** Tools whose dangling call can be answered later by the user through a confirmation card. */
const ANSWERABLE_TOOLS = new Set(['ask_user', 'submit_plan']);

/**
 * Turn the placeholder result of an interrupted ask_user / submit_plan call into the answer the
 * user gave after the restart. `answerFor` returns the result text for a call, or null when it is
 * still unanswered. Returns the original array when nothing changed.
 */
export function answerOrphanedQuestions(messages: LlmMessage[], answerFor: (name: string, input: unknown) => string | null): LlmMessage[] {
  const results = new Map<string, { mi: number; bi: number }>();
  messages.forEach((m, mi) => m.content.forEach((b, bi) => b.type === 'tool_result' && results.set(b.toolUseId, { mi, bi })));
  let out: LlmMessage[] | null = null;
  const appended: LlmBlock[] = [];
  messages.forEach((m) => {
    if (m.role !== 'assistant') return;
    for (const b of m.content) {
      if (b.type !== 'tool_use' || !ANSWERABLE_TOOLS.has(b.name)) continue;
      const pos = results.get(b.id);
      const existing = pos ? (messages[pos.mi].content[pos.bi] as Extract<LlmBlock, { type: 'tool_result' }>) : null;
      if (existing && existing.content !== ORPHANED_TOOL_RESULT_TEXT) continue;
      const answer = answerFor(b.name, b.input);
      if (!answer) continue;
      if (pos) {
        out ??= messages.map((x) => ({ ...x, content: [...x.content] }));
        out[pos.mi].content[pos.bi] = { type: 'tool_result', toolUseId: b.id, content: answer, isError: false };
      } else appended.push({ type: 'tool_result', toolUseId: b.id, content: answer, isError: false });
    }
  });
  if (!out && !appended.length) return messages;
  out ??= messages.map((x) => ({ ...x, content: [...x.content] }));
  if (appended.length) {
    // Every other unanswered call gets the generic placeholder so the history stays replayable.
    const answeredIds = new Set(appended.map((b) => (b as { toolUseId: string }).toolUseId));
    const others = unansweredToolUseIds(out).filter((id) => !answeredIds.has(id));
    out.push({ role: 'user', content: [...appended, ...syntheticToolResults(others)] });
  }
  return out;
}

/**
 * The shape `MessagesRepo.replace` expects. `append` stores the whole message as the row's content
 * and the loader reads it back as one; `replace` stores each item's `content` field. Passing raw
 * messages to `replace` would therefore store only their blocks, and the next load would crash on
 * a conversation with no `content` array. Every caller wraps through here.
 */
export function toStoredMessages(messages: LlmMessage[]): { role: string; content: LlmMessage }[] {
  return messages.map((m) => ({ role: m.role, content: m }));
}
