import { LightningElement, api } from 'lwc';
import { parseMetadata } from '../../../lib/metadataParse.js';

const TONE = {
  sky: 'border-sky-500/40 bg-sky-500/10 text-sky-700',
  amber: 'border-amber-500/40 bg-amber-500/10 text-amber-700',
  violet: 'border-violet-500/40 bg-violet-500/10 text-violet-700',
  emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
  rose: 'border-rose-500/40 bg-rose-500/10 text-rose-700',
  brand: 'border-brand-500/40 bg-brand-500/10 text-brand-700',
  fuchsia: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700',
  slate: 'border-line-strong bg-surface-sunken text-content',
};

export default class MetadataVisual extends LightningElement {
  static renderMode = 'light';
  @api xml = '';
  @api type = null;
  @api fullName = '';
  expandedFlow = new Set();

  get parsed() {
    try {
      return this.xml ? parseMetadata(this.type, this.xml) : null;
    } catch (e) {
      return { type: 'error', error: e.message };
    }
  }
  get isError() {
    return this.parsed?.type === 'error';
  }
  get errorText() {
    return this.parsed?.error;
  }
  get isFlow() {
    return this.parsed?.type === 'Flow';
  }
  get isObject() {
    return this.parsed?.type === 'CustomObject' || this.parsed?.type === 'CustomField';
  }
  get isLayout() {
    return this.parsed?.type === 'Layout';
  }
  get isFlexi() {
    return this.parsed?.type === 'FlexiPage';
  }
  get isGeneric() {
    return this.parsed && !this.isError && !this.isFlow && !this.isObject && !this.isLayout && !this.isFlexi;
  }
  get p() {
    return this.parsed || {};
  }

  // Flow
  get flowHeader() {
    const p = this.p;
    return [p.processType, p.status, p.apiVersion && `API ${p.apiVersion}`].filter(Boolean).join(' · ');
  }
  get flowCounts() {
    return (this.p.counts || []).map((c) => ({ ...c, key: c.kind }));
  }
  get flowElements() {
    return (this.p.elements || []).map((e) => ({
      ...e,
      key: `${e.index}-${e.name}`,
      badgeCls: `inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${TONE[e.tone] || TONE.slate}`,
      hasRules: e.rules?.length > 0,
      hasAssign: e.assignments?.length > 0,
      hasFields: e.fields?.length > 0,
      hasFilters: e.filters?.length > 0,
      hasInputs: e.inputAssignments?.length > 0,
      hasConn: e.connectorText?.length > 0,
      rulesView: (e.rules || []).map((r, i) => ({ key: i, label: r.label || r.name, cond: r.conditions.join(' AND ') })),
      assignView: (e.assignments || []).map((a, i) => ({ key: i, text: a })),
      fieldsView: (e.fields || []).map((a, i) => ({ key: i, text: a })),
      filtersView: (e.filters || []).map((a, i) => ({ key: i, text: a })),
      inputsView: (e.inputAssignments || []).map((a, i) => ({ key: i, text: a })),
      connView: (e.connectorText || []).map((a, i) => ({ key: i, text: a })),
      isStart: e.kind === 'Start',
    }));
  }
  get flowVariables() {
    return (this.p.variables || []).map((v) => ({
      ...v,
      key: v.name,
      text: `${v.name}: ${v.dataType}${v.isCollection ? '[]' : ''}${v.isInput ? ' (input)' : ''}${v.isOutput ? ' (output)' : ''}`,
    }));
  }
  get hasVariables() {
    return this.flowVariables.length > 0;
  }
  get flowLabel() {
    return this.p.label || this.fullName;
  }
  get flowDescription() {
    return this.p.description;
  }

  // Object
  get objLabel() {
    return this.p.label || this.fullName;
  }
  get objMeta() {
    return [this.p.sharingModel && `Sharing: ${this.p.sharingModel}`, this.p.nameFieldType && `Name: ${this.p.nameFieldType}`].filter(Boolean).join(' · ');
  }
  get fields() {
    return (this.p.fields || []).map((f) => ({
      ...f,
      key: f.fullName,
      picklistText: f.picklist?.slice(0, 8).join(', ') + (f.picklist?.length > 8 ? '…' : ''),
      hasPicklist: f.picklist?.length > 0,
    }));
  }
  get fieldCount() {
    return this.fields.length;
  }
  get hasFields() {
    return this.fieldCount > 0;
  }
  get rules() {
    return (this.p.validationRules || []).map((r) => ({ ...r, key: r.fullName }));
  }
  get hasRules() {
    return this.rules.length > 0;
  }
  get recordTypes() {
    return (this.p.recordTypes || []).map((r) => ({ ...r, key: r.fullName }));
  }
  get hasRecordTypes() {
    return this.recordTypes.length > 0;
  }

  // Layout
  get sections() {
    return (this.p.sections || []).map((s) => ({
      ...s,
      key: s.index,
      columns: s.columns.map((c) => ({ ...c, key: c.index, items: c.items.map((it, i) => ({ ...it, key: i })) })),
    }));
  }
  get relatedLists() {
    return (this.p.relatedLists || []).map((r, i) => ({ ...r, key: i, fieldsText: r.fields.join(', ') }));
  }
  get hasRelated() {
    return this.relatedLists.length > 0;
  }
  get quickActions() {
    return (this.p.quickActions || []).map((q, i) => ({ key: i, name: q }));
  }
  get hasQuick() {
    return this.quickActions.length > 0;
  }

  // FlexiPage
  get flexiHeader() {
    return [this.p.type, this.p.sobjectType, this.p.template && `template ${this.p.template}`].filter(Boolean).join(' · ');
  }
  get flexiLabel() {
    return this.p.label || this.fullName;
  }
  get regions() {
    return (this.p.regions || []).map((r) => ({
      ...r,
      key: r.index,
      title: `${r.name}${r.type ? ` (${r.type})` : ''}`,
      count: r.components.length,
      components: r.components.map((c, i) => ({
        ...c,
        key: i,
        propsText: c.properties
          .slice(0, 4)
          .map((p) => `${p.name}=${p.value}`)
          .join(' · '),
        hasProps: c.properties.length > 0,
      })),
    }));
  }

  // Generic
  get props() {
    return (this.p.props || []).map((r, i) => ({ ...r, key: i }));
  }
  get genericType() {
    return this.p.type;
  }
}
