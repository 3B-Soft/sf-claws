/**
 * Prompt-cache break detection.
 *
 * Providers cache on an exact prefix match, so one byte changing in a section above the boundary
 * re-bills the whole prefix — silently, as a higher bill and a lower `cache_read_input_tokens`.
 * Nobody notices in the panel; the usage page shows it a month later. So every call records a
 * hash per prompt section plus one for the tool array, and when the cached-token count drops
 * against the previous call of the same agent, the probe names the section that changed. When no
 * section changed, the conversation itself was rewritten (compaction, eviction, a fallback model),
 * which is also worth knowing.
 */
import { createHash } from 'node:crypto';
import type { LlmTool, LlmUsage } from '../ai/types.js';

export interface PromptSection {
  name: string;
  text: string;
}

interface Observation {
  sections: Record<string, string>;
  toolsHash: string;
  cachedInputTokens: number;
}

export interface CacheBreak {
  /** Sections whose hash changed since the previous call of this agent. */
  changed: string[];
  toolsChanged: boolean;
  previousCached: number;
  cached: number;
}

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export function hashTools(tools: LlmTool[]): string {
  return hashText(JSON.stringify(tools));
}

export class PromptCacheProbe {
  private last = new Map<string, Observation>();

  /**
   * Record one call. Returns a `CacheBreak` when the cache read shrank against the previous call
   * for the same key, null otherwise. Keys are per agent: sub-agents have unique ids, so their
   * history starts fresh; the orchestrator's key persists across turns, which is where page
   * context, plan state and admin edits show up as breaks.
   */
  observe(key: string, sections: PromptSection[], tools: LlmTool[], usage: LlmUsage): CacheBreak | null {
    const now: Observation = {
      sections: Object.fromEntries(sections.map((s) => [s.name, hashText(s.text)])),
      toolsHash: hashTools(tools),
      cachedInputTokens: usage.cachedInputTokens,
    };
    const prev = this.last.get(key);
    this.last.set(key, now);
    if (!prev || prev.cachedInputTokens === 0 || now.cachedInputTokens >= prev.cachedInputTokens) return null;
    const names = new Set([...Object.keys(prev.sections), ...Object.keys(now.sections)]);
    const changed = [...names].filter((n) => prev.sections[n] !== now.sections[n]);
    return { changed, toolsChanged: prev.toolsHash !== now.toolsHash, previousCached: prev.cachedInputTokens, cached: now.cachedInputTokens };
  }

  forget(keyPrefix: string): void {
    for (const k of [...this.last.keys()]) if (k.startsWith(keyPrefix)) this.last.delete(k);
  }
}

/** One line for the log: which section broke the cache, or that the conversation did. */
export function describeCacheBreak(b: CacheBreak): string {
  const what = b.changed.length
    ? `prompt section(s) changed: ${b.changed.join(', ')}`
    : b.toolsChanged
      ? 'tool definitions changed'
      : 'no prompt section changed — the conversation prefix was rewritten (compaction, eviction or a model switch)';
  return `prompt cache read dropped from ${b.previousCached} to ${b.cached} tokens; ${what}`;
}
