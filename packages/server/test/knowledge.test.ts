import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { RepoStore, parseRepoRef, parseTar, globToRegExp } from '../src/knowledge/repo-store.js';
import { splitFrontMatter } from '../src/knowledge/service.js';
import { compileSafePattern } from '../src/knowledge/pattern-guard.js';
import { makeContext, seedClientOrgUser } from './helpers.js';
import { createLogger } from '../src/logger.js';

/** Build a USTAR archive the way GitHub does: everything nested under owner-repo-sha/. */
function makeTarball(files: Record<string, string | Buffer>, prefix = 'acme-product-abc123'): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const content = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const header = Buffer.alloc(512);
    header.write(`${prefix}/${name}`, 0, 100, 'utf8');
    header.write('000644 \0', 100, 8, 'utf8');
    header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8');
    header.write('0', 156, 1, 'utf8'); // regular file
    // Checksum: the reader does not verify it, but keep the field well-formed.
    header.write('        ', 148, 8, 'utf8');
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return gzipSync(Buffer.concat(blocks));
}

function fakeFetch(tarball: Buffer, onCall?: (url: string) => void): typeof fetch {
  return (async (url: string) => {
    onCall?.(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength) };
  }) as unknown as typeof fetch;
}

const SAMPLE = {
  'README.md': '# Product\nThe compliance engine lives in force-app.',
  'force-app/main/default/classes/ComplianceService.cls':
    'public with sharing class ComplianceService {\n  public static void evaluate(List<Compliance_Group__c> groups) {\n    // rule evaluation\n  }\n}',
  'force-app/main/default/classes/OtherService.cls': 'public class OtherService { }',
  'docs/setup.md':
    '---\ntitle: Setting up compliance\ndescription: How to configure compliance groups\ntags: compliance, setup\n---\nCreate a Compliance Group record, then assign rules to it.',
  'docs/release-4.2.md': '---\ntitle: Release 4.2\n---\nFixed the compliance rule ordering bug.',
  'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  'node_modules/dep/index.js': 'module.exports = 1;',
};

describe('repo reference parsing', () => {
  it('accepts owner/repo with an optional branch and rejects junk', () => {
    expect(parseRepoRef('acme/product')).toEqual({ owner: 'acme', repo: 'product', branch: 'main' });
    expect(parseRepoRef('acme/product#develop')).toEqual({ owner: 'acme', repo: 'product', branch: 'develop' });
    expect(parseRepoRef('not a repo')).toBeNull();
    expect(parseRepoRef('https://github.com/acme/product')).toBeNull();
  });
});

describe('tar parsing', () => {
  it('reads regular files and skips the end-of-archive padding', () => {
    const entries = [...parseTar(require('node:zlib').gunzipSync(makeTarball({ 'a.txt': 'hello', 'b.txt': 'world' })))];
    expect(entries.map(([p]) => p)).toEqual(['acme-product-abc123/a.txt', 'acme-product-abc123/b.txt']);
    expect(entries[0][1].toString()).toBe('hello');
  });
});

describe('glob matching', () => {
  it('distinguishes * from ** so a single star stays within one path segment', () => {
    expect(globToRegExp('**/*.cls').test('force-app/main/default/classes/X.cls')).toBe(true);
    expect(globToRegExp('*.cls').test('force-app/X.cls')).toBe(false);
    expect(globToRegExp('*.cls').test('X.cls')).toBe(true);
    expect(globToRegExp('objects/?.xml').test('objects/A.xml')).toBe(true);
    expect(globToRegExp('objects/?.xml').test('objects/AB.xml')).toBe(false);
  });

  it('escapes regex metacharacters in literal path segments', () => {
    expect(globToRegExp('a.b/**').test('a.b/c')).toBe(true);
    expect(globToRegExp('a.b/**').test('axb/c')).toBe(false);
  });
});

