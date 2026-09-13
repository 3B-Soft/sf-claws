import { LightningElement, api } from 'lwc';
export default class EmptyState extends LightningElement {
  static renderMode = 'light';
  @api title = '';
  @api description = '';
  @api tone = 'slate'; // slate | rose | amber | brand
  @api compact = false;
  get wrapClass() {
    const tones = {
      slate: 'border-line bg-surface',
      rose: 'border-rose-500/30 bg-rose-500/5',
      amber: 'border-amber-500/30 bg-amber-500/5',
      brand: 'border-brand-500/30 bg-brand-500/5',
      emerald: 'border-emerald-500/30 bg-emerald-500/5',
    };
    return `rounded-xl border border-dashed ${tones[this.tone] || tones.slate} ${this.compact ? 'p-3' : 'p-5'} text-center`;
  }
  get titleClass() {
    const t = { rose: 'text-rose-700', amber: 'text-amber-700', brand: 'text-brand-700', emerald: 'text-emerald-700' };
    return `text-sm font-medium ${t[this.tone] || 'text-content'}`;
  }
}
