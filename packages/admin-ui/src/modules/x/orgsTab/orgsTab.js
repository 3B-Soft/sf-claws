import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { toast, confirm } from '../../../lib/store.js';
import { ORG_KINDS } from '../../../lib/constants.js';
import { fmtRelative } from '../../../lib/format.js';
import { isSuperadmin } from '../../../lib/rbac.js';
import { authStore } from '../../../lib/store.js';

/** Salesforce orgs of a client: list, create, connect (OAuth), disconnect, protected toggle. */
export default class OrgsTab extends LightningElement {
  static renderMode = 'light';
  @api clientId;
  @api authMode = 'external_app';
  orgs = [];
  loading = true;
  error = null;
  modalOpen = false;
  form = {};
  busy = false;
  busyOrg = null;
  limitsOpen = new Set();
  _pollTimer = null;

  connectedCallback() {
    this.load();
  }
  disconnectedCallback() {
    clearTimeout(this._pollTimer);
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      this.orgs = asList(await Api.listOrgs(this.clientId), 'orgs');
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  get rows() {
    return this.orgs.map((o) => ({
      ...o,
      connected: o.status === 'connected',
      busy: this.busyOrg === o.id,
      instance: o.instanceUrl || o.loginUrl,
      last: o.lastConnectedAt ? `Connected ${fmtRelative(o.lastConnectedAt)}` : 'Never connected',
      protectedLabel: o.protected ? 'Protected' : 'Standard',
      protectedColor: o.protected ? 'rose' : 'slate',
      user: o.username || '—',
      cardCls: `card card-pad relative ${o.protected ? 'ring-1 ring-rose-500/20' : ''}`,
      toggleCls: `btn-ghost btn-xs ${o.protected ? 'text-rose-700' : 'text-content-muted'}`,
      toggleLabel: o.protected ? 'Unprotect' : 'Protect',
      showLimits: this.limitsOpen.has(o.id),
      limitsCls: `btn-ghost btn-xs ${this.limitsOpen.has(o.id) ? 'text-sky-700' : 'text-content-muted'}`,
      limitsLabel: this.limitsOpen.has(o.id) ? 'Hide limits' : 'API limits',
      browserAuth: this.browserAuth,
    }));
  }
  get superadmin() {
    return isSuperadmin(authStore.get().user);
  }
  get hasRows() {
    return this.rows.length > 0;
  }
  get isEmpty() {
    return !this.loading && !this.error && this.orgs.length === 0;
  }
  get kindOptions() {
    return ORG_KINDS.map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }));
  }
  get cannotCreate() {
    return this.busy || !this.form.label?.trim() || (this.browserAuth ? !this.validMyDomain : !this.form.consumerKey?.trim());
  }
  get browserAuth() {
    return this.authMode === 'browser_session';
  }
  get validMyDomain() {
    try {
      const host = new URL(this.form.loginUrl).hostname;
      return /(?:\.salesforce\.com|\.force\.com)$/.test(host) && !/^(login|test)\.salesforce\.com$/.test(host);
    } catch {
      return false;
    }
  }
  get callbackUrl() {
    return `${window.location.origin}/api/v1/oauth/salesforce/callback`;
  }

  openCreate() {
    this.form = {
      label: '',
      kind: 'sandbox',
      loginUrl: 'https://test.salesforce.com',
      apiVersion: '62.0',
      protected: false,
      consumerKey: '',
      consumerSecret: '',
    };
    this.modalOpen = true;
  }
  closeCreate() {
    this.modalOpen = false;
  }
  handleField(e) {
    const { name, value } = e.detail;
    const next = { ...this.form, [name]: value };
    if (name === 'kind') {
      next.loginUrl = value === 'production' || value === 'developer' ? 'https://login.salesforce.com' : 'https://test.salesforce.com';
      if (value === 'production') next.protected = true;
    }
    this.form = next;
  }
  async create() {
    this.busy = true;
    try {
      const org = await Api.createOrg(this.clientId, {
        label: this.form.label.trim(),
        kind: this.form.kind,
        loginUrl: this.form.loginUrl,
        consumerKey: this.browserAuth ? undefined : this.form.consumerKey.trim(),
        consumerSecret: this.browserAuth ? undefined : this.form.consumerSecret || undefined,
        apiVersion: this.form.apiVersion || '62.0',
        protected: !!this.form.protected,
      });
      toast.success('Org added', this.browserAuth ? 'Open this org in Chrome; SF Claws will use that signed-in session.' : 'Now connect it to Salesforce.');
      this.modalOpen = false;
      await this.load();
      if (org?.id && !this.browserAuth) this.connectOrg(org.id);
    } catch (err) {
      toast.error('Could not add org', err.message);
    } finally {
      this.busy = false;
    }
  }
  async connect(e) {
    this.connectOrg(e.currentTarget.dataset.id);
  }
  async connectOrg(orgId) {
    this.busyOrg = orgId;
    // Open the popup synchronously-ish to avoid blockers, then navigate it.
    const popup = window.open('', 'sf-claws-oauth', 'width=600,height=750');
    try {
      const { url } = await Api.orgConnectStart(orgId);
      if (popup) popup.location.href = url;
      else window.open(url, '_blank');
      toast.info('Salesforce login opened', 'Complete the login in the new window; status refreshes automatically.');
      this.pollStatus(orgId, 0);
    } catch (err) {
      popup?.close();
      toast.error('Could not start connection', err.message);
    } finally {
      this.busyOrg = null;
    }
  }
  pollStatus(orgId, n) {
    clearTimeout(this._pollTimer);
    if (n > 40) return;
    this._pollTimer = setTimeout(async () => {
      try {
        const s = await Api.orgStatus(orgId);
        if (s?.status === 'connected') {
          toast.success('Org connected');
          await this.load();
          return;
        }
      } catch {
        /* keep polling */
      }
      this.pollStatus(orgId, n + 1);
    }, 3000);
  }
  async disconnect(e) {
    const id = e.currentTarget.dataset.id;
    const org = this.orgs.find((o) => o.id === id);
    if (
      !(await confirm({
        title: `Disconnect ${org?.label}?`,
        message: 'The stored refresh token is revoked. Sessions on this org will fail until reconnected.',
        confirmLabel: 'Disconnect',
        danger: true,
      }))
    )
      return;
    this.busyOrg = id;
    try {
      await Api.orgDisconnect(id);
      toast.success('Org disconnected');
      await this.load();
    } catch (err) {
      toast.error('Could not disconnect', err.message);
    } finally {
      this.busyOrg = null;
    }
  }
  async refreshStatus(e) {
    const id = e.currentTarget.dataset.id;
    this.busyOrg = id;
    try {
      const s = await Api.orgStatus(id);
      this.orgs = this.orgs.map((o) => (o.id === id ? { ...o, status: s?.status || o.status, username: s?.identity?.username || o.username } : o));
      toast.info(`Status: ${s?.status}`);
    } catch (err) {
      toast.error('Status check failed', err.message);
    } finally {
      this.busyOrg = null;
    }
  }
  async toggleProtected(e) {
    const id = e.currentTarget.dataset.id;
    const org = this.orgs.find((o) => o.id === id);
    if (!org) return;
    if (org.protected && org.kind === 'production') {
      toast.warning('Production orgs are always protected');
      return;
    }
    this.busyOrg = id;
    try {
      const updated = await Api.updateOrg(id, { protected: !org.protected });
      this.orgs = this.orgs.map((o) => (o.id === id ? { ...o, ...(updated || {}), protected: updated?.protected ?? !org.protected } : o));
      toast.success((updated?.protected ?? !org.protected) ? `${org.label} is now protected` : `${org.label} is no longer protected`);
    } catch (err) {
      toast.error('Could not update org', err.message);
    } finally {
      this.busyOrg = null;
    }
  }
  toggleLimits(e) {
    const id = e.currentTarget.dataset.id;
    const next = new Set(this.limitsOpen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.limitsOpen = next;
  }
  async remove(e) {
    const id = e.currentTarget.dataset.id;
    const org = this.orgs.find((o) => o.id === id);
    if (!org) return;
    if (
      !(await confirm({
        title: `Delete ${org.label}?`,
        message: 'Only possible when no session used this org. The connection is revoked first.',
        confirmLabel: 'Delete org',
        danger: true,
      }))
    )
      return;
    this.busyOrg = id;
    try {
      await Api.deleteOrg(id);
      toast.success('Org deleted');
      await this.load();
    } catch (err) {
      toast.error('Could not delete org', err.message);
    } finally {
      this.busyOrg = null;
    }
  }
}
