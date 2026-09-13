import { LightningElement, api } from 'lwc';
import { fmtDate, shortSha } from '../../../lib/format.js';
export default class DocsTab extends LightningElement {
  static renderMode = 'light';
  @api docs = [];
  @api get selectedId() {
    return this._sel;
  }
  set selectedId(v) {
    this._sel = v || null;
  }
  _sel = null;
  get list() {
    return (this.docs || []).map((d) => ({
      ...d,
      cls: `flex w-full flex-col rounded-lg px-2.5 py-2 text-left ${d.id === this.current?.id ? 'bg-brand-50 font-medium text-brand-700 ring-1 ring-inset ring-brand-500/30' : 'text-content hover:bg-surface-sunken'}`,
      when: fmtDate(d.createdAt),
      sha: shortSha(d.committedSha),
      tagList: (d.tags || []).map((t) => ({ id: t, label: t })),
    }));
  }
  get current() {
    const docs = this.docs || [];
    return docs.find((d) => d.id === this._sel) || docs[0] || null;
  }
  get hasDocs() {
    return (this.docs || []).length > 0;
  }
  get currentSha() {
    return this.current?.committedSha ? `committed ${shortSha(this.current.committedSha)}` : 'not committed yet';
  }
  select(e) {
    this._sel = e.currentTarget.dataset.id;
  }
}
