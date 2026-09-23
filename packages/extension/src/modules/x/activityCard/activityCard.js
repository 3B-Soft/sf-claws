import { LightningElement, api } from 'lwc';
import { truncate } from '../../../lib/format.js';

/**
 * One turn's worth of agent activity — thinking, tool calls, sub-agent chatter, lifecycle events —
 * stacked into a single card so the thread reads as a conversation. Latest thought is visible;
 * everything else is behind "Reasoning" and "Log".
 */
export default class ActivityCard extends LightningElement {
  static renderMode = 'light';
  @api group;
  @api pro = false;
  @api running = false;
  reasoningOpen = false;
  logOpen = false;

  get items() {
    return this.group?.items || [];
  }
  get reasoning() {
    return this.items.filter((i) => i.kind === 'thinking' && i.text?.trim());
  }
  get log() {
    // ponytail: raw lifecycle events (model.started…) are noise for everyone but Pro users.
    return this.items.filter((i) => i.kind !== 'thinking' && (this.pro || i.kind !== 'unknown'));
  }
  get hasReasoning() {
    return this.reasoning.length > 0;
  }
  get hasLog() {
    return this.log.length > 0;
  }
  get reasoningCount() {
    return this.reasoning.length;
  }
  get logCount() {
    return this.log.length;
  }
  get toolCalls() {
    return this.items.filter((i) => i.kind === 'tool');
  }
  get failed() {
    return this.toolCalls.some((t) => t.done && t.ok === false) || this.items.some((i) => i.kind === 'agent' && i.phase !== 'spawned' && !i.ok);
  }
  get heading() {
    const n = this.toolCalls.length;
    return this.running ? 'Working on it' : n ? `Looked into it · ${n} call${n === 1 ? '' : 's'}` : 'Thought about it';
  }
  get chipText() {
    return this.running ? 'In progress' : this.failed ? 'Had trouble' : 'Done';
  }
  get chipCls() {
    const tone = this.running ? 'bg-brand-500/15 text-brand-700' : this.failed ? 'bg-rose-500/15 text-rose-700' : 'bg-emerald-500/15 text-emerald-700';
    return `inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${tone}`;
  }
  get cardCls() {
    return `rounded-2xl border bg-surface ${this.running ? 'border-brand-500/40' : 'border-line'}`;
  }
  get latestThought() {
    const last = [...this.items].reverse().find((i) => (i.kind === 'thinking' || i.kind === 'assistant') && i.text?.trim());
    return last ? truncate(last.text.replace(/\s+/g, ' ').trim(), 240) : '';
  }
  get logSummary() {
    const names = [...new Set(this.toolCalls.map((t) => String(t.tool || '').replace(/_/g, ' ')))];
    return names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
  }
  get reasoningGlyph() {
    return this.reasoningOpen ? '▼' : '▶';
  }
  get logGlyph() {
    return this.logOpen ? '▼' : '▶';
  }
  onToggleReasoning() {
    this.reasoningOpen = !this.reasoningOpen;
  }
  onToggleLog() {
    this.logOpen = !this.logOpen;
  }
  onOpenChanges() {
    this.dispatchEvent(new CustomEvent('openchanges'));
  }
}
