import { LightningElement, api } from 'lwc';
import { toolMeta } from '../../../lib/transcript.js';
import { fmtDuration, jsonPretty, roleClass, roleLabel, fileName, truncate } from '../../../lib/format.js';
import { flattenRecord } from '../../../lib/soql.js';

export default class ToolStep extends LightningElement {
  static renderMode = 'light';
  @api item;
  @api pro = false;
  open = false;

  get meta() {
    return toolMeta(this.item?.tool);
  }
  get glyph() {
    return this.meta.glyph;
  }
  get label() {
    return this.item?.label || this.item?.tool || 'step';
  }
  get resultLabel() {
    return this.item?.resultLabel && this.item.resultLabel !== this.item.label ? this.item.resultLabel : '';
  }
  get done() {
    return !!this.item?.done;
  }
  get ok() {
    return this.item?.ok;
  }
  get failed() {
    return this.done && this.ok === false;
  }
  get duration() {
    return this.done ? fmtDuration(this.item?.durationMs) : '';
  }
  get role() {
    return this.item?.role;
  }
  get roleText() {
    return roleLabel(this.role);
  }
  get showRole() {
    return this.role && this.role !== 'orchestrator';
  }
  get roleCls() {
    return `inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${roleClass(this.role)}`;
  }
  get glyphCls() {
    const tones = {
      sky: 'bg-sky-500/20 text-sky-700',
      violet: 'bg-violet-500/20 text-violet-700',
      brand: 'bg-brand-500/20 text-brand-700',
      amber: 'bg-amber-500/20 text-amber-700',
      emerald: 'bg-emerald-500/20 text-emerald-700',
      rose: 'bg-rose-500/20 text-rose-700',
      teal: 'bg-teal-500/20 text-teal-700',
      slate: 'bg-surface-sunken text-content-muted',
    };
    return `flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold ${tones[this.meta.tone] || tones.slate}`;
  }
  get cardCls() {
    return `rounded-lg border ${this.failed ? 'border-rose-500/40 bg-rose-500/5' : this.open ? 'border-line bg-surface' : 'border-transparent bg-surface-sunken hover:border-line'}`;
  }
  get toggle() {
    return this.open ? '▾' : '▸';
  }
  get toolName() {
    return this.item?.tool;
  }

  // Renderers
  get output() {
    return this.item?.output;
  }
  get tool() {
    return String(this.item?.tool || '').toLowerCase();
  }
  get isSoql() {
    return this.tool.includes('soql') || this.tool === 'query' || this.tool.includes('run_query');
  }
  get isDescribe() {
    return this.tool.includes('describe');
  }
  get isMetadata() {
    return this.tool.includes('metadata');
  }
  get isWrite() {
    return this.tool.includes('write_workspace') || this.tool.includes('write_file');
  }
  get hasOutput() {
    return this.done && this.output !== undefined && this.output !== null;
  }

  get soqlColumns() {
    const o = this.output || {};
    return Array.isArray(o.columns) && o.columns.length ? o.columns : Object.keys(flattenRecord((o.records || [])[0] || {}));
  }
  get soqlRows() {
    const o = this.output || {};
    return (o.records || []).map(flattenRecord);
  }
  get soqlCount() {
    const o = this.output || {};
    return `${o.totalSize ?? o.records?.length ?? 0} record(s)`;
  }
  get soqlText() {
    const i = this.item?.input;
    return i?.soql || i?.query || '';
  }
  get renderSoqlTable() {
    return this.isSoql && this.hasOutput && this.ok !== false && Array.isArray(this.output?.records);
  }

  get describeFields() {
    const o = this.output || {};
    return (o.fields || []).slice(0, 200).map((f) => ({
      name: f.name,
      label: f.label || f.name,
      type: f.type || '',
      extra: f.referenceTo?.length ? `→ ${f.referenceTo.join(', ')}` : f.length ? `len ${f.length}` : '',
    }));
  }
  get describeTitle() {
    const o = this.output || {};
    return `${o.label || o.name || 'Object'} · ${(o.fields || []).length} fields`;
  }
  get renderDescribe() {
    return this.isDescribe && this.hasOutput && Array.isArray(this.output?.fields);
  }

  get metadataXml() {
    const o = this.output;
    if (typeof o === 'string') return o;
    return o?.xml || o?.source || '';
  }
  get metadataList() {
    const o = this.output;
    const list = Array.isArray(o) ? o : Array.isArray(o?.items) ? o.items : Array.isArray(o?.records) ? o.records : Array.isArray(o?.result) ? o.result : [];
    return list.slice(0, 100).map((m, i) => ({
      key: i,
      name: typeof m === 'string' ? m : m.fullName || m.name || JSON.stringify(m),
      type: typeof m === 'string' ? '' : m.type || '',
    }));
  }
  get renderMetadataList() {
    return this.isMetadata && this.hasOutput && this.metadataList.length > 0 && !this.metadataXml;
  }
  get renderMetadataXml() {
    return this.isMetadata && this.hasOutput && !!this.metadataXml;
  }
  get metaCount() {
    return `${this.metadataList.length} item(s)`;
  }

  get writePath() {
    const i = this.item?.input || {};
    return i.path || this.output?.path || '';
  }
  get writeName() {
    return fileName(this.writePath);
  }
  get renderWrite() {
    return this.isWrite && !!this.writePath;
  }

  get renderGeneric() {
    return this.hasOutput && !this.renderSoqlTable && !this.renderDescribe && !this.renderMetadataList && !this.renderMetadataXml && !this.renderWrite;
  }
  get genericText() {
    const o = this.output;
    if (typeof o === 'string') return truncate(o, 600);
    if (o && typeof o === 'object') {
      if (typeof o.message === 'string') return truncate(o.message, 400);
      if (typeof o.summary === 'string') return truncate(o.summary, 400);
      if (typeof o.error === 'string') return truncate(o.error, 400);
      return truncate(jsonPretty(o), 400);
    }
    return String(o);
  }
  get inputJson() {
    return this.item?.input;
  }
  get hasInput() {
    return this.item?.input !== undefined;
  }
  get outputJson() {
    return this.output;
  }

  onToggle() {
    this.open = !this.open;
  }
  onOpenChanges(e) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('openchanges'));
  }
}
