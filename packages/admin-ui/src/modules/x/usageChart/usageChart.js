import { LightningElement, api } from 'lwc';
import { fmtUsd, fmtTokens } from '../../../lib/format.js';
/** Simple horizontal CSS bar chart. rows: UsageSummaryRow[]; metric: costUsd | inputTokens | outputTokens | sessions */
export default class UsageChart extends LightningElement {
  static renderMode = 'light';
  @api rows = [];
  @api metric = 'costUsd';
  @api limit = 12;
  get bars() {
    const rows = [...(this.rows || [])].sort((a, b) => (b[this.metric] || 0) - (a[this.metric] || 0)).slice(0, Number(this.limit));
    const max = Math.max(...rows.map((r) => Number(r[this.metric]) || 0), 0.000001);
    const palette = ['bg-brand-500', 'bg-violet-500', 'bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-fuchsia-500', 'bg-teal-500'];
    return rows.map((r, i) => {
      const v = Number(r[this.metric]) || 0;
      return {
        id: r.key ?? i,
        label: r.label || r.key || '—',
        style: `width:${Math.max(1, (v / max) * 100).toFixed(1)}%`,
        cls: `h-2.5 rounded-full ${palette[i % palette.length]} transition-all`,
        text: this.metric === 'costUsd' ? fmtUsd(v) : this.metric === 'sessions' ? String(v) : fmtTokens(v),
      };
    });
  }
  get isEmpty() {
    return !this.rows || this.rows.length === 0;
  }
}
