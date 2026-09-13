import { LightningElement } from 'lwc';
import { appStore, refreshLimits } from '../../../lib/state.js';
import { fmtRelative } from '../../../lib/format.js';

/**
 * API limits mini-gauge (header) + expandable list of the top limits by usedPercent and
 * a warnings banner. Amber when any limit crosses the policy warn threshold, rose at ≥95%.
 */
export default class LimitsGauge extends LightningElement {
  static renderMode = 'light';
  state = appStore.get();
  open = false;
  dismissed = '';
  _unsub = null;
  connectedCallback() {
    this._unsub = appStore.subscribe((s) => {
      this.state = s;
    });
  }
  disconnectedCallback() {
    this._unsub?.();
  }

  get limits() {
    return this.state.orgLimits;
  }
  get has() {
    return !!this.limits && Array.isArray(this.limits.limits) && this.limits.limits.length > 0;
  }
  get error() {
    return !this.has && this.state.orgLimitsError ? this.state.orgLimitsError : '';
  }
  get top() {
    return this.has ? this.limits.limits.slice().sort((a, b) => b.usedPercent - a.usedPercent) : [];
  }
  get primary() {
    return this.top.find((l) => l.name === 'DailyApiRequests') || this.top[0];
  }
  get tone() {
    const p = this.primary;
    const worst = this.top[0];
    const pct = Math.max(p?.usedPercent || 0, worst?.usedPercent || 0);
    return pct >= 95 ? 'rose' : this.top.some((l) => l.warning) ? 'amber' : 'emerald';
  }
  get pct() {
    return Math.round(this.primary?.usedPercent || 0);
  }
  get label() {
    return `API ${this.pct}%`;
  }
  get title() {
    return this.primary
      ? `${this.primary.name}: ${this.primary.remaining.toLocaleString()} of ${this.primary.max.toLocaleString()} remaining`
      : 'Org API limits';
  }
  get chipCls() {
    const t = {
      emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
      amber: 'border-amber-500/40 bg-amber-500/10 text-amber-700',
      rose: 'border-rose-500/50 bg-rose-500/15 text-rose-700',
    }[this.tone];
    return `inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${t}`;
  }
  get ringStyle() {
    const c = { emerald: '#2e844a', amber: '#fe9339', rose: '#ea001e' }[this.tone];
    return `background: conic-gradient(${c} ${this.pct * 3.6}deg, #e5e5e5 0deg)`;
  }
  get warnings() {
    return this.limits?.warnings || [];
  }
  get hasWarnings() {
    return this.warnings.length > 0 && this.dismissed !== this.warnKey;
  }
  get warnKey() {
    return this.warnings.join('|');
  }
  get warningText() {
    return this.warnings.length === 1 ? this.warnings[0] : `${this.warnings.length} org limits are near their cap`;
  }
  get warningRows() {
    return this.warnings.map((w, i) => ({ key: i, text: w }));
  }
  get rows() {
    return this.top.slice(0, 8).map((l) => ({
      key: l.name,
      name: l.name.replace(/([a-z])([A-Z])/g, '$1 $2'),
      pct: `${Math.round(l.usedPercent)}%`,
      remaining: `${l.remaining.toLocaleString()} / ${l.max.toLocaleString()}`,
      barStyle: `width:${Math.min(100, l.usedPercent)}%`,
      barCls: `h-full rounded ${l.usedPercent >= 95 ? 'bg-rose-400' : l.warning ? 'bg-amber-400' : 'bg-emerald-400'}`,
      pctCls: `w-10 text-right font-mono text-[10px] ${l.usedPercent >= 95 ? 'text-rose-700' : l.warning ? 'text-amber-700' : 'text-content-muted'}`,
    }));
  }
  get fetched() {
    return this.limits?.fetchedAt ? `updated ${fmtRelative(this.limits.fetchedAt)}` : '';
  }

  onToggle(e) {
    e.stopPropagation();
    this.open = !this.open;
  }
  onClose() {
    this.open = false;
  }
  onRefresh(e) {
    e.stopPropagation();
    refreshLimits(true);
  }
  onDismiss() {
    this.dismissed = this.warnKey;
  }
}