describe('repository snapshots', () => {
  const store = () => new RepoStore(createLogger('error', false), fakeFetch(makeTarball(SAMPLE)));

  it('strips the GitHub prefix, skips binaries and dependency directories', async () => {
    const snap = await store().snapshot('acme/product', 'tok');
    const paths = [...snap.files.keys()].sort();
    expect(paths).toContain('README.md');
    expect(paths).toContain('force-app/main/default/classes/ComplianceService.cls');
    // Binary and dependency noise never enters the snapshot — it is cost with no research value.
    expect(paths).not.toContain('assets/logo.png');
    expect(paths).not.toContain('node_modules/dep/index.js');
    expect(snap.skipped).toBeGreaterThan(0);
  });

  it('serves repeat requests from cache instead of downloading again', async () => {
    const urls: string[] = [];
    const s = new RepoStore(
      createLogger('error', false),
      fakeFetch(makeTarball(SAMPLE), (u) => urls.push(u)),
    );
    await s.snapshot('acme/product', 'tok');
    await s.snapshot('acme/product', 'tok');
    expect(urls).toHaveLength(1);
    s.invalidate('acme/product');
    await s.snapshot('acme/product', 'tok');
    expect(urls).toHaveLength(2);
  });

  it('greps with content, files and count modes', async () => {
    const s = store();
    const snap = await s.snapshot('acme/product', 'tok');

    const content = s.grep(snap, { pattern: 'Compliance_Group__c' });
    expect(content.lines.join('\n')).toContain('ComplianceService.cls:2:');
    expect(content.filesMatched).toBe(1);

    const files = s.grep(snap, { pattern: 'class', mode: 'files' });
    expect(files.lines).toContain('force-app/main/default/classes/OtherService.cls');

    const counts = s.grep(snap, { pattern: 'class', mode: 'count' });
    expect(counts.lines.some((l) => /ComplianceService\.cls: \d+/.test(l))).toBe(true);
  });

  it('restricts a grep by glob and returns context lines', async () => {
    const s = store();
    const snap = await s.snapshot('acme/product', 'tok');
    const scoped = s.grep(snap, { pattern: 'evaluate', glob: '**/*.cls', contextLines: 1 });
    expect(scoped.lines.length).toBeGreaterThan(1);
    expect(scoped.lines.every((l) => l.includes('.cls'))).toBe(true);
    expect(s.grep(snap, { pattern: 'evaluate', glob: '**/*.md' }).lines).toHaveLength(0);
  });

  it('reads files with numbered lines and pages large ones', async () => {
    const s = store();
    const snap = await s.snapshot('acme/product', 'tok');
    const r = s.read(snap, 'force-app/main/default/classes/ComplianceService.cls');
    expect('text' in r && r.text).toContain('    1\tpublic with sharing class');
    const paged = s.read(snap, 'force-app/main/default/classes/ComplianceService.cls', 1, 1);
    expect('text' in paged && paged.text.trim().startsWith('2')).toBe(true);
  });

  it('suggests near-miss paths instead of just failing', async () => {
    const s = store();
    const snap = await s.snapshot('acme/product', 'tok');
    const r = s.read(snap, 'wrong/place/ComplianceService.cls');
    expect('suggestions' in r && r.suggestions).toContain('force-app/main/default/classes/ComplianceService.cls');
  });

  it('finds files by fragment, falling back to fuzzy matching', async () => {
    const s = store();
    const snap = await s.snapshot('acme/product', 'tok');
    expect(s.findFiles(snap, 'ComplianceService')).toHaveLength(1);
    expect(s.findFiles(snap, 'cmplsrvc').length).toBeGreaterThan(0); // subsequence fallback
  });

  it('surfaces guide documents and top-level structure in the overview', async () => {
    const s = store();
    const snap = await s.snapshot('acme/product', 'tok');
    const o = s.overview(snap);
    expect(o.dirs).toEqual(expect.arrayContaining(['docs', 'force-app']));
    expect(o.guides.map((g) => g.path)).toContain('README.md');
  });

  it('refuses an over-long pattern rather than compiling it', async () => {
    const s = store();
    const snap = await s.snapshot('acme/product', 'tok');
    // A model-supplied regex runs on the shared event loop; an unbounded one is a denial of
    // service against every other tenant, not just a slow search for this one.
    expect(() => s.grep(snap, { pattern: 'a'.repeat(500) })).toThrow(/too long/i);
  });

  it('refuses a catastrophically backtracking pattern instead of hanging on it', async () => {
    const longLine = `x${'a'.repeat(50_000)}`;
    const s = new RepoStore(createLogger('error', false), fakeFetch(makeTarball({ 'big.txt': longLine })));
    const snap = await s.snapshot('acme/product', 'tok');
    const started = Date.now();
    // Left to run, this takes minutes and blocks the event loop for every other tenant.
    expect(() => s.grep(snap, { pattern: '(a+)+b' })).toThrow(/nests one repetition/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports an unreachable repository with an actionable message', async () => {
    const failing = new RepoStore(createLogger('error', false), (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch);
    await expect(failing.snapshot('acme/missing', 'tok')).rejects.toThrow(/HTTP 404/);
    await expect(failing.snapshot('nonsense', 'tok')).rejects.toThrow(/owner\/repo#branch/);
  });
});

describe('documentation front matter', () => {
  it('parses simple key: value front matter and keeps the body', () => {
    const { meta, body } = splitFrontMatter('---\ntitle: Hello\ntags: a, b\n---\nBody text');
    expect(meta.title).toBe('Hello');
    expect(body).toBe('Body text');
  });

  it('treats a document without front matter as all body', () => {
    expect(splitFrontMatter('# Just markdown').body).toBe('# Just markdown');
  });
});

describe('knowledge service', () => {
  async function withSource(kind: 'docs' | 'repo' = 'docs') {
    const ctx = makeContext({ fetch: fakeFetch(makeTarball(SAMPLE)) });
    const { client } = await seedClientOrgUser(ctx);
    const source = ctx.repos.knowledge.create({
      kind,
      name: 'Product docs',
      repoRef: 'acme/product',
      guidance: 'Our product documentation.',
      scope: 'global',
      tokenEnc: ctx.secrets.encrypt('gh-token'),
    });
    return { ctx, client, source };
  }

  it('searches documentation and ranks title matches above body mentions', async () => {
    const { ctx, client } = await withSource();
    const hits = await ctx.knowledge.searchDocs(client.id, 'compliance setup');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc.path).toBe('docs/setup.md');
    expect(hits[0].snippet).toContain('Compliance Group');
  });

  it('reads a document by path', async () => {
    const { ctx, client } = await withSource();
    const doc = await ctx.knowledge.readDoc(client.id, 'docs/release-4.2.md');
    expect(doc?.title).toBe('Release 4.2');
    expect(await ctx.knowledge.readDoc(client.id, 'docs/nope.md')).toBeNull();
  });

  it('keeps client-scoped sources invisible to other clients', async () => {
    const { ctx, client } = await withSource();
    const other = ctx.repos.clients.create({ name: 'Other', slug: 'other' });
    ctx.repos.knowledge.create({ kind: 'repo', name: 'Private repo', repoRef: 'acme/private', guidance: '', scope: 'client', clientId: client.id });
    expect(ctx.knowledge.forClient(client.id).map((s) => s.name)).toContain('Private repo');
    expect(ctx.knowledge.forClient(other.id).map((s) => s.name)).not.toContain('Private repo');
    // The global source is still shared with everyone.
    expect(ctx.knowledge.forClient(other.id).map((s) => s.name)).toContain('Product docs');
  });

  it('describes configured sources in the prompt and stays silent when there are none', async () => {
    const { ctx, client } = await withSource('repo');
    const section = await ctx.knowledge.promptSection(client.id);
    expect(section).toContain('Product docs');
    expect(section).toContain('Documentation first');
    const empty = ctx.repos.clients.create({ name: 'Empty', slug: 'empty' });
    ctx.repos.knowledge.update(ctx.knowledge.forClient(client.id)[0].id, { scope: 'client', clientId: client.id });
    expect(await ctx.knowledge.promptSection(empty.id)).toBe('');
  });

  it('refuses to use a source with no token rather than borrowing another credential', async () => {
    const ctx = makeContext({ fetch: fakeFetch(makeTarball(SAMPLE)) });
    const { client } = await seedClientOrgUser(ctx);
    const source = ctx.repos.knowledge.create({ kind: 'repo', name: 'No token', repoRef: 'acme/product', guidance: '', scope: 'global' });
    await expect(ctx.knowledge.snapshotFor(ctx.repos.knowledge.byId(source.id)!)).rejects.toThrow(/no access token/i);
    expect(ctx.knowledge.forClient(client.id)).toHaveLength(1);
  });

  it('reports source health through test()', async () => {
    const { ctx, source } = await withSource();
    const ok = await ctx.knowledge.test(source.id);
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain('markdown documents');
  });

  it('searches a product content repo (products.json + <product>/articles|faq|releases) and skips authoring folders', async () => {
    const ctx = makeContext({
      fetch: fakeFetch(
        makeTarball({
          'products.json': '{"products":[]}',
          'Claude.md': '# Authoring rules for layout docs',
          '.docs/release-changelog-guide.md': 'layout guide',
          '_temp/export.md': 'layout export',
          'forms/articles/page-layouts.md': '---\ntitle: Page layouts\ntags: layout\n---\nAdd the field to the Contact page layout.',
          'forms/releases/Version_10/index.md': '---\ntitle: Version 10 Change Log\n---\nLayout fixes.',
        }),
      ),
    });
    const { client } = await seedClientOrgUser(ctx);
    ctx.repos.knowledge.create({
      kind: 'docs',
      name: 'KnowHow',
      repoRef: 'acme/knowhow',
      guidance: '',
      scope: 'global',
      tokenEnc: ctx.secrets.encrypt('gh-token'),
    });
    const hits = await ctx.knowledge.searchDocs(client.id, 'Contact page-layout?');
    expect(hits.map((h) => h.doc.path)).toEqual(['forms/articles/page-layouts.md', 'forms/releases/Version_10/index.md']);
  });

  it('reports an unusable documentation source instead of returning no matches', async () => {
    const ctx = makeContext({ fetch: fakeFetch(makeTarball(SAMPLE)) });
    const { client } = await seedClientOrgUser(ctx);
    ctx.repos.knowledge.create({ kind: 'docs', name: 'No token', repoRef: 'acme/product', guidance: '', scope: 'global' });
    await expect(ctx.knowledge.searchDocs(client.id, 'compliance')).rejects.toThrow(/"No token".*no access token/i);
    await expect(ctx.knowledge.readDoc(client.id, 'docs/setup.md')).rejects.toThrow(/no access token/i);
  });
});

describe('regex safety guard', () => {
  it('rejects the classic exponential shapes', () => {
    for (const pattern of ['(a+)+b', '(a*)*c', '(\\d+)+$', '(x+)*y', '([a-z]+)+', '(ab+)+c', '(a+){2,}']) {
      expect(() => compileSafePattern(pattern, 'g'), pattern).toThrow(/nests one repetition/);
    }
  });

  it('allows the patterns an agent actually needs', () => {
    for (const pattern of [
      'Compliance_Group__c',
      'class\\s+\\w+Service',
      'public (static )?void \\w+\\(',
      '^\\s*<fullName>.*</fullName>$',
      'insert\\s+\\w+',
      '(foo|bar)baz',
      '\\w{2,10}',
      '[A-Z][a-z]+_[a-z]+__c',
    ]) {
      expect(() => compileSafePattern(pattern, 'g'), pattern).not.toThrow();
    }
  });

  it('is not fooled by escapes or character classes that look like nesting', () => {
    // A literal "+" inside a class is not a quantifier.
    expect(() => compileSafePattern('([+*]+)+', 'g')).toThrow();
    expect(() => compileSafePattern('(\\+)+', 'g')).not.toThrow();
    expect(() => compileSafePattern('(\\*)*', 'g')).not.toThrow();
  });

  it('refuses an over-long or invalid pattern with a usable message', () => {
    expect(() => compileSafePattern('a'.repeat(500), 'g')).toThrow(/too long/i);
    expect(() => compileSafePattern('(unclosed', 'g')).toThrow(/Invalid regular expression/);
    expect(() => compileSafePattern('', 'g')).toThrow(/empty/i);
  });
});

describe('multiline grep and continuation', () => {
  const log = createLogger('error', false);
  const files = {
    'classes/Svc.cls': 'public class Svc {\n  public void run() {\n    evaluate();\n  }\n}',
    'many.txt': Array.from({ length: 5 }, (_, i) => `hit ${i}`).join('\n'),
  };

  it('matches across line boundaries when asked, reporting the line where the match starts', async () => {
    const s = new RepoStore(log, fakeFetch(makeTarball(files)));
    const snap = await s.snapshot('acme/product', 't');
    expect(s.grep(snap, { pattern: 'Svc \\{\\s+public void run' }).lines).toEqual([]);
    const r = s.grep(snap, { pattern: 'Svc \\{\\s+public void run', multiline: true });
    expect(r.lines).toEqual(['classes/Svc.cls:1: public class Svc {']);
    expect(r.totalMatches).toBe(1);
    expect(r.nextOffset).toBeNull();
  });

  it('pages with a continuation offset and a total', async () => {
    const s = new RepoStore(log, fakeFetch(makeTarball(files)));
    const snap = await s.snapshot('acme/product', 't');
    const first = s.grep(snap, { pattern: '^hit', headLimit: 2 });
    expect(first.lines).toHaveLength(2);
    expect(first.totalMatches).toBe(5);
    expect(first.nextOffset).toBe(2);
    expect(first.truncated).toBe(true);
    const last = s.grep(snap, { pattern: '^hit', headLimit: 2, offset: 4 });
    expect(last.lines).toEqual(['many.txt:5: hit 4']);
    expect(last.nextOffset).toBeNull();
  });
});

describe('knowledge index in the prompt', () => {
  it('lists the documentation paths and titles so agents can orient without a search', async () => {
    const ctx = makeContext({ fetch: fakeFetch(makeTarball(SAMPLE)) });
    const { client } = await seedClientOrgUser(ctx);
    ctx.repos.knowledge.create({
      kind: 'docs',
      name: 'Product docs',
      repoRef: 'acme/product',
      guidance: 'Docs.',
      scope: 'global',
      tokenEnc: ctx.secrets.encrypt('t'),
    });
    const section = await ctx.knowledge.promptSection(client.id);
    expect(section).toContain('Documentation index');
    expect(section).toContain('- docs/setup.md: Setting up compliance');
    expect(section).toContain('modelled on the existing samples');
    // Byte-stable across calls within the TTL: it sits in the cached prefix.
    expect(await ctx.knowledge.promptSection(client.id)).toBe(section);
  });
});
