import { LightningElement, api } from 'lwc';
import { Api } from '../../../lib/api.js';
import { fmtRelative, fmtInt } from '../../../lib/format.js';

/**
 * Salesforce org API limits gauge. Either pass `limits` (OrgLimits from an org.limits event) or an `orgId`
 * to fetch GET /orgs/:orgId/limits. Bars turn amber when the limit crossed the policy warn percent
 * (server sets `warning`) and rose at >= 95%.
 */
export default class LimitsGauge extends LightningElement {
  static renderMode = 'light';
  @api limits;
  @api orgId;
  @api warnPercent = 80;
  @api top = 8;
  @api compact = false;
  fetchedData = null;
  loading = false;
  error = null;
  showAll = false;
  _fetchedFor = null;

  connectedCallback() {
    if (this.orgId && !this.limits) this.load();
  }
  renderedCallback() {
    if (this.orgId && !this.limits && this._fetchedFor !== this.orgId && !this.loading) this.load();
  }
  async load(force = false) {
    this._fetchedFor = this.orgId;
    this.loading = true;
    this.error = null;
    try {
      this.fetchedData = await Api.orgLimits(this.orgId, force);
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  refresh() {
    this.load(true);
  }

  get data() {
    return this.limits || this.fetchedData || null;
  }
  get list() {
    return [...(this.data?.limits || [])].sort((a, b) => b.usedPercent - a.usedPercent);
  }
  get rows() {
    const list = this.showAll ? this.list : this.list.slice(0, Number(this.top));
    return list.map((l) => {
      const pct = Number(l.usedPercent) || 0;
      const tone = pct >= 95 ? 'rose' : l.warning || pct >= Number(this.warnPercent) ? 'amber' : 'emerald';
      const bar = { rose: 'bg-rose-500', amber: 'bg-amber-500', emerald: 'bg-emerald-500' }[tone];
      const txt = { rose: 'text-rose-700', amber: 'text-amber-700', emerald: 'text-content' }[tone];
      return {
        id: l.name,
        name: l.name,
        pct: `${pct.toFixed(pct >= 10 ? 0 : 1)}%`,
        remaining: fmtInt(l.remaining),
        style: `width:${Math.min(100, Math.max(1, pct)).toFixed(1)}%`,
        barCls: `h-2 rounded-full ${bar} transition-all`,
        pctCls: `w-32 text-right font-mono tabular-nums ${txt}`,
      };
    });
  }
  get hasRows() {
    return this.rows.length > 0;
  }
  get hasMore() {
    return this.list.length > Number(this.top);
  }
  get moreLabel() {
    return this.showAll ? 'Show top only' : `Show all ${this.list.length} limits`;
  }
  get warningRows() {
    return (this.data?.warnings || []).map((w, i) => ({ id: i, text: w }));
  }
  get hasWarnings() {
    return this.warningRows.length > 0;
  }
  get warnLabel() {
    const n = this.warningRows.length;
    return `${n} warning${n === 1 ? '' : 's'}`;
  }
  get warnColor() {
    return this.list.some((l) => l.usedPercent >= 95) ? 'rose' : 'amber';
  }
  get title() {
    return 'Org API limits';
  }
  get fetchedAt() {
    return this.data?.fetchedAt;
  }
  get fetched() {
    return this.fetchedAt ? `as of ${fmtRelative(this.fetchedAt)}` : '';
  }
  get showRefresh() {
    return !!this.orgId;
  }
  get errorMessage() {
    return this.error?.message || '';
  }
  get cls() {
    return this.compact ? 'rounded-xl border border-line bg-surface p-3' : 'card card-pad';
  }
  toggleAll() {
    this.showAll = !this.showAll;
  }
}
