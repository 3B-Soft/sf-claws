import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { toast, confirm } from '../../../lib/store.js';

/**
 * Who may see and work on this client. A super admin belongs to every client implicitly and is
 * never listed here; everyone else, platform admins included, has to be added. Removing someone
 * also closes their existing sessions for this client.
 */
export default class MembersTab extends LightningElement {
  static renderMode = 'light';
  @api clientId;
  members = [];
  users = [];
  loading = true;
  error = null;
  addOpen = false;
  addUserId = '';
  addRole = 'member';
  busy = false;

  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      const [members, users] = await Promise.all([Api.listClientMembers(this.clientId), Api.listUsers()]);
      this.members = asList(members, 'members');
      this.users = asList(users, 'users');
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }

  get rows() {
    return this.members.map((m) => ({ ...m, id: m.userId }));
  }
  get columns() {
    return [
      { key: 'displayName', label: 'User', format: (m) => m.displayName || m.email },
      { key: 'email', label: 'Email', type: 'mono' },
      { key: 'role', label: 'Client role', type: 'badge' },
      { key: 'createdAt', label: 'Added', type: 'relative' },
    ];
  }
  get actions() {
    return [
      { id: 'toggleRole', label: 'Change role', style: 'secondary' },
      { id: 'remove', label: 'Remove', style: 'danger' },
    ];
  }
  get count() {
    return `${this.members.length} member${this.members.length === 1 ? '' : 's'}`;
  }
  /** Active users who are not super admins (they belong everywhere) and not members already. */
  get candidateOptions() {
    const have = new Set(this.members.map((m) => m.userId));
    return this.users
      .filter((u) => u.status === 'active' && u.role !== 'superadmin' && !have.has(u.id))
      .map((u) => ({ value: u.id, label: `${u.displayName || u.email} (${u.email})` }));
  }
  get noCandidates() {
    return this.candidateOptions.length === 0;
  }
  get roleOptions() {
    return [
      { value: 'member', label: 'Member: sees this client and their own sessions' },
      { value: 'admin', label: 'Client admin: also sees every session of this client' },
    ];
  }
  get cannotAdd() {
    return this.busy || !this.addUserId;
  }

  openAdd() {
    this.addUserId = this.candidateOptions[0]?.value || '';
    this.addRole = 'member';
    this.addOpen = true;
  }
  closeAdd() {
    this.addOpen = false;
  }
  handleAddUser(e) {
    this.addUserId = e.detail.value;
  }
  handleAddRole(e) {
    this.addRole = e.detail.value;
  }
  async submitAdd() {
    if (!this.addUserId) return;
    if (await this.run(() => Api.setClientMember(this.clientId, this.addUserId, this.addRole), 'Member added')) this.addOpen = false;
  }

  async handleAction(e) {
    const { id, row } = e.detail;
    if (id === 'toggleRole') {
      const next = row.role === 'admin' ? 'member' : 'admin';
      await this.run(() => Api.setClientMember(this.clientId, row.userId, next), `${row.displayName || row.email} is now a client ${next}`);
    }
    if (id === 'remove') {
      const ok = await confirm({
        title: `Remove ${row.displayName || row.email}?`,
        message: 'They will no longer see this client, its orgs, or their sessions on it. Nothing is deleted; adding them back restores access.',
        confirmLabel: 'Remove member',
        danger: true,
      });
      if (ok) await this.run(() => Api.removeClientMember(this.clientId, row.userId), 'Member removed');
    }
  }
  async run(fn, okMsg) {
    this.busy = true;
    try {
      await fn();
      toast.success(okMsg);
      await this.load();
      return true;
    } catch (err) {
      toast.error('Membership change failed', err.message);
      return false;
    } finally {
      this.busy = false;
    }
  }
}
