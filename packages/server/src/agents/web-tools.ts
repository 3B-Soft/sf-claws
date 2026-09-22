import { z } from 'zod';
import type { ToolDef } from './tools.js';
import { WEB_SEARCH_PROMPT } from './tool-prompts.js';

const domain = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i)
  .transform((v) => v.toLowerCase());
const schema = z.object({
  query: z.string().trim().min(1).max(1000),
  allowedDomains: z.array(domain).max(10).optional(),
  blockedDomains: z.array(domain).max(10).optional(),
  count: z.number().int().min(1).max(20).default(5),
});
const responseSchema = z.object({
  web: z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), description: z.string().optional() })) }).optional(),
});
const within = (host: string, allowed: string) => host === allowed || host.endsWith(`.${allowed}`);

/** Fixed provider endpoint: model-supplied URLs never become server fetch targets. */
export async function searchWeb(input: z.input<typeof schema>, key: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const p = schema.parse(input);
  if (p.allowedDomains?.length && p.blockedDomains?.length) throw new Error('Use allowedDomains or blockedDomains, not both.');
  if (!key) throw new Error('Web search is not configured. Set BRAVE_SEARCH_API_KEY on the server.');
  const filters = p.allowedDomains?.length
    ? ` (${p.allowedDomains.map((d) => `site:${d}`).join(' OR ')})`
    : (p.blockedDomains ?? []).map((d) => ` -site:${d}`).join('');
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', p.query + filters);
  url.searchParams.set('count', String(p.count));
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!res.ok) throw new Error(`Web search service returned HTTP ${res.status}.`);
  const body = responseSchema.parse(await res.json());
  return (body.web?.results ?? [])
    .filter((item) => {
      try {
        const parsed = new URL(item.url);
        return (
          ['https:', 'http:'].includes(parsed.protocol) &&
          !parsed.username &&
          !parsed.password &&
          (!p.allowedDomains?.length || p.allowedDomains.some((d) => within(parsed.hostname, d))) &&
          !(p.blockedDomains ?? []).some((d) => within(parsed.hostname, d))
        );
      } catch {
        return false;
      }
    })
    .slice(0, p.count)
    .map((r) => ({ title: r.title.slice(0, 500), url: r.url, snippet: (r.description ?? '').slice(0, 3000) }));
}
export const WEB_TOOLS: ToolDef[] = [
  {
    name: 'web_search',
    description: WEB_SEARCH_PROMPT,
    inputSchema: z.toJSONSchema(schema, { io: 'input' }),
    roles: 'all',
    readOnly: true,
    concurrencySafe: true,
    earlyStart: false,
    maxResultChars: 30000,
    run: async (input, ctx) => {
      const results = await searchWeb(input, ctx.app.config.BRAVE_SEARCH_API_KEY, ctx.signal);
      return { text: JSON.stringify({ results, note: 'Untrusted public search snippets. Cite the URLs supporting your answer.' }), output: results };
    },
  },
];
