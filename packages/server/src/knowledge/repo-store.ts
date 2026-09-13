/**
 * Repository snapshots.
 *
 * Searching a repository through the GitHub Contents API means one HTTP round trip per file, which
 * is far too slow for an agent that wants to grep. Instead we download the branch tarball once,
 * hold the text files in memory for a few minutes, and serve grep/read/glob from that. One download
 * replaces hundreds of API calls, and repeated questions about the same repo cost nothing.
 *
 * Bounded on purpose: binary and oversized files are skipped, total text is capped, and only a
 * couple of snapshots are kept. An agent researching a large monorepo must not be able to exhaust
 * the server's memory for every other session.
 */
import { gunzipSync } from 'node:zlib';
import type { Logger } from '../logger.js';
import { compileSafePattern } from './pattern-guard.js';

/** How long a snapshot stays warm. */
const SNAPSHOT_TTL_MS = 5 * 60_000;
/** Largest single file kept in a snapshot. */
const MAX_FILE_BYTES = 500_000;
/** Total text held per repository. */
const MAX_REPO_TEXT_BYTES = 20 * 1024 * 1024;
/** Largest archive we will even attempt to unpack. */
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;
/** Snapshots kept in memory at once (LRU). */
const MAX_SNAPSHOTS = 2;
/** Ceiling on a single grep, so a pathological pattern cannot spin a CPU. */
const GREP_TIME_BUDGET_MS = 8000;
/** How often to re-check the deadline while scanning lines. */
const DEADLINE_CHECK_INTERVAL = 500;

const BINARY_EXT =
  /\.(png|jpe?g|gif|bmp|ico|webp|svgz|pdf|zip|gz|tgz|bz2|7z|rar|jar|war|class|exe|dll|so|dylib|woff2?|ttf|eot|otf|mp[34]|mov|avi|wasm|resource)$/i;
/** Directories whose contents are dependency noise rather than the product's own code. */
const NOISE_DIRS = /(^|\/)(node_modules|staticresources|\.git|dist|build|coverage)(\/|$)/i;

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

