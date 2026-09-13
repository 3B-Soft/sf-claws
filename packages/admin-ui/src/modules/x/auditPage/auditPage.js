import { LightningElement } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { safeJson, truncate } from '../../../lib/format.js';

export default class AuditPage extends LightningElement {
  static renderMode = 'light';
  entries = [];
  loading = true;
  error = null;
  limit = 100;
  search = '';
  selected = null;
  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      this.entries = asList(await Api.audit(this.limit), 'entries');
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  get limitOptions() {
    return [50, 100, 250, 500].map((n) => ({ value: n, label: `Last ${n}` }));
  }
  get rows() {
    const q = this.search.trim().toLowerCase();
    return this.entries.filter(
      (e) =>
        !q ||
        [e.action, e.target, e.userId, e.ip].some((v) =>
          String(v || '')
            .toLowerCase()
            .includes(q),
        ),
    );
  }
  get columns() {
    return [
      { key: 'at', label: 'When', type: 'date' },
      {
        key: 'action',
        label: 'Action',
        type: 'badge',
        color: (e) => (/(delete|disable|fail|error|reject)/i.test(e.action) ? 'rose' : /(create|approve|deploy|commit)/i.test(e.action) ? 'emerald' : 'slate'),
      },
      { key: 'userId', label: 'User', type: 'mono' },
      { key: 'target', label: 'Target', type: 'mono' },
      { key: 'details', label: 'Details', format: (e) => (e.details ? truncate(safeJson(e.details, 0), 90) : '—') },
      { key: 'ip', label: 'IP', type: 'mono' },
    ];
  }
  handleLimit(e) {
    this.limit = Number(e.detail.value);
    this.load();
  }
  handleSearch(e) {
    this.search = e.detail.value;
  }
  openRow(e) {
    this.selected = e.detail.row;
  }
  closeRow() {
    this.selected = null;
  }
  get detailOpen() {
    return !!this.selected;
  }
  get detailTitle() {
    return this.selected?.action || '';
  }
  get selectedDetails() {
    return this.selected?.details ?? null;
  }
  get hasDetails() {
    return this.selected?.details !== null && this.selected?.details !== undefined;
  }
}
