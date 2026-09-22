import { LightningElement, api } from 'lwc';
import { jsonPretty } from '../../../lib/format.js';

const OPTION_LABELS = { approve: 'Allow once', approve_session: 'Allow for this session', deny: 'Deny' };
const OPTION_STYLES = { approve: 'primary', approve_session: 'secondary', deny: 'danger' };

/**
 * confirmation.requested card. Deploy/commit/data/destructive confirmations render a details summary;
 * kind=command renders an APPROVAL CARD: "Why" (AI reason) + "What" (command name + pretty input).
 */
export default class ConfirmationCard extends LightningElement {
  static renderMode = 'light';
  @api item;
  @api pro = false;
  busy = false;
  answer = '';

  get title() {
    return this.item?.title;
  }
  get titleCls() {
    if (this.isQuestion) return 'mt-1.5 whitespace-normal break-words text-[14px] font-semibold leading-snug text-content-strong';
    return 'mt-1 truncate text-[13px] font-semibold text-content-strong';
  }
  get headCls() {
    return 'flex items-center gap-2';
  }
  get description() {
    return this.item?.description;
  }
  get resolved() {
    return !!this.item?.resolved;
  }
  /** Blast radius: who and what the change touches. Separate from "Why" and from "What". */
  get impact() {
    return this.item?.impact || '';
  }
  get hasImpact() {
    return !!this.impact;
  }
  get resolvedLabel() {
    return this.item?.resolvedLabel || this.item?.resolvedOptionId;
  }
  get resolvedVerb() {
    return this.isQuestion && this.item?.resolvedOptionId === 'custom' ? 'You answered' : 'You chose';
  }
  get answerDisabled() {
    return this.busy || !this.answer.trim();
  }
  /** Full-width choice rows: one click answers. First option is the agent's recommendation. */
  get questionChoices() {
    return (this.item?.details?.options || this.item?.options || []).map((o, i) => ({
      id: o.id,
      label: o.label,
      detail: o.detail || '',
      cls: `flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition disabled:opacity-50 ${
        i === 0 ? 'border-cyan-600/50 bg-surface hover:bg-cyan-500/10' : 'border-line bg-surface hover:border-cyan-600/40 hover:bg-cyan-500/5'
      }`,
      dotCls: `mt-1.5 h-2 w-2 shrink-0 rounded-full ${i === 0 ? 'bg-cyan-600' : 'border border-line-strong'}`,
    }));
  }
  get kind() {
    return this.item?.confirmationKind || this.item?.kind;
  }
  get isCommand() {
    return this.kind === 'command' || !!this.item?.command;
  }
  /** A plan awaiting sign-off: rendered as prose, because that is what the user is approving. */
  get isPlan() {
    return this.kind === 'plan';
  }
  get planMarkdown() {
    return this.item?.details?.markdown || '';
  }
  get planRevision() {
    const r = Number(this.item?.details?.revision || 0);
    return r > 1 ? `revision ${r}` : '';
  }
  /** A structured question from the agent; the user may pick an option or type an answer. */
  get isQuestion() {
    return this.kind === 'question';
  }
  get allowsFreeText() {
    return this.isQuestion && this.item?.details?.allowFreeText !== false;
  }
  /** Per-option explanation, shown under the buttons so a non-technical user can choose. */
  get questionOptions() {
    return (this.item?.details?.options || []).filter((o) => o?.detail).map((o) => ({ key: o.id, label: o.label, detail: o.detail }));
  }
  get hasOptionDetails() {
    return this.questionOptions.length > 0;
  }
  get unresolved() {
    return !this.resolved;
  }
  get isPlainCard() {
    return !this.isCommand && !this.isPlan && !this.isQuestion;
  }
  get kindCls() {
    const c = {
      deploy: 'bg-amber-500/20 text-amber-700',
      commit: 'bg-emerald-500/20 text-emerald-700',
      data_change: 'bg-sky-500/20 text-sky-700',
      destructive: 'bg-rose-500/20 text-rose-700',
      command: 'bg-brand-500/20 text-brand-700',
      plan: 'bg-violet-500/20 text-violet-700',
      question: 'bg-cyan-500/20 text-cyan-700',
      custom: 'bg-surface-sunken text-content-muted',
    };
    return `rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${c[this.kind] || c.custom}`;
  }
  get kindText() {
    if (this.isCommand) return 'approval';
    if (this.isPlan) return 'plan';
    if (this.isQuestion) return this.item?.details?.header || 'question';
    return String(this.kind || 'confirm').replace(/_/g, ' ');
  }
  get cardCls() {
    const base = 'rounded-2xl border p-3.5';
    if (this.resolved) return `${base} border-line bg-surface opacity-80`;
    const live = 'shadow-lg shadow-content-strong/10 border-l-4';
    if (this.isCommand) return `${base} ${live} border-brand-500/40 border-l-brand-500 bg-surface`;
    if (this.isPlan) return `${base} ${live} border-violet-500/40 border-l-violet-500 bg-surface`;
    if (this.isQuestion) return `${base} ${live} border-cyan-600/40 border-l-cyan-600 bg-surface`;
    return `${base} ${live} border-amber-500/40 border-l-amber-500 bg-surface`;
  }
  get options() {
    let opts = this.item?.options || [];
    if (!opts.length && this.isCommand) {
      opts = [{ id: 'approve', label: OPTION_LABELS.approve, style: 'primary' }];
      if (this.item?.command?.sessionAllowable) opts.push({ id: 'approve_session', label: OPTION_LABELS.approve_session, style: 'secondary' });
      opts.push({ id: 'deny', label: OPTION_LABELS.deny, style: 'danger' });
    }
    return opts.map((o) => {
      const style = o.style || OPTION_STYLES[o.id] || 'secondary';
      const cls =
        style === 'primary'
          ? 'bg-brand-500 text-white hover:bg-brand-500'
          : style === 'danger'
            ? 'bg-rose-600 text-white hover:bg-rose-500'
            : 'border border-line-strong text-content hover:bg-surface-sunken';
      return { ...o, label: o.label || OPTION_LABELS[o.id] || o.id, cls: `rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50 ${cls}` };
    });
  }