/** Parse `owner/repo#branch` (branch optional, defaults to main). */
export function parseRepoRef(ref: string): RepoRef | null {
  const m = /^([\w.-]+)\/([\w.-]+)(?:#(.+))?$/.exec(ref.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3] || 'main' };
}

export interface Snapshot {
  files: Map<string, string>;
  at: number;
  skipped: number;
  truncated: boolean;
}

export interface GrepOptions {
  pattern: string;
  glob?: string;
  mode?: 'content' | 'files' | 'count';
  contextLines?: number;
  headLimit?: number;
  offset?: number;
  multiline?: boolean;
}

export class RepoStore {
  private snapshots = new Map<string, Snapshot>();
  constructor(
    private log: Logger,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  /** Drop a cached snapshot (used when a source's configuration changes). */
  invalidate(repoRef?: string): void {
    if (repoRef) this.snapshots.delete(repoRef);
    else this.snapshots.clear();
  }

  async snapshot(repoRef: string, token: string): Promise<Snapshot> {
    const cached = this.snapshots.get(repoRef);
    if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached;
    const parsed = parseRepoRef(repoRef);
    if (!parsed) throw new Error(`Invalid repository reference "${repoRef}" — expected owner/repo#branch.`);

    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball/${encodeURIComponent(parsed.branch)}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sf-claws' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Could not download ${repoRef} (HTTP ${res.status}). Check the reference and the source's access token.`);
    const archive = Buffer.from(await res.arrayBuffer());
    if (archive.length > MAX_ARCHIVE_BYTES) throw new Error(`${repoRef} is too large to snapshot (${Math.round(archive.length / 1e6)}MB).`);

    const files = new Map<string, string>();
    let total = 0;
    let skipped = 0;
    let truncated = false;
    for (const [rawPath, buf] of parseTar(gunzipSync(archive))) {
      // GitHub tarballs nest everything under "owner-repo-sha/".
      const path = rawPath.split('/').slice(1).join('/');
      if (!path || path.endsWith('/')) continue;
      if (BINARY_EXT.test(path) || NOISE_DIRS.test(path) || buf.length > MAX_FILE_BYTES || buf.includes(0)) {
        skipped++;
        continue;
      }
      total += buf.length;
      if (total > MAX_REPO_TEXT_BYTES) {
        truncated = true;
        break;
      }
      files.set(path, buf.toString('utf8'));
    }

    const snap: Snapshot = { files, at: Date.now(), skipped, truncated };
    this.snapshots.set(repoRef, snap);
    // Crude LRU: insertion order, oldest first.
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    this.log.info({ repoRef, files: files.size, skipped, truncated }, 'repository snapshot loaded');
    return snap;
  }

  /** Top-level shape of the repository: directories, entry points and guide documents. */
  overview(snap: Snapshot): { dirs: string[]; guides: { path: string; content: string }[]; manifests: string[] } {
    const dirs = new Set<string>();
    const guides: { path: string; content: string }[] = [];
    const manifests: string[] = [];
    for (const [path, content] of snap.files) {
      const top = path.includes('/') ? path.split('/')[0] : '';
      if (top) dirs.add(top);
      if (/^(README|CLAUDE|AGENTS|CONTRIBUTING)\.md$/i.test(path)) guides.push({ path, content: content.slice(0, 20_000) });
      if (/^(package\.json|sfdx-project\.json|pom\.xml|requirements\.txt|Procfile)$/i.test(path)) manifests.push(path);
    }
    return { dirs: [...dirs].sort(), guides, manifests };
  }

  /**
   * Search the snapshot. `multiline` matches the pattern against whole files (so `\s` and `.`
   * with the `s` flag cross line boundaries) and reports the line where each match starts; the
   * default matches line by line against a truncated line, which bounds what a backtracking
   * pattern can chew on. Both go through the pattern guard first. `totalMatches` and `nextOffset`
   * let the caller page: a grep that found 900 lines and showed 150 must say so.
   */
  grep(snap: Snapshot, opts: GrepOptions): { lines: string[]; filesMatched: number; truncated: boolean; totalMatches: number; nextOffset: number | null } {
    // Rejects the patterns that can hang the shared event loop; see knowledge/pattern-guard.ts.
    const re = compileSafePattern(opts.pattern, opts.multiline ? 'gms' : 'gm');
    const pathFilter = opts.glob ? globToRegExp(opts.glob) : null;
    const mode = opts.mode ?? 'content';
    const headLimit = clamp(opts.headLimit ?? 150, 1, 2000);
    const offset = Math.max(0, opts.offset ?? 0);
    const contextLines = clamp(opts.contextLines ?? 0, 0, 10);
    const deadline = Date.now() + GREP_TIME_BUDGET_MS;

    const collected: string[] = [];
    let filesMatched = 0;
    let truncated = false;
    for (const [path, content] of snap.files) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      if (pathFilter && !pathFilter.test(path)) continue;
      const lines = content.split('\n');
      const hits: number[] = opts.multiline ? multilineHits(re, content) : [];
      if (!opts.multiline) {
        for (let i = 0; i < lines.length; i++) {
          if (i % DEADLINE_CHECK_INTERVAL === 0 && Date.now() > deadline) {
            truncated = true;
            break;
          }
          re.lastIndex = 0;
          // Match the truncated line: bounds the input a backtracking pattern can work on.
          if (re.test(truncateLine(lines[i]))) hits.push(i);
        }
      }
      if (truncated) break;
      if (!hits.length) continue;
      filesMatched++;
      if (mode === 'files') {
        collected.push(path);
        continue;
      }
      if (mode === 'count') {
        collected.push(`${path}: ${hits.length}`);
        continue;
      }
      for (const i of hits) {
        const from = Math.max(0, i - contextLines);
        const to = Math.min(lines.length - 1, i + contextLines);
        for (let n = from; n <= to; n++) collected.push(`${path}:${n + 1}${n === i ? ':' : '-'} ${truncateLine(lines[n])}`);
      }
    }
    const page = collected.slice(offset, offset + headLimit);
    const nextOffset = offset + page.length < collected.length ? offset + page.length : null;
    return { lines: page, filesMatched, truncated: truncated || nextOffset !== null, totalMatches: collected.length, nextOffset };
  }

  /** Read a file with `cat -n` style numbering and paging. */
  read(snap: Snapshot, path: string, offset = 0, limit = 400): { text: string; totalLines: number } | { suggestions: string[] } {
    const content = snap.files.get(path);
    if (content === undefined) return { suggestions: suggestPaths(snap, path) };
    const lines = content.split('\n');
    const slice = lines.slice(offset, offset + limit);
    const numbered = slice.map((l, i) => `${String(offset + i + 1).padStart(5)}\t${truncateLine(l)}`).join('\n');
    return { text: numbered, totalLines: lines.length };
  }

  glob(snap: Snapshot, pattern: string, limit = 200): string[] {
    const re = globToRegExp(pattern);
    const out: string[] = [];
    for (const path of snap.files.keys()) {
      if (re.test(path)) out.push(path);
      if (out.length >= limit) break;
    }
    return out.sort();
  }

  /** Substring match, falling back to fuzzy subsequence so a near-miss still finds the file. */
  findFiles(snap: Snapshot, text: string, limit = 40): string[] {
    const needle = text.toLowerCase();
    const exact = [...snap.files.keys()].filter((p) => p.toLowerCase().includes(needle));
    if (exact.length) return exact.slice(0, limit).sort();
    return [...snap.files.keys()]
      .filter((p) => isSubsequence(needle, p.toLowerCase()))
      .slice(0, limit)
      .sort();
  }
}

/**
 * Line numbers (0-based) at which multiline matches start, deduplicated. The whole file is the
 * input here, which is exactly what `multiline` asks for; the pattern guard has already refused
 * the shapes that make that dangerous, and a zero-width match is advanced past by hand so the
 * global regex cannot loop forever.
 */
function multilineHits(re: RegExp, content: string): number[] {
  const starts = new Set<number>();
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    starts.add(m.index);
    if (m[0].length === 0) re.lastIndex++;
    if (starts.size >= 2000) break;
  }
  if (!starts.size) return [];
  const lines: number[] = [];
  let line = 0;
  let cursor = 0;
  for (const start of [...starts].sort((a, b) => a - b)) {
    for (; cursor < start; cursor++) if (content.charCodeAt(cursor) === 10) line++;
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines;
}

/** Per-line cap so one minified file cannot dominate a result. */
const MAX_LINE_CHARS = 500;
const truncateLine = (l: string) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

function suggestPaths(snap: Snapshot, missing: string[] | string): string[] {
  const base = String(missing).split('/').pop()?.toLowerCase() ?? '';
  if (!base) return [];
  return [...snap.files.keys()].filter((p) => p.toLowerCase().endsWith(base)).slice(0, 5);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** Glob to RegExp: `**` crosses directory separators, `*` does not, `?` is one character. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * Minimal USTAR reader — enough for GitHub's tarballs, without adding a dependency.
 * Yields [path, contents] for regular files only.
 */
export function* parseTar(buf: Buffer): Generator<[string, Buffer]> {
  const BLOCK = 512;
  let offset = 0;
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    offset += BLOCK;
    const dataBlocks = Math.ceil(size / BLOCK) * BLOCK;
    // '0' and '\0' are regular files; everything else (dirs, links, PAX headers) is skipped.
    if ((typeFlag === '0' || typeFlag === '\0') && size > 0) {
      yield [prefix ? `${prefix}/${name}` : name, buf.subarray(offset, offset + size)];
    }
    offset += dataBlocks;
  }
}
