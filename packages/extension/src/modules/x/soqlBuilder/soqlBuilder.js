import { LightningElement } from 'lwc';
import { appStore, api as http } from '../../../lib/state.js';
import { asList } from '../../../lib/api.js';
import { OPERATORS, buildSoql, flattenRecord } from '../../../lib/soql.js';

// Module-level cache so switching tabs doesn't refetch describes.
const cache = { orgId: null, global: null, describes: new Map() };
let lastState = null;

export default class SoqlBuilder extends LightningElement {
  static renderMode = 'light';
  state = appStore.get();
  objects = [];
  objectFilter = '';
  sobject = '';
  fields = []; // describe fields
  selected = []; // selected field names
  fieldFilter = '';
  filters = []; // {id, field, op, value}
  orderBy = '';
  orderDir = 'DESC';
  limit = 50;
  customSoql = '';
  useCustom = false;
  loadingObjects = false;
  loadingFields = false;
  running = false;
  error = '';
  result = null;
  tooling = false;
  showFields = true;
  _unsub = null;
  _n = 0;

  connectedCallback() {
    this._unsub = appStore.subscribe((s) => {
      const changed = this.state.org?.id !== s.org?.id;
      this.state = s;
      if (changed) this.reset();
    });
    if (lastState && lastState.orgId === this.state.org?.id) Object.assign(this, lastState.data);
    this.loadObjects();
  }
  disconnectedCallback() {
    this._unsub?.();
    lastState = {
      orgId: this.state.org?.id,
      data: {
        sobject: this.sobject,
        fields: this.fields,
        selected: this.selected,
        filters: this.filters,
        orderBy: this.orderBy,
        orderDir: this.orderDir,
        limit: this.limit,
        customSoql: this.customSoql,
        useCustom: this.useCustom,
        result: this.result,
        objects: this.objects,
      },
    };
  }
  renderedCallback() {
    const ta = this.querySelector('textarea[data-soql]');
    if (ta && ta.value !== this.customSoql) ta.value = this.customSoql;
  }
  reset() {
    this.objects = [];
    this.sobject = '';
    this.fields = [];
    this.selected = [];
    this.filters = [];
    this.result = null;
    this.loadObjects();
  }

  get orgId() {
    return this.state.org?.id;
  }
  get instanceUrl() {
    return this.state.org?.instanceUrl || '';
  }
  get isPro() {
    return this.state.uiMode === 'pro';
  }

  async loadObjects() {
    if (!this.orgId) return;
    if (cache.orgId === this.orgId && cache.global) {
      this.objects = cache.global;
      return;
    }
    this.loadingObjects = true;
    this.error = '';
    try {
      const res = await http.describeGlobal(this.orgId);
      const list = asList(res, 'sobjects')
        .map((o) => (typeof o === 'string' ? { name: o, label: o, queryable: true } : o))
        .filter((o) => o.queryable !== false)
        .map((o) => ({ name: o.name, label: o.label || o.name, custom: !!o.custom }))
        .sort((a, b) => a.label.localeCompare(b.label));
      cache.orgId = this.orgId;
      cache.global = list;
      cache.describes.clear();
      this.objects = list;
      // Pre-select object from page context
      const ctxObj = this.state.context?.objectApiName;
      if (!this.sobject && ctxObj && list.some((o) => o.name === ctxObj)) this.pickObject(ctxObj);
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loadingObjects = false;
    }
  }

