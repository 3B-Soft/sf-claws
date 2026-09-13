import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { ROLE_META } from '../../../lib/constants.js';
import { fmtUsd, fmtTokens } from '../../../lib/format.js';
/** Per-call usage records: GET /admin/usage/records?sessionId= */
export default class UsageRecordsTab extends LightningElement {
  static renderMode = 'light';
  @api sessionId;
  records = [];
  loading = true;
  error = null;
  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      this.records = asList(await Api.usageRecords({ sessionId: this.sessionId }), 'records');
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  get columns() {
    return [
      { key: 'createdAt', label: 'When', type: 'date' },
      { key: 'role', label: 'Role', type: 'badge', format: (r) => ROLE_META[r.role]?.label || r.role, color: (r) => ROLE_META[r.role]?.color },
      { key: 'provider', label: 'Provider', type: 'badge' },
      { key: 'modelId', label: 'Model', type: 'mono' },
      { key: 'inputTokens', label: 'In', type: 'tokens', align: 'right' },
      { key: 'cachedInputTokens', label: 'Cached', type: 'tokens', align: 'right' },
      { key: 'outputTokens', label: 'Out', type: 'tokens', align: 'right' },
      { key: 'costUsd', label: 'Cost', align: 'right', format: (r) => fmtUsd(r.costUsd, { precise: true }) },
      { key: 'durationMs', label: 'Duration', align: 'right', format: (r) => `${(r.durationMs / 1000).toFixed(1)}s` },
    ];
  }
  get byRole() {
    const map = {};
    this.records.forEach((r) => {
      const m =
        map[r.role] ||
        (map[r.role] = {
          key: r.role,
          label: ROLE_META[r.role]?.label || r.role,
          sessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          costUsd: 0,
        });
      m.sessions++;
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
      m.cachedInputTokens += r.cachedInputTokens;
      m.costUsd += r.costUsd;
    });
    return Object.values(map);
  }
  get total() {
    return fmtUsd(
      this.records.reduce((a, r) => a + r.costUsd, 0),
      { precise: true },
    );
  }
  get totalTokens() {
    return `${fmtTokens(this.records.reduce((a, r) => a + r.inputTokens, 0))} in · ${fmtTokens(this.records.reduce((a, r) => a + r.outputTokens, 0))} out`;
  }
  get hasRecords() {
    return this.records.length > 0;
  }
}
