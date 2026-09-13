import { LightningElement, api } from 'lwc';
import { safeJson, fmtTime, truncate } from '../../../lib/format.js';
import { IMPACT_META } from '../../../lib/constants.js';

/**
 * confirmation.requested card. Deploy/commit/data/destructive confirmations show description + details;
 * `kind: 'command'` renders the APPROVAL CARD (Why = AI reason, What = command + pretty input).
 * Emits 'choose' { confirmationId, optionId } (bubbles).
 */
export default class ConfirmationCard extends LightningElement {
  static renderMode = 'light';
  @api confirmation;
  @api resolved = false;
  @api optionId;
  @api busy = false;
  @api readonly = false;
  get c() {
    return this.confirmation || {};
  }
  get time() {
    return fmtTime(this.c.at);
  }
  get isCommand() {
    return this.c.kind === 'command' || !!this.c.command;
  }
  /** Blast radius: who and what the change touches. Separate from "Why" and from "What". */
  get impact() {
    return this.c.impact || '';
  }
  get hasImpact() {
    return !!this.impact;
  }
  get kindLabel() {
    return this.isCommand ? 'Approval' : undefined;
  }
  get kindColor() {
    return { deploy: 'amber', commit: 'brand', data_change: 'rose', destructive: 'rose', command: 'violet', custom: 'sky' }[this.c.kind] || 'slate';
  }
  get icon() {
    return this.isCommand ? 'bolt' : 'shield';
  }
  get iconCls() {
    return `h-4 w-4 ${this.isCommand ? 'text-violet-700' : 'text-amber-700'}`;
  }
  get cls() {
    return `rounded-xl border p-4 ${this.resolved ? 'border-line bg-surface' : this.isCommand ? 'border-violet-500/40 bg-violet-500/5 ring-1 ring-violet-500/20' : 'border-amber-500/40 bg-amber-500/5 ring-1 ring-amber-500/20'}`;
  }
  get options() {
    const icons = { approve: 'check', approve_session: 'clock', deny: 'ban', deploy: 'rocket', commit: 'git', cancel: 'close' };
    const labels = { approve: 'Allow once', approve_session: 'Allow for this session', deny: 'Deny' };
    return (this.c.options || []).map((o) => ({
      ...o,
      label: o.label || labels[o.id] || o.id,
      icon: icons[o.id] || null,
      cls: `btn-${o.style === 'primary' ? 'primary' : o.style === 'danger' ? 'danger' : 'secondary'} btn-sm`,
    }));
  }
  get chosenLabel() {
    return this.options.find((o) => o.id === this.optionId)?.label || this.optionId || '';
  }
  // command approval card
  get command() {
    return this.c.command || this.c.details?.command || {};
  }
  get commandName() {
    const n = this.command.name || '';
    return IMPACT_META[n] ? `${IMPACT_META[n].label} (${n})` : n;
  }
  get commandInput() {
    return this.command.input;
  }
  get sessionAllowable() {
    return !!this.command.sessionAllowable;
  }
  get isApex() {
    return this.command.name === 'execute_anonymous_apex';
  }
  get apexCode() {
    const i = this.commandInput;
    return typeof i === 'string' ? i : i?.apex || i?.code || i?.body || safeJson(i);
  }
  get inputIsObject() {
    return this.commandInput !== null && typeof this.commandInput === 'object';
  }
  get inputText() {
    return typeof this.commandInput === 'string' ? this.commandInput : safeJson(this.commandInput);
  }
  /** Flat objects (records, query inputs) render as a key/value table. */
  get kvRows() {
    const i = this.commandInput;
    if (!i || typeof i !== 'object' || Array.isArray(i)) return [];
    const rows = [];
    const flat = (obj, prefix) =>
      Object.entries(obj).forEach(([k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 12 && rows.length < 40) flat(v, key);
        else rows.push({ k: key, v: v === null || v === undefined ? '—' : typeof v === 'object' ? truncate(safeJson(v, 0), 200) : String(v) });
      });
    flat(i, '');
    return rows.slice(0, 40);
  }
  get hasKv() {
    return this.kvRows.length > 0 && this.kvRows.length <= 40;
  }
  // generic details
  get details() {
    return this.c.details;
  }
  get hasDetails() {
    return this.c.details !== null && this.c.details !== undefined;
  }
  get detailsIsObject() {
    return typeof this.c.details === 'object';
  }
  get detailsText() {
    return typeof this.c.details === 'string' ? this.c.details : safeJson(this.c.details);
  }
  get detailsSummary() {
    const d = this.c.details;
    if (!d || typeof d !== 'object') return [];
    const out = [];
    const push = (label, val) => {
      if (Array.isArray(val)) out.push({ id: label, label, value: `${val.length} item${val.length === 1 ? '' : 's'}` });
      else if (val !== null && typeof val !== 'object') out.push({ id: label, label, value: String(val) });
    };
    Object.entries(d).forEach(([k, v]) => push(k, v));
    return out.slice(0, 8);
  }
  get hasSummary() {
    return this.detailsSummary.length > 0;
  }
  get showButtons() {
    return !this.resolved && !this.readonly;
  }
  choose(e) {
    this.dispatchEvent(
      new CustomEvent('choose', { bubbles: true, detail: { confirmationId: this.c.confirmationId || this.c.id, optionId: e.currentTarget.dataset.id } }),
    );
  }
}
