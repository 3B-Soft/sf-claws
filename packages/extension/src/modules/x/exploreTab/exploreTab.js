import { LightningElement } from 'lwc';
export default class ExploreTab extends LightningElement {
  static renderMode = 'light';
  sub = 'soql';
  get isSoql() {
    return this.sub === 'soql';
  }
  get isMeta() {
    return this.sub === 'meta';
  }
  get soqlCls() {
    return this.btn(this.isSoql);
  }
  get metaCls() {
    return this.btn(this.isMeta);
  }
  btn(active) {
    return `rounded-lg px-3 py-1 text-[12px] font-medium ${active ? 'bg-surface-sunken text-content-strong' : 'text-content-muted hover:text-content'}`;
  }
  onSub(e) {
    this.sub = e.currentTarget.dataset.sub;
  }
}
