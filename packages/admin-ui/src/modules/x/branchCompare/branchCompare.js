import { LightningElement, api } from 'lwc';
import { Api } from '../../../lib/api.js';

/** base/head compare with per-file visual diffs (GET /clients/:id/github/compare). */
export default class BranchCompare extends LightningElement {
  static renderMode = 'light';
  @api clientId;
  @api branches = [];
  @api repoUrl = '';
  @api get base() {
    return this._base;
  }
  set base(v) {
    this._base = v || '';
  }
  @api get head() {
    return this._head;
  }
  set head(v) {
    this._head = v || '';
    this._autoRun();
  }
  _base = '';
  _head = '';
  result = null;
  loading = false;
  error = null;
  expanded = new Set();
  _ran = false;

  _autoRun() {
    if (this._head && this._base && !this._ran) {
      this._ran = true;
      Promise.resolve().then(() => this.run());
    }
  }
  get baseValue() {
    return this._base;
  }
  get headValue() {
    return this._head;
  }
  get cannotRun() {
    return this.loading || !this._base || !this._head || this._base === this._head;
  }
  get files() {
    return (this.result?.files || []).map((f) => ({
      ...f,
      id: f.path,
      open: this.expanded.has(f.path),
      statusColor: f.status === 'added' ? 'emerald' : f.status === 'removed' ? 'rose' : 'amber',
      component: f.metadataType ? `${f.metadataType} · ${f.fullName || ''}` : '',
      hasPatch: !!f.patch,
      chevron: this.expanded.has(f.path) ? 'chevronDown' : 'chevronRight',
    }));
  }
  get hasFiles() {
    return this.files.length > 0;
  }
  get summary() {
    const r = this.result;
    return r ? `${r.files.length} file${r.files.length === 1 ? '' : 's'} changed · ahead by ${r.aheadBy}, behind by ${r.behindBy}` : '';
  }
  get totalAdd() {
    return (this.result?.files || []).reduce((a, f) => a + (f.additions || 0), 0);
  }
  get totalDel() {
    return (this.result?.files || []).reduce((a, f) => a + (f.deletions || 0), 0);
  }
  get compareUrl() {
    return this.result?.url || '';
  }
  handleBase(e) {
    this._base = e.detail.value;
  }
  handleHead(e) {
    this._head = e.detail.value;
  }
  async run() {
    if (this.cannotRun) return;
    this.loading = true;
    this.error = null;
    this.result = null;
    this.expanded = new Set();
    try {
      this.result = await Api.githubCompare(this.clientId, this._base, this._head);
      if (this.result?.files?.length) this.expanded = new Set(this.result.files.slice(0, 3).map((f) => f.path));
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  toggle(e) {
    const p = e.currentTarget.dataset.path;
    const n = new Set(this.expanded);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    this.expanded = n;
  }
  expandAll() {
    this.expanded = new Set((this.result?.files || []).map((f) => f.path));
  }
  collapseAll() {
    this.expanded = new Set();
  }
}
