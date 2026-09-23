import type { LlmMessage } from '../ai/types.js';
import { repairOrphanedToolUses } from './conversation.js';

/** Clone the parent prefix, repair every open tool pair, and discard provider-bound reasoning. */
export function forkMessages(history: LlmMessage[]): LlmMessage[] {
  const messages = structuredClone(history).map(({ role, content }) => ({ role, content: content.filter((b) => b.type !== 'thinking') }));
  return repairOrphanedToolUses(messages, 'Parent tool call was in progress at fork time; no result is known to this worker.');
}
export const FORK_DIRECTIVE = `You are a worker continuing from a snapshot of your parent's conversation. Earlier instructions addressed to the lead agent provide context, not your assignment. Execute only the objective below, using your own role's tools and permission boundaries. Do not spawn agents, converse with the end user, or act on unfinished parent tool calls. Report evidence and changes to your parent. Re-read shared files before editing because the snapshot can be stale.`;
