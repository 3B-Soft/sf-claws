import { z } from 'zod';
import type { ToolContext, ToolDef } from './tools.js';
import { globToRegExp } from './tools.js';
import type { Snapshot } from '../knowledge/repo-store.js';
import { GLOB_PROMPT, GREP_PROMPT } from './tool-prompts.js';

const scope = { repo: z.string().min(1).max(200).optional().describe('Linked repository name. Omit to search the staged workspace.') };
const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(150) };
const globSchema = z.object({ ...scope, ...page, pattern: z.string().min(1).max(400) });
const grepSchema = z.object({
  ...scope,
  ...page,
  pattern: z.string().min(1).max(400),
  glob: z.string().max(400).optional(),
  outputMode: z.enum(['files_with_matches', 'content', 'count']).default('files_with_matches'),
  contextLines: z.number().int().min(0).max(10).default(0),
  ignoreCase: z.boolean().default(false),
  multiline: z.boolean().default(false),
});
const readSchema = z.object({ ...scope, ...page, path: z.string().min(1).max(1000) });

async function snapshot(ctx: ToolContext, repo?: string): Promise<Snapshot> {
  if (repo || ctx.research) {
    const source = ctx.app.repos.knowledge.resolve(ctx.session.clientId, repo ?? ctx.research!.sourceId);
    if (source?.kind !== 'repo' || (ctx.research && source.id !== ctx.research.sourceId)) throw new Error('Linked repository not available in this context.');
    return ctx.app.knowledge.snapshotFor(source);
  }
  return {
    files: new Map(
      ctx.app.repos.workspace
        .list(ctx.session.id)
        .filter((f) => f.action !== 'deleted')
        .map((f) => [f.path, f.content]),
    ),
    at: Date.now(),
    skipped: 0,
    truncated: false,
  };
}
export const SEARCH_TOOLS: ToolDef[] = [
  {
    name: 'glob',
    description: GLOB_PROMPT,
    roles: 'all',
    readOnly: true,
    concurrencySafe: true,
    inputSchema: z.toJSONSchema(globSchema, { io: 'input' }),
    run: async (input, ctx) => {
      const p = globSchema.parse(input);
      const snap = await snapshot(ctx, p.repo);
      const re = globToRegExp(p.pattern);
      const all = [...snap.files.keys()].filter((path) => re.test(path)).sort();
      const paths = all.slice(p.offset, p.offset + p.limit);
      const output = {
        paths,
        total: all.length,
        nextOffset: p.offset + paths.length < all.length ? p.offset + paths.length : null,
        snapshotIncomplete: snap.truncated || snap.skipped > 0,
      };
      return { text: JSON.stringify(output), output };
    },
  },
  {
    name: 'grep',
    description: GREP_PROMPT,
    roles: 'all',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 60000,
    inputSchema: z.toJSONSchema(grepSchema, { io: 'input' }),
    run: async (input, ctx) => {
      const p = grepSchema.parse(input);
      const snap = await snapshot(ctx, p.repo);
      const sorted = { ...snap, files: new Map([...snap.files].sort(([a], [b]) => a.localeCompare(b))) };
      const output = {
        ...ctx.app.knowledge.repos_.grep(sorted, {
          pattern: p.pattern,
          glob: p.glob,
          mode: p.outputMode === 'files_with_matches' ? 'files' : p.outputMode,
          headLimit: p.limit,
          offset: p.offset,
          contextLines: p.contextLines,
          multiline: p.multiline,
          ignoreCase: p.ignoreCase,
        }),
        snapshotIncomplete: snap.truncated || snap.skipped > 0,
        searchLimits: 'Lines are searched up to 500 characters; multiline searches return at most 2000 match starts per file.',
      };
      return { text: JSON.stringify(output), output };
    },
  },
  {
    name: 'read_source_file',
    description:
      'Read a known path from the staged workspace or a linked repository with line numbers and zero-based paging. Use paths returned by glob/grep. No host filesystem access.',
    roles: 'all',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 60000,
    inputSchema: z.toJSONSchema(readSchema, { io: 'input' }),
    run: async (input, ctx) => {
      const p = readSchema.parse(input);
      if (ctx.research && ++ctx.research.readBudget.used > ctx.research.readBudget.max)
        return { text: 'File-read budget exhausted. Report the evidence gathered and remaining uncertainty.', ok: false };
      const snap = await snapshot(ctx, p.repo);
      const output = ctx.app.knowledge.repos_.read(snap, p.path, p.offset, p.limit);
      return { text: JSON.stringify(output), output, ok: 'text' in output };
    },
  },
];
