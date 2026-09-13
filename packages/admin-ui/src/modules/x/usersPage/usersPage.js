import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { toast, confirm } from '../../../lib/store.js';
import { USER_ROLES } from '../../../lib/constants.js';
import { isSuperadmin } from '../../../lib/rbac.js';

export default class UsersPage extends LightningElement {
  static renderMode = 'light';
  @api user;
  users = [];
  /** userId -> "Acme (admin), Globex" — which clients each user may see. */
  membershipsByUser = {};
  loading = true;
  error = null;
  filter = 'all';
  search = '';
  // approve modal
  approveTarget = null;
  approveRole = 'user';
  // edit modal
  editTarget = null;
  editForm = {};
  busy = false;
  // client access (edit modal)
  clients = [];
  clientAccess = [];
  clientAccessLoading = false;

  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      const [users, memberships] = await Promise.all([Api.listUsers(), Api.listMemberships().catch(() => [])]);
      this.users = asList(users, 'users');
      const byUser = {};
      for (const m of asList(memberships, 'memberships')) {
        (byUser[m.userId] ||= []).push(m.role === 'admin' ? `${m.clientName} (admin)` : m.clientName);
      }
      this.membershipsByUser = byUser;
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }

  get roleOptions() {
    return USER_ROLES.filter((r) => r !== 'superadmin' || isSuperadmin(this.user)).map((r) => ({ value: r, label: r }));
  }
  get pendingCount() {
    return this.users.filter((u) => u.status === 'pending').length;
  }
  get filters() {
    const counts = {
      all: this.users.length,
      pending: this.pendingCount,
      active: this.users.filter((u) => u.status === 'active').length,
      disabled: this.users.filter((u) => u.status === 'disabled').length,
    };
    return ['all', 'pending', 'active', 'disabled'].map((f) => ({
      id: f,
      label: f[0].toUpperCase() + f.slice(1),
      count: counts[f],
      cls: `btn-sm ${this.filter === f ? 'btn-primary' : 'btn-secondary'}`,
    }));
  }
  get rows() {
    const q = this.search.trim().toLowerCase();
    return this.users
      .filter(
        (u) =>
          (this.filter === 'all' || u.status === this.filter) && (!q || u.email.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q)),
      )
      .sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || new Date(b.createdAt) - new Date(a.createdAt));
  }
  get columns() {
    return [
      { key: 'displayName', label: 'User', format: (u) => u.displayName || u.email },
      { key: 'email', label: 'Email', type: 'mono' },
      { key: 'role', label: 'Role', type: 'badge' },
      { key: 'status', label: 'Status', type: 'badge' },
      {
        key: 'clients',
        label: 'Clients',
        format: (u) => (u.role === 'superadmin' ? 'All (super admin)' : (this.membershipsByUser[u.id] || []).join(', ') || 'None'),
      },
      { key: 'uiMode', label: 'UI mode', type: 'badge' },
      { key: 'createdAt', label: 'Registered', type: 'relative' },
      { key: 'lastSeenAt', label: 'Last seen', type: 'relative' },
    ];
  }
  get actions() {
    const me = this.user?.id;
    return [
      { id: 'approve', label: 'Approve', style: 'primary', when: (u) => u.status === 'pending' },
      { id: 'edit', label: 'Edit', style: 'secondary', when: (u) => u.status !== 'pending' },
      { id: 'enable', label: 'Enable', style: 'secondary', when: (u) => u.status === 'disabled' },
      {
        id: 'disable',
        label: 'Disable',
        style: 'danger',
        when: (u) => u.status === 'active' && u.id !== me && (isSuperadmin(this.user) || u.role !== 'superadmin'),
      },
    ];
  }
  get rowClass() {
    return (u) => (u.status === 'pending' ? 'bg-amber-500/[0.06]' : '');
  }
  get hasPending() {
    return this.pendingCount > 0;
  }
  get pendingBanner() {
    return `${this.pendingCount} user${this.pendingCount === 1 ? '' : 's'} waiting for approval`;
  }

  setFilter(e) {
    this.filter = e.currentTarget.dataset.id;
  }
  handleSearch(e) {
    this.search = e.detail.value;
  }

  async handleAction(e) {
    const { id, row } = e.detail;
    if (id === 'approve') {
      this.approveTarget = row;
      this.approveRole = 'user';
      return;
    }
    if (id === 'edit') {
      this.editTarget = row;
      this.editForm = { displayName: row.displayName, role: row.role, uiMode: row.uiMode || 'visual' };
      this.loadClientAccess(row);
      return;
    }
    if (id === 'disable') {
      if (
        !(await confirm({
          title: `Disable ${row.displayName || row.email}?`,
          message: 'They will be signed out and unable to use the extension until re-enabled.',
          confirmLabel: 'Disable',
          danger: true,
        }))
      )
        return;
      await this.run(() => Api.disableUser(row.id), 'User disabled');
    }
    if (id === 'enable') await this.run(() => Api.updateUser(row.id, { status: 'active' }), 'User enabled');
  }
  async run(fn, okMsg) {
    this.busy = true;
    try {
      await fn();
      toast.success(okMsg);
      await this.load();
      return true;
    } catch (err) {
      toast.error('Action failed', err.message);
      return false;
    } finally {
      this.busy = false;
    }
  }

  // approve modal
  get approveOpen() {
    return !!this.approveTarget;
  }
  get approveTitle() {
    return `Approve ${this.approveTarget?.displayName || this.approveTarget?.email || ''}`;
  }
  handleApproveRole(e) {
    this.approveRole = e.detail.value;
  }
  closeApprove() {
    this.approveTarget = null;
  }
  async submitApprove() {
    const t = this.approveTarget;
    if (await this.run(() => Api.approveUser(t.id, this.approveRole), `${t.displayName || t.email} approved as ${this.approveRole}`)) this.approveTarget = null;
  }
  // edit modal
  get editOpen() {
    return !!this.editTarget;
  }
  get editTitle() {
    return `Edit ${this.editTarget?.email || ''}`;
  }
  get uiModeOptions() {
    return [
      { value: 'visual', label: 'Visual (default, for admins)' },
      { value: 'pro', label: 'Pro (raw XML / SOQL)' },
    ];
  }
  handleEditField(e) {
    this.editForm = { ...this.editForm, [e.detail.name]: e.detail.value };
  }
  closeEdit() {
    this.editTarget = null;
  }

  // ---- client access ----
  /** A super admin belongs to every client, so there is nothing to assign for them. */
  get editSeesAllClients() {
    return this.editForm.role === 'superadmin';
  }
  get noClients() {
    return !this.clients.length;
  }
  get clientAccessOptions() {
    return this.clients.map((c) => ({ id: c.id, name: c.name, checked: this.clientAccess.includes(c.id) }));
  }
  async loadClientAccess(row) {
    this.clientAccess = [];
    this.clientAccessLoading = true;
    try {
      const [clients, access] = await Promise.all([Api.listClients(), Api.getUserClients(row.id)]);
      this.clients = asList(clients, 'clients');
      this.clientAccess = access?.clientIds || [];
    } catch (e) {
      toast.error('Could not load client access', e.message);
    } finally {
      this.clientAccessLoading = false;
    }
  }
  handleClientAccess(e) {
    const { name, value } = e.detail;
    this.clientAccess = value ? [...this.clientAccess, name] : this.clientAccess.filter((id) => id !== name);
  }
  async submitEdit() {
    const t = this.editTarget;
    const patch = {};
    ['displayName', 'role', 'uiMode'].forEach((k) => {
      if (this.editForm[k] !== undefined && this.editForm[k] !== t[k]) patch[k] = this.editForm[k];
    });
    // Membership is saved for anyone but a super admin, who already belongs to every client; the
    // server refuses it for them, and only a super admin may change it at all.
    const saveAccess = t.role !== 'superadmin' && this.editForm.role !== 'superadmin' && this.user?.role === 'superadmin';
    if (!Object.keys(patch).length && !saveAccess) {
      this.editTarget = null;
      return;
    }
    const ok = await this.run(async () => {
      if (Object.keys(patch).length) await Api.updateUser(t.id, patch);
      if (saveAccess) await Api.setUserClients(t.id, this.clientAccess);
    }, 'User updated');
    if (ok) this.editTarget = null;
  }
  get editIsSelf() {
    return this.editTarget?.id === this.user?.id;
  }
}
