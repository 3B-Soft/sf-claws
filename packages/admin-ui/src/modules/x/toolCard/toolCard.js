import { LightningElement, api } from 'lwc';
import { toolIcon } from '../../../lib/constants.js';
import { fmtDuration, truncate, safeJson } from '../../../lib/format.js';

/** Compact tool step card with expandable, tool-specific result renderers. Emits 'openfile' {path} (bubbles). */
export default class ToolCard extends LightningElement {
  static renderMode = 'light';
  @api block;
  @api proMode = false;
  open = false;
  get b() {
    return this.block || {};
  }
  get icon() {
    return toolIcon(this.b.tool);
  }
  get pending() {
    return !!this.b.pending;
  }
  get failed() {
    return this.b.ok === false;
  }
  get label() {
    return this.b.label || this.b.tool;
  }
  get resultLabel() {
    return this.b.resultLabel && this.b.resultLabel !== this.b.label ? this.b.resultLabel : '';
  }
  get duration() {
    return this.b.durationMs !== null && this.b.durationMs !== undefined ? fmtDuration(this.b.durationMs) : '';
  }
  get chevron() {
    return this.open ? 'chevronDown' : 'chevronRight';
  }
  get cls() {
    return `rounded-lg border ${this.failed ? 'border-rose-500/30 bg-rose-500/5' : 'border-line bg-surface'}`;
  }
  get statusIcon() {
    return this.pending ? 'spinner' : this.failed ? 'error' : 'check';
  }
  get statusCls() {
    return `h-3.5 w-3.5 ${this.pending ? 'text-brand-600' : this.failed ? 'text-rose-700' : 'text-emerald-700'}`;
  }
  get toolName() {
    return this.b.tool;
  }
  toggle() {
    this.open = !this.open;
  }

  // --- renderers ----------------------------------------------------------
  get out() {
    return this.b.output;
  }
  get kind() {
    if (this.failed || this.pending) return 'generic';
    const t = String(this.b.tool || '');
    const o = this.out;
    if ((t === 'soql_query' || t === 'tooling_query' || /query/i.test(t)) && o && Array.isArray(o.records)) return 'soql';
    if (/describe_sobject/i.test(t) && o && Array.isArray(o.fields)) return 'describe';
    if (/list_metadata/i.test(t) && Array.isArray(o?.items || o)) return 'list';
    if (/read_metadata/i.test(t) && o && (o.xml || o.source)) return 'read';
    if (/write_workspace_file/i.test(t)) return 'write';
    return 'generic';
  }
  get isSoql() {
    return this.kind === 'soql';
  }
  get isDescribe() {
    return this.kind === 'describe';
  }
  get isList() {
    return this.kind === 'list';
  }
  get isRead() {
    return this.kind === 'read';
  }
  get isWrite() {
    return this.kind === 'write';
  }
  get isGeneric() {
    return this.kind === 'generic';
  }

  get soqlColumns() {
    const o = this.out;
    const cols = Array.isArray(o.columns) && o.columns.length ? o.columns : Object.keys(o.records[0] || {}).filter((k) => k !== 'attributes');
    return cols.map((c) => ({ key: c, label: c }));
  }
  get soqlRows() {
    return (this.out.records || []).slice(0, 100).map((r, i) => ({
      id: i,
      cells: this.soqlColumns.map((c) => {
        const v = c.key.split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), r);
        return { key: c.key, text: v === null || v === undefined ? '' : typeof v === 'object' ? truncate(safeJson(v, 0), 60) : String(v) };
      }),
    }));
  }
  get soqlMeta() {
    const o = this.out;
    return `${o.totalSize ?? o.records.length} record${(o.totalSize ?? o.records.length) === 1 ? '' : 's'}${o.records.length > 100 ? ' (showing 100)' : ''}`;
  }
  get soql() {
    return this.b.input?.soql || '';
  }
  get describeFields() {
    return (this.out.fields || [])
      .slice(0, 200)
      .map((f) => ({ id: f.name, name: f.name, label: f.label, type: f.type, req: f.nillable === false && !f.defaultedOnCreate ? 'required' : '' }));
  }
  get describeMeta() {
    return `${this.out.label || this.out.name || ''} · ${(this.out.fields || []).length} fields`;
  }
  get listItems() {
    const arr = Array.isArray(this.out) ? this.out : this.out.items;
    return arr.slice(0, 300).map((it, i) => ({
      id: i,
      name: typeof it === 'string' ? it : it.fullName || it.name || safeJson(it, 0),
      type: typeof it === 'object' ? it.type || '' : '',
    }));
  }
  get listMeta() {
    const arr = Array.isArray(this.out) ? this.out : this.out.items;
    return `${arr.length} component${arr.length === 1 ? '' : 's'}`;
  }
  get readXml() {
    return this.out.xml || (typeof this.out.source === 'string' ? this.out.source : safeJson(this.out.source));
  }
  get readMeta() {
    const x = this.readXml || '';
    return `${x.split('\n').length} lines`;
  }
  get writePath() {
    return this.b.input?.path || this.out?.path || '';
  }
  get writeAction() {
    return this.out?.action || (this.b.input?.content ? 'modified' : 'written');
  }
  get input() {
    return this.b.input;
  }
  get hasInput() {
    return this.b.input !== undefined && this.b.input !== null;
  }
  get hasOutput() {
    return this.out !== undefined && this.out !== null;
  }
  get outputIsObject() {
    return typeof this.out === 'object';
  }
  get outputText() {
    return typeof this.out === 'string' ? this.out : safeJson(this.out);
  }
  get genericSummary() {
    if (this.failed) return this.out?.text || this.out?.error || this.out?.message || this.outputText;
    return this.resultLabel || this.out?.text || (typeof this.out === 'string' ? truncate(this.out, 200) : '');
  }
  openFile(e) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('openfile', { bubbles: true, detail: { path: this.writePath } }));
  }
}
