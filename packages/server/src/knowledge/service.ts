/**
 * Knowledge sources: the agents' grounding in the products deployed inside a client's org.
 *
 * A Salesforce consultancy usually implements the same handful of products over and over. An agent
 * that can read those products' documentation, and search their source when the documentation runs
 * out, gives advice about the actual system instead of generic Salesforce advice. This service is
 * deliberately generic: an agency points it at its own documentation repository and its own product
 * repositories, and nothing about any particular product is compiled in.
 *
 * Two kinds of source:
 *  - `docs` — a repository of markdown, loaded as a searchable corpus with a compact index.
 *  - `repo` — a source repository, searched on demand by the researcher sub-agent.
 */
import type { KnowledgeSource } from '@sf-claws/shared';
import type { Repos, KnowledgeSourceRow } from '../db/repos/index.js';
import type { SecretBox } from '../lib/crypto.js';
import type { Logger } from '../logger.js';
import { RepoStore, parseRepoRef } from './repo-store.js';

/** How long a documentation corpus stays warm. */
const CORPUS_TTL_MS = 5 * 60_000;
/** Documents listed in the always-loaded index. */
const INDEX_LIMIT = 150;
/** Characters the index may occupy in the prompt; it sits in the cached prefix, so bounded. */
const INDEX_MAX_CHARS = 8000;
/** Characters of a document body kept in a search snippet. */
const SNIPPET_CHARS = 400;

export interface KnowledgeDoc {
  sourceId: string;
  sourceName: string;
  path: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
}

interface Corpus {
  docs: KnowledgeDoc[];
  at: number;
}

export class KnowledgeService {
  private corpora = new Map<string, Corpus>();
  readonly repos_: RepoStore;

  constructor(
    private repos: Repos,
    private secrets: SecretBox,
    private log: Logger,
    fetchImpl: typeof fetch = fetch,
    private defaultToken = '',
  ) {
    this.repos_ = new RepoStore(log, fetchImpl);
  }

  /** Sources this client may use. */
  forClient(clientId: string): KnowledgeSourceRow[] {
    return this.repos.knowledge.forClient(clientId);
  }

  invalidate(sourceId?: string): void {
    if (!sourceId) {
      this.corpora.clear();
      this.repos_.invalidate();
      return;
    }
    const src = this.repos.knowledge.byId(sourceId);
    this.corpora.delete(sourceId);
    if (src) this.repos_.invalidate(src.repoRef);
  }

  /**
   * The knowledge section of the system prompt. Static for the session (sources change rarely) and
   * byte-stable within the corpus TTL (the index is sorted and capped), so it sits in the cacheable
   * half of the prompt. The documentation index is included so an agent can orient without a
   * search: a title list is what turns "search the docs" from a guess into a lookup.
   */
  async promptSection(clientId: string): Promise<string> {
    const sources = this.forClient(clientId);
    if (!sources.length) return '';
    const docs = sources.filter((s) => s.kind === 'docs');
    const repos = sources.filter((s) => s.kind === 'repo');
    const lines: string[] = ['## Product knowledge available to you'];
    if (docs.length) {
      lines.push(
        `Documentation sources (search_product_docs / read_product_doc):\n${docs.map((s) => `- "${s.name}": ${firstLine(s.guidance) || 'product documentation'}`).join('\n')}`,
      );
    }
    if (repos.length) {
      lines.push(
        `Source repositories (investigate_product_repo):\n${repos.map((s) => `- "${s.name}" (${s.repoRef}): ${firstLine(s.guidance) || 'product source'}`).join('\n')}`,
      );
    }
    if (docs.length) {
      const index = await this.index(clientId);
      if (index) lines.push(`Documentation index (path: title; read any of them with read_product_doc):\n${index}`);
    }
    lines.push(`How to use them:
- Documentation first. Search the docs before scanning any repository; a repository scan is for what the documentation does not answer.
- Never answer a question about these products from general knowledge or from what typical Salesforce apps do. If the documentation and the code do not say, say that.
- Start from the exact error text. When the user quotes an error, search the literal message in the docs and the code before theorising about causes.
- Code is ground truth, documentation can be stale. When they disagree, follow the code and say which document is out of date, by path.
- Keep the two kinds of memory apart. Product knowledge is how these products work in general; session memory (search_memory) is what was done in THIS org. Never present one as the other.
- Prefer configuration over code. If behaviour is driven by a setting, a custom metadata record or a rule expression, change that — do not write Apex around a product's configuration surface.
- Never paste product implementation source into chat or documentation. Configuration and customisation examples are fine and expected: when asked for a sample rule, filter, mapping or configuration record you are expected to write one, modelled on the existing samples in the documentation or the repository.
- "Not in the documentation or the code" is a valid answer. A failed tool call is not evidence of absence.`);
    return lines.join('\n\n');
  }

