import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { todayIso, daysAgoIso, fmtUsd, fmtTokens, fmtInt } from '../../../lib/format.js';
import { setQuery } from '../../../lib/router.js';

export default class UsagePage extends LightningElement {
  static renderMode = 'light';
  @api query = {};
  summary = null;
  budget = [];
  tools = [];
  loading = true;
  error = null;
  groupBy = 'user';
  from = daysAgoIso(30);
  to = todayIso();
  metric = 'costUsd';
  _init = false;

  connectedCallback() {
    this.groupBy = this.query?.groupBy || 'user';
    this.from = this.query?.from || daysAgoIso(30);
    this.to = this.query?.to || todayIso();
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      this.summary = await Api.usageSummary({ from: this.from, to: this.to, groupBy: this.groupBy });
      // Budget and per-tool telemetry are separate concerns from token spend, and both are things a
      // super admin needs at a glance: is anyone near a ceiling, and are the tools earning their keep.
      const [budget, tools] = await Promise.all([Api.budget().catch(() => []), Api.toolSummary({ from: this.from, to: this.to }).catch(() => ({ tools: [] }))]);
      this.budget = asList(budget, 'budget');
      this.tools = tools?.tools ?? [];
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  /** Clients with a monthly ceiling configured, worst first — the ones worth looking at. */
  get budgetRows() {
    return (this.budget ?? [])
      .filter((b) => b.percentUsed !== null)
      .sort((a, b) => b.percentUsed - a.percentUsed)
      .map((b) => ({
        ...b,
        spentLabel: `$${Number(b.spentThisMonth).toFixed(2)} of $${Number(b.monthlyLimitUsd).toFixed(2)}`,
        barStyle: `width: ${Math.min(100, b.percentUsed)}%`,
        barCls: `h-1.5 rounded-full ${b.percentUsed >= 90 ? 'bg-rose-500' : b.percentUsed >= 70 ? 'bg-amber-500' : 'bg-emerald-500'}`,
        percentLabel: `${b.percentUsed}%`,
      }));
  }
  get hasBudgets() {
    return this.budgetRows.length > 0;
  }
  /** Clients with no ceiling at all: worth surfacing, since an unbounded loop is a financial risk. */
  get unlimitedClients() {
    return (this.budget ?? []).filter((b) => b.percentUsed === null).map((b) => b.clientName);
  }
  get hasUnlimited() {
    return this.unlimitedClients.length > 0;
  }
  get unlimitedLabel() {
    return `No monthly ceiling set: ${this.unlimitedClients.join(', ')}`;
  }

  get toolColumns() {
    return [
      { key: 'tool', label: 'Tool', type: 'mono' },
      { key: 'calls', label: 'Calls', align: 'right' },
      { key: 'failures', label: 'Failures', align: 'right', format: (t) => (t.failures ? String(t.failures) : '—') },
      { key: 'failureRate', label: 'Fail %', align: 'right', format: (t) => (t.calls ? `${Math.round((t.failures / t.calls) * 100)}%` : '—') },
      { key: 'avgMs', label: 'Avg ms', align: 'right', format: (t) => (t.calls ? String(Math.round(t.totalMs / t.calls)) : '—') },
      { key: 'avgResultChars', label: 'Avg result', align: 'right', format: (t) => `${Math.round((t.avgResultChars ?? 0) / 1000)}k` },
    ];
  }
  get toolRows() {
    return this.tools ?? [];
  }

  get groupOptions() {
    return [
      { value: 'user', label: 'User' },
      { value: 'client', label: 'Client' },
      { value: 'model', label: 'Model' },
      { value: 'role', label: 'Agent role' },
    ];
  }
  get metricOptions() {
    return [
      { value: 'costUsd', label: 'Cost (USD)' },
      { value: 'inputTokens', label: 'Input tokens' },
      { value: 'outputTokens', label: 'Output tokens' },
      { value: 'sessions', label: 'Sessions' },
    ];
  }
  get presets() {
    return [
      { id: '7', label: '7d' },
      { id: '30', label: '30d' },
      { id: '90', label: '90d' },
    ].map((p) => ({ ...p, cls: `btn-secondary btn-xs ${this.from === daysAgoIso(Number(p.id)) && this.to === todayIso() ? 'ring-1 ring-brand-500' : ''}` }));
  }
  get rows() {
    return this.summary?.rows || [];
  }
  get totals() {
    return this.summary?.totals || null;
  }
  get totalCost() {
    return fmtUsd(this.totals?.costUsd);
  }
  get totalSessions() {
    return fmtInt(this.totals?.sessions);
  }
  get totalInput() {
    return fmtTokens(this.totals?.inputTokens);
  }
  get totalOutput() {
    return fmtTokens(this.totals?.outputTokens);
  }
  get totalCached() {
    return `${fmtTokens(this.totals?.cachedInputTokens)} cached`;
  }
  get avgCost() {
    const t = this.totals;
    return t?.sessions ? `${fmtUsd(t.costUsd / t.sessions)} per session` : '';
  }
  get groupLabel() {
    return this.groupOptions.find((o) => o.value === this.groupBy)?.label || 'Group';
  }
  get columns() {
    return [
      { key: 'label', label: this.groupLabel, format: (r) => r.label || r.key },
      { key: 'sessions', label: 'Sessions', type: 'int', align: 'right' },
      { key: 'inputTokens', label: 'Input', type: 'tokens', align: 'right' },
      { key: 'cachedInputTokens', label: 'Cached', type: 'tokens', align: 'right' },
      { key: 'outputTokens', label: 'Output', type: 'tokens', align: 'right' },
      { key: 'costUsd', label: 'Cost', type: 'usd', align: 'right' },
      {
        key: 'share',
        label: 'Share',
        align: 'right',
        format: (r) => (this.totals?.costUsd ? `${((r.costUsd / this.totals.costUsd) * 100).toFixed(1)}%` : '—'),
      },
    ];
  }
  get sortedRows() {
    return [...this.rows].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).map((r) => ({ ...r, id: r.key }));
  }
  get hasRows() {
    return this.rows.length > 0;
  }

  handleGroup(e) {
    this.groupBy = e.detail.value;
    this.sync();
    this.load();
  }
  handleFrom(e) {
    this.from = e.detail.value;
  }
  handleTo(e) {
    this.to = e.detail.value;
  }
  handleMetric(e) {
    this.metric = e.detail.value;
  }
  applyPreset(e) {
    this.from = daysAgoIso(Number(e.currentTarget.dataset.id));
    this.to = todayIso();
    this.sync();
    this.load();
  }
  apply() {
    this.sync();
    this.load();
  }
  sync() {
    setQuery({ groupBy: this.groupBy, from: this.from, to: this.to });
  }
}