  async pickObject(name) {
    this.sobject = name;
    this.selected = [];
    this.filters = [];
    this.orderBy = '';
    this.result = null;
    this.fields = [];
    this.useCustom = false;
    if (!name) return;
    const n = ++this._n;
    if (cache.describes.has(name)) {
      this.applyDescribe(cache.describes.get(name));
      return;
    }
    this.loadingFields = true;
    this.error = '';
    try {
      const d = await http.describeSobject(this.orgId, name);
      if (n !== this._n) return;
      const fields = asList(d, 'fields').map((f) => ({
        name: f.name,
        label: f.label || f.name,
        type: f.type || 'string',
        custom: !!f.custom,
        referenceTo: f.referenceTo || [],
      }));
      cache.describes.set(name, fields);
      this.applyDescribe(fields);
    } catch (e) {
      if (n === this._n) this.error = e.message;
    } finally {
      if (n === this._n) this.loadingFields = false;
    }
  }
  applyDescribe(fields) {
    this.fields = fields;
    const names = new Set(fields.map((f) => f.name));
    this.selected = ['Id', 'Name', 'CreatedDate'].filter((f) => names.has(f));
    if (this.selected.length < 2) this.selected = fields.slice(0, 5).map((f) => f.name);
    this.orderBy = names.has('CreatedDate') ? 'CreatedDate' : '';
  }

