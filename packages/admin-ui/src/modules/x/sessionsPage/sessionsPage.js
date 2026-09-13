import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { isAdmin } from '../../../lib/rbac.js';
import { SESSION_STATUSES } from '../../../lib/constants.js';
import { navigate, setQuery } from '../../../lib/router.js';
import { titleCase } from '../../../lib/format.js';

export default class SessionsPage extends LightningElement {
  static renderMode = 'light';
  @api user;
  @api query = {};
  sessions = [];
  users = [];
  clients = [];
  loading = true;
  error = null;
  filters = { userId: '', clientId: '', status: '', helpful: '', from: '', to: '', taskId: '' };

  connectedCallback() {
    const q = this.query || {};
    this.filters = {
      userId: q.userId || '',
      clientId: q.clientId || '',
      status: q.status || '',
      helpful: q.helpful || '',
      from: q.from || '',
      to: q.to || '',
      taskId: q.taskId || '',
    };
    this.loadRefs();
    this.load();
  }
  get admin() {
    return isAdmin(this.user);
  }
  async loadRefs() {
    if (!this.admin) return;
    Api.listUsers()
      .then((r) => {
        this.users = asList(r, 'users');
      })
      .catch(() => {});
    Api.listClients()
      .then((r) => {
        this.clients = asList(r, 'clients');
      })
      .catch(() => {});
  }
  async load() {
    this.loading = true;
    this.error = null;
    const f = this.filters;
    try {
      let list;
      if (this.admin)
        list = asList(
          await Api.adminSessions({ userId: f.userId, clientId: f.clientId, status: f.status, from: f.from, to: f.to, helpful: f.helpful }),
          'sessions',
        );
      else list = asList(await Api.listSessions({ mine: 1, clientId: f.clientId, status: f.status }), 'sessions');
      this.sessions = list;
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  get rows() {
    const f = this.filters;
    return this.sessions
      .filter((s) => (!f.status || s.status === f.status) && (!f.taskId || s.taskId === f.taskId) && (!f.helpful || String(s.helpful) === f.helpful))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
      .map((s) => ({
        ...s,
        userName: this.users.find((u) => u.id === s.userId)?.displayName || s.userId,
        clientName: this.clients.find((c) => c.id === s.clientId)?.name || s.clientId,
      }));
  }
  get columns() {
    const cols = [
      { key: 'title', label: 'Session', max: 70 },
      { key: 'status', label: 'Status', type: 'badge' },
    ];
    if (this.admin) cols.push({ key: 'userName', label: 'User' }, { key: 'clientName', label: 'Client' });
    cols.push(
      { key: 'uiMode', label: 'Mode', type: 'badge' },
      { key: 'inputTokens', label: 'In', type: 'tokens', align: 'right' },
      { key: 'outputTokens', label: 'Out', type: 'tokens', align: 'right' },
      { key: 'costUsd', label: 'Cost', type: 'usd', align: 'right' },
      { key: 'helpful', label: 'Helpful', format: (s) => (s.helpful === true ? '👍' : s.helpful === false ? '👎' : '—') },
      { key: 'updatedAt', label: 'Updated', type: 'relative' },
    );
    return cols;
  }
  get userOptions() {
    return this.users.map((u) => ({ value: u.id, label: u.displayName || u.email }));
  }
  get clientOptions() {
    return this.clients.map((c) => ({ value: c.id, label: c.name }));
  }
  get statusOptions() {
    return SESSION_STATUSES.map((s) => ({ value: s, label: titleCase(s) }));
  }
  get helpfulOptions() {
    return [
      { value: 'true', label: 'Helpful' },
      { value: 'false', label: 'Not helpful' },
    ];
  }
  get subtitle() {
    return this.admin ? 'Every session across all users, with token usage and cost.' : 'Your sessions started from the Chrome extension.';
  }
  get taskFilterActive() {
    return !!this.filters.taskId;
  }
  get total() {
    return this.rows.length;
  }
  get totalCost() {
    return this.rows.reduce((a, s) => a + (Number(s.costUsd) || 0), 0).toFixed(2);
  }

  handleFilter(e) {
    this.filters = { ...this.filters, [e.detail.name]: e.detail.value };
    this.sync();
    this.load();
  }
  clearTask() {
    this.filters = { ...this.filters, taskId: '' };
    this.sync();
  }
  reset() {
    this.filters = { userId: '', clientId: '', status: '', helpful: '', from: '', to: '', taskId: '' };
    this.sync();
    this.load();
  }
  sync() {
    setQuery({ ...this.filters });
  }
  open(e) {
    navigate(`/sessions/${e.detail.row.id}`);
  }
}