  // ------------------------------------------------------------ documentation

  /** Load and cache a documentation source as a searchable corpus. */
  async corpus(source: KnowledgeSourceRow): Promise<KnowledgeDoc[]> {
    const cached = this.corpora.get(source.id);
    if (cached && Date.now() - cached.at < CORPUS_TTL_MS) return cached.docs;
    const snap = await this.repos_.snapshot(source.repoRef, this.tokenFor(source));
    const docs: KnowledgeDoc[] = [];
    for (const [path, content] of snap.files) {
      // Dot and underscore folders (.docs, _temp, _emails) and root agent guides are authoring
      // material in a content repo, not product documentation; they only pollute search.
      if (!/\.mdx?$/i.test(path) || /(^|\/)[._]/.test(path) || /^(claude|agents)\.md$/i.test(path)) continue;
      const { meta, body } = splitFrontMatter(content);
      docs.push({
        sourceId: source.id,
        sourceName: source.name,
        path,
        title:
          meta.title ||
          path
            .split('/')
            .pop()!
            .replace(/\.mdx?$/i, ''),
        description: meta.description || meta.summary || '',
        tags:
          typeof meta.tags === 'string'
            ? meta.tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
        body,
      });
    }
    // Deterministic order keeps any prompt built from the corpus byte-stable within the TTL.
    docs.sort((a, b) => a.path.localeCompare(b.path));
    this.corpora.set(source.id, { docs, at: Date.now() });
    return docs;
  }