  // ---- command ("What") ------------------------------------------------------
  get command() {
    return this.item?.command || null;
  }
  get commandName() {
    return String(this.command?.name || '').replace(/_/g, ' ');
  }
  get commandInput() {
    return this.command?.input;
  }
  get isApex() {
    return /apex/i.test(this.command?.name || '') && !!this.apexCode;
  }
  get apexCode() {
    const i = this.commandInput;
    if (typeof i === 'string') return i;
    if (i && typeof i === 'object') return i.apex || i.body || i.code || i.anonymousBody || '';
    return '';
  }
  get isSoqlCommand() {
    return /soql|query/i.test(this.command?.name || '') && !!this.soqlText;
  }
  get soqlText() {
    const i = this.commandInput;
    return typeof i === 'string' ? i : i?.soql || i?.query || '';
  }
  /** Key/value table for record-style inputs (create/update/delete record, deploy options…). */
  get inputRows() {
    const i = this.commandInput;
    if (!i || typeof i !== 'object' || Array.isArray(i)) return [];
    const rows = [];
    const add = (label, v) =>
      rows.push({ key: label, label, value: v == null ? '' : typeof v === 'object' ? summarizeValue(v) : String(v), isObj: v && typeof v === 'object' });
    for (const [k, v] of Object.entries(i)) {
      if (k === 'apex' || k === 'body' || k === 'code' || k === 'soql') continue;
      if (k === 'fields' || k === 'record' || k === 'values') {
        if (v && typeof v === 'object' && !Array.isArray(v)) for (const [fk, fv] of Object.entries(v)) add(fk, fv);
        else add(k, v);
        continue;
      }
      add(k, v);
    }
    return rows.slice(0, 40);
  }
  get hasInputRows() {
    return this.inputRows.length > 0;
  }
  get inputIsScalar() {
    const i = this.commandInput;
    return i != null && typeof i !== 'object' && !this.isApex && !this.isSoqlCommand;
  }
  get inputScalar() {
    return String(this.commandInput ?? '');
  }
  get inputIsArray() {
    return Array.isArray(this.commandInput);
  }
  get inputArray() {
    return this.inputIsArray ? this.commandInput.slice(0, 40).map((v, i) => ({ key: i, text: typeof v === 'object' ? summarizeValue(v) : String(v) })) : [];
  }
  get sessionAllowable() {
    return !!this.command?.sessionAllowable;
  }
  get rawInput() {
    return jsonPretty(this.commandInput);
  }

  /** Visual summary of `details`: arrays of strings/objects, or key/value pairs. */
  get details() {
    const d = this.item?.details;
    if (d == null) return [];
    const rows = [];
    const push = (label, value) => rows.push({ key: rows.length, label, value: typeof value === 'object' ? summarizeValue(value) : String(value) });
    if (Array.isArray(d))
      d.slice(0, 20).forEach((v, i) =>
        push(
          typeof v === 'object' && v ? v.type || v.metadataType || v.action || `#${i + 1}` : `#${i + 1}`,
          typeof v === 'object' && v ? v.fullName || v.name || v.path || summarizeValue(v) : v,
        ),
      );
    else if (typeof d === 'object')
      Object.entries(d)
        .slice(0, 20)
        .forEach(([k, v]) => push(k, v));
    else push('details', d);
    return rows;
  }
  get hasDetails() {
    return this.details.length > 0;
  }
  get hasRawDetails() {
    return this.item?.details != null;
  }
  get rawDetails() {
    return jsonPretty(this.item?.details);
  }

  onAnswerInput(e) {
    this.answer = e.target.value;
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;
  }
  onAnswerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!this.answerDisabled) this.onPick({ currentTarget: { dataset: { id: 'custom' } } });
    }
  }
  async onPick(e) {
    if (this.resolved || this.busy) return;
    const optionId = e.currentTarget.dataset.id;
    // A picked option answers on its own; typed text only travels with the "Send answer" button.
    const answerText = optionId === 'custom' ? this.answer.trim() : undefined;
    if (optionId === 'custom' && !answerText) return;
    this.busy = true;
    this.dispatchEvent(new CustomEvent('confirm', { detail: { confirmationId: this.item.confirmationId, optionId, answerText } }));
    setTimeout(() => {
      this.busy = false;
    }, 1500);
  }
}
function summarizeValue(v) {
  if (Array.isArray(v))
    return v.length <= 6
      ? v.map((x) => (typeof x === 'object' && x ? x.fullName || x.name || x.path || JSON.stringify(x) : String(x))).join(', ')
      : `${v.length} items`;
  if (v && typeof v === 'object')
    return Object.entries(v)
      .slice(0, 6)
      .map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`)
      .join(' · ');
  return String(v);
}