  get fieldTypes() {
    const m = {};
    for (const f of this.fields) m[f.name] = f.type;
    return m;
  }
  get soql() {
    return this.useCustom
      ? this.customSoql
      : buildSoql({
          sobject: this.sobject,
          fields: this.selected,
          filters: this.filters,
          fieldTypes: this.fieldTypes,
          orderBy: this.orderBy,
          orderDir: this.orderDir,
          limit: this.limit,
        });
  }
  get hasSoql() {
    return !!this.soql.trim();
  }
  get runDisabled() {
    return this.running || !this.hasSoql;
  }
  get runLabel() {
    return this.running ? 'Running…' : 'Run query';
  }
  get filteredObjects() {
    const q = this.objectFilter.trim().toLowerCase();
    return (q ? this.objects.filter((o) => o.name.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)) : this.objects)
      .slice(0, 300)
      .map((o) => ({ ...o, selected: o.name === this.sobject }));
  }
  get hasObjects() {
    return this.objects.length > 0;
  }
  get objectCount() {
    return this.objects.length;
  }
  get selectedObject() {
    return this.objects.find((o) => o.name === this.sobject);
  }
  get selectedObjectLabel() {
    return this.selectedObject?.label || this.sobject;
  }
  get fieldRows() {
    const q = this.fieldFilter.trim().toLowerCase();
    const sel = new Set(this.selected);
    return this.fields
      .filter((f) => !q || f.name.toLowerCase().includes(q) || f.label.toLowerCase().includes(q))
      .slice(0, 400)
      .map((f) => ({
        ...f,
        checked: sel.has(f.name),
        cls: `flex items-center gap-2 rounded-md px-2 py-1 text-[11px] ${sel.has(f.name) ? 'bg-brand-500/10' : 'hover:bg-surface-sunken'}`,
      }));
  }
  get selectedCount() {
    return this.selected.length;
  }
  get fieldsToggle() {
    return this.showFields ? '▾' : '▸';
  }
  get filterRows() {
    return this.filters.map((f) => ({
      ...f,
      fieldOptions: this.fields.map((x) => ({ value: x.name, label: x.label, selected: x.name === f.field })),
      opOptions: OPERATORS.map((o) => ({ value: o.id, label: o.label, selected: o.id === f.op })),
      needsValue: f.op !== 'NULL' && f.op !== 'NOTNULL',
    }));
  }
  get hasFilters() {
    return this.filters.length > 0;
  }
  get orderOptions() {
    return [
      { value: '', label: '(none)', selected: !this.orderBy },
      ...this.fields.map((f) => ({ value: f.name, label: f.label, selected: f.name === this.orderBy })),
    ];
  }
  get dirAsc() {
    return this.orderDir === 'ASC';
  }
  get dirDesc() {
    return this.orderDir === 'DESC';
  }
  get columns() {
    const r = this.result;
    if (!r) return [];
    return r.columns?.length ? r.columns : Object.keys(flattenRecord(r.records?.[0] || {}));
  }
  get rows() {
    return (this.result?.records || []).map(flattenRecord);
  }
  get hasResult() {
    return !!this.result;
  }
  get resultCount() {
    const r = this.result;
    return r ? `${r.records?.length || 0} of ${r.totalSize ?? r.records?.length ?? 0} record(s)${r.done === false ? ' (more available)' : ''}` : '';
  }
  get exportName() {
    return `${this.sobject || 'query'}-${new Date().toISOString().slice(0, 10)}`;
  }
  get ascCls() {
    return `rounded px-1.5 py-0.5 ${this.dirAsc ? 'bg-brand-50 text-brand-700' : 'hover:text-content'}`;
  }
  get descCls() {
    return `rounded px-1.5 py-0.5 ${this.dirDesc ? 'bg-brand-50 text-brand-700' : 'hover:text-content'}`;
  }
  get noObjectHint() {
    return !this.sobject && !this.loadingObjects;
  }
  get customCls() {
    return `rounded-md px-2 py-0.5 text-[10px] ${this.useCustom ? 'bg-brand-500 text-white' : 'border border-line-strong text-content hover:bg-surface-sunken'}`;
  }
  get builderCls() {
    return `rounded-md px-2 py-0.5 text-[10px] ${this.useCustom ? 'border border-line-strong text-content hover:bg-surface-sunken' : 'bg-brand-500 text-white'}`;
  }

  onObjectFilter(e) {
    this.objectFilter = e.target.value;
  }
  onPickObject(e) {
    this.pickObject(e.target.value);
  }
  onFieldFilter(e) {
    this.fieldFilter = e.target.value;
  }
  onToggleField(e) {
    const name = e.currentTarget.dataset.name;
    this.selected = this.selected.includes(name) ? this.selected.filter((f) => f !== name) : [...this.selected, name];
  }
  onToggleFields() {
    this.showFields = !this.showFields;
  }
  onSelectAll() {
    this.selected = this.fields.map((f) => f.name).slice(0, 100);
  }
  onSelectNone() {
    this.selected = [];
  }
  onAddFilter() {
    this.filters = [...this.filters, { id: Date.now() + Math.random(), field: this.fields[0]?.name || '', op: '=', value: '' }];
  }
  onFilterField(e) {
    this.patchFilter(e.currentTarget.dataset.id, { field: e.target.value });
  }
  onFilterOp(e) {
    this.patchFilter(e.currentTarget.dataset.id, { op: e.target.value });
  }
  onFilterValue(e) {
    this.patchFilter(e.currentTarget.dataset.id, { value: e.target.value });
  }
  onRemoveFilter(e) {
    const id = e.currentTarget.dataset.id;
    this.filters = this.filters.filter((f) => String(f.id) !== id);
  }
  patchFilter(id, patch) {
    this.filters = this.filters.map((f) => (String(f.id) === id ? { ...f, ...patch } : f));
  }
  onOrderBy(e) {
    this.orderBy = e.target.value;
  }
  onDir(e) {
    this.orderDir = e.currentTarget.dataset.dir;
  }
  onLimit(e) {
    this.limit = Math.min(2000, Math.max(1, Number(e.target.value) || 50));
  }
  onUseCustom() {
    this.customSoql = this.customSoql || this.soql;
    this.useCustom = true;
  }
  onUseBuilder() {
    this.useCustom = false;
  }
  onCustom(e) {
    this.customSoql = e.target.value;
  }
  onTooling(e) {
    this.tooling = e.target.checked;
  }
  async onRun() {
    if (!this.hasSoql) return;
    this.running = true;
    this.error = '';
    this.result = null;
    try {
      this.result = await http.query(this.orgId, this.soql, { tooling: this.tooling, limit: Math.min(2000, this.limit || 200) });
    } catch (e) {
      this.error = e.details?.message || e.message;
    } finally {
      this.running = false;
    }
  }
}
