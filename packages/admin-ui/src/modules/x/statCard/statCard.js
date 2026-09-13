import { LightningElement, api } from 'lwc';
export default class StatCard extends LightningElement {
  static renderMode = 'light';
  @api label = '';
  @api value = '—';
  @api hint = '';
  @api icon = 'info';
  @api tone = 'brand'; // brand | emerald | amber | rose | sky
  @api href;
  @api loading = false;
  get iconCls() {
    const map = {
      brand: 'bg-brand-500/15 text-brand-600',
      emerald: 'bg-emerald-500/15 text-emerald-700',
      amber: 'bg-amber-500/15 text-amber-700',
      rose: 'bg-rose-500/15 text-rose-700',
      sky: 'bg-sky-500/15 text-sky-700',
    };
    return `flex h-10 w-10 items-center justify-center rounded-lg ${map[this.tone] || map.brand}`;
  }
  get cardCls() {
    return `card card-pad flex items-start gap-4 ${this.href ? 'transition-colors hover:border-line-strong hover:bg-surface' : ''}`;
  }
}