  /** Full-text search across every documentation source this client can see. */
  async searchDocs(clientId: string, query: string, limit = 8): Promise<{ doc: KnowledgeDoc; score: number; snippet: string }[]> {
    const sources = this.forClient(clientId).filter((s) => s.kind === 'docs');
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2);
    if (!terms.length) return [];
    const results: { doc: KnowledgeDoc; score: number; snippet: string }[] = [];
    const failures: string[] = [];
    for (const source of sources) {
      let docs: KnowledgeDoc[];
      try {
        docs = await this.corpus(source);
      } catch (e) {
        this.log.warn({ source: source.name, err: (e as Error).message }, 'knowledge source unavailable');
        failures.push(`"${source.name}": ${(e as Error).message}`);
        continue;
      }
      for (const doc of docs) {
        const haystack = `${doc.title}\n${doc.description}\n${doc.tags.join(' ')}\n${doc.body}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (doc.title.toLowerCase().includes(t)) score += 5;
          if (doc.tags.some((tag) => tag.toLowerCase().includes(t))) score += 3;
          const occurrences = haystack.split(t).length - 1;
          score += Math.min(occurrences, 5);
        }
        if (score > 0) results.push({ doc, score, snippet: snippetAround(doc.body, terms[0]) });
      }
    }
    // No source loaded at all: an empty list would read as "not documented", which is false.
    // ponytail: a partial failure (one of several sources) still returns the others' hits silently.
    if (failures.length && failures.length === sources.length) throw new Error(`Product documentation unavailable — ${failures.join('; ')}`);
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async readDoc(clientId: string, path: string): Promise<KnowledgeDoc | null> {
    const failures: Error[] = [];
    for (const source of this.forClient(clientId).filter((s) => s.kind === 'docs')) {
      const docs = await this.corpus(source).catch((e: Error) => {
        failures.push(e);
        return [] as KnowledgeDoc[];
      });
      const hit = docs.find((d) => d.path === path || d.path.endsWith(`/${path}`));
      if (hit) return hit;
    }
    if (failures.length) throw failures[0];
    return null;
  }

  /**
   * Compact index of documentation titles, for orientation without loading bodies. Deterministic
   * (sources by name, documents by path) and capped by lines and characters, so it can live in the
   * cached prefix without breaking the cache between calls.
   */
  async index(clientId: string): Promise<string> {
    const out: string[] = [];
    let chars = 0;
    const sources = this.forClient(clientId)
      .filter((s) => s.kind === 'docs')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const source of sources) {
      const docs = await this.corpus(source).catch((e) => {
        this.log.warn({ source: source.name, err: (e as Error).message }, 'knowledge index unavailable');
        return [] as KnowledgeDoc[];
      });
      for (const d of docs) {
        if (out.length >= INDEX_LIMIT) break;
        const line = `- ${d.path}: ${d.title}`;
        if (chars + line.length > INDEX_MAX_CHARS) break;
        out.push(line);
        chars += line.length;
      }
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------ repositories

  /** A warm snapshot of a source repository, for the researcher's search tools. */
  async snapshotFor(source: KnowledgeSourceRow) {
    if (source.kind !== 'repo') throw new Error(`"${source.name}" is a documentation source, not a repository.`);
    return this.repos_.snapshot(source.repoRef, this.tokenFor(source));
  }

  hasToken(source: KnowledgeSourceRow): boolean {
    return !!source.tokenEnc || !!this.defaultToken.trim();
  }

  /** A source-specific credential overrides the shared environment token. */
  private tokenFor(source: KnowledgeSourceRow): string {
    if (source.tokenEnc) return this.secrets.decrypt(source.tokenEnc);
    const token = this.defaultToken.trim();
    if (!token) throw new Error(`Knowledge source "${source.name}" has no access token configured. Set GITHUB_TOKEN or add a token for this source.`);
    return token;
  }

  /** Validate a source's configuration by fetching its repository. */
  async test(sourceId: string): Promise<{ ok: boolean; message: string }> {
    const source = this.repos.knowledge.byId(sourceId);
    if (!source) return { ok: false, message: 'Source not found' };
    if (!parseRepoRef(source.repoRef)) return { ok: false, message: `"${source.repoRef}" is not a valid owner/repo#branch reference.` };
    try {
      this.repos_.invalidate(source.repoRef);
      const snap = await this.repos_.snapshot(source.repoRef, this.tokenFor(source));
      const detail = source.kind === 'docs' ? `${(await this.corpus(source)).length} markdown documents` : `${snap.files.size} text files`;
      return { ok: true, message: `Reachable — ${detail}${snap.truncated ? ' (truncated at the size cap)' : ''}.` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}

export function toPublicSource(s: KnowledgeSourceRow, hasToken = s.hasToken): KnowledgeSource {
  const { tokenEnc: _tokenEnc, ...rest } = s;
  return { ...rest, hasToken };
}

const firstLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? '';

/** Front matter is intentionally simple `key: value`, matching how docs repos are usually written. */
export function splitFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

function snippetAround(body: string, term: string): string {
  const i = body.toLowerCase().indexOf(term);
  if (i < 0) return body.slice(0, SNIPPET_CHARS).trim();
  const from = Math.max(0, i - SNIPPET_CHARS / 2);
  return `${from > 0 ? '…' : ''}${body.slice(from, from + SNIPPET_CHARS).trim()}…`;
}
