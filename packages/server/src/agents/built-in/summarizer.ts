import type { BuiltInAgentDefinition } from './types.js';

export const summarizerAgent: BuiltInAgentDefinition = {
  role: 'summarizer',
  readOnly: true,
  whenToUse: 'Compress a transcript into a faithful continuation summary.',
  identity: `You compress conversation history into a faithful, compact summary preserving all facts, decisions, API names, ids, open questions and pending work.`,
  guidance: `Return only the summary.`,
};
