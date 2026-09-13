import { LightningElement, api } from 'lwc';
/** tabs: [{ id, label, count? }] ; active: id ; emits 'select' {id} */
export default class Tabs extends LightningElement {
  static renderMode = 'light';
  @api tabs = [];
  @api active;
  get items() {
    return (this.tabs || []).map((t) => ({
      ...t,
      cls: `relative -mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${t.id === this.active ? 'border-brand-500 text-content-strong' : 'border-transparent text-content-muted hover:border-line-strong hover:text-content'}`,
      hasCount: t.count !== undefined && t.count !== null,
    }));
  }
  select(e) {
    this.dispatchEvent(new CustomEvent('select', { detail: { id: e.currentTarget.dataset.id } }));
  }
}
