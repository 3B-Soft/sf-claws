import { LightningElement, api } from 'lwc';
import { Api, getApiBase, setApiBase, setToken } from '../../../lib/api.js';
import { toast } from '../../../lib/store.js';
import { fmtDate } from '../../../lib/format.js';

/** Profile (PATCH /auth/me), uiMode toggle, change password (POST /auth/change-password), API base URL override. */
export default class SettingsPage extends LightningElement {
  static renderMode = 'light';
  @api user;
  displayName = '';
  uiMode = 'visual';
  apiBase = '';
  busy = false;
  pwBusy = false;
  pw = { currentPassword: '', newPassword: '', confirm: '' };
  _init = false;

  connectedCallback() {
    this.apiBase = getApiBase();
  }
  renderedCallback() {
    if (!this._init && this.user) {
      this._init = true;
      this.displayName = this.user.displayName || '';
      this.uiMode = this.user.uiMode || 'visual';
    }
  }

  get isPro() {
    return this.uiMode === 'pro';
  }
  get createdAt() {
    return fmtDate(this.user?.createdAt);
  }
  get approvedAt() {
    return fmtDate(this.user?.approvedAt);
  }
  get lastSeenAt() {
    return fmtDate(this.user?.lastSeenAt);
  }
  get email() {
    return this.user?.email || '';
  }
  get role() {
    return this.user?.role || '';
  }
  get status() {
    return this.user?.status || '';
  }
  get dirty() {
    return this.displayName.trim() !== (this.user?.displayName || '') || this.uiMode !== (this.user?.uiMode || 'visual');
  }
  get cannotSave() {
    return this.busy || !this.dirty || !this.displayName.trim();
  }
  get proHint() {
    return this.isPro
      ? 'Pro mode: raw XML, JSON events and SOQL editors are shown in sessions and in the extension.'
      : 'Visual mode: friendly cards and tables. Switch to Pro to see raw XML/JSON/SOQL.';
  }
  get apiBaseHint() {
    return 'Leave empty to use the same origin (the Vite dev server proxies /api to :8787). Applies after reload.';
  }
  get pwError() {
    return this.pw.confirm && this.pw.confirm !== this.pw.newPassword ? 'Passwords do not match' : '';
  }
  get cannotChangePw() {
    return this.pwBusy || !this.pw.currentPassword || this.pw.newPassword.length < 10 || this.pw.newPassword !== this.pw.confirm;
  }

  handleName(e) {
    this.displayName = e.detail.value;
  }
  toggleMode(e) {
    this.uiMode = e.detail.value ? 'pro' : 'visual';
  }
  handleApiBase(e) {
    this.apiBase = e.detail.value;
  }
  handlePw(e) {
    this.pw = { ...this.pw, [e.detail.name]: e.detail.value };
  }

  async save() {
    this.busy = true;
    try {
      const patch = {};
      if (this.displayName.trim() !== this.user.displayName) patch.displayName = this.displayName.trim();
      if (this.uiMode !== this.user.uiMode) patch.uiMode = this.uiMode;
      const updated = await Api.patchMe(patch);
      this.dispatchEvent(new CustomEvent('userupdated', { detail: { user: { ...this.user, ...patch, ...(updated?.id ? updated : {}) } } }));
      toast.success('Profile saved');
    } catch (err) {
      toast.error('Could not save profile', err.message);
    } finally {
      this.busy = false;
    }
  }
  async changePassword(e) {
    e.preventDefault();
    if (this.cannotChangePw) return;
    this.pwBusy = true;
    try {
      await Api.changePassword({ currentPassword: this.pw.currentPassword, newPassword: this.pw.newPassword });
      this.pw = { currentPassword: '', newPassword: '', confirm: '' };
      // The server revokes every token for the user (including this one): send them back to sign in.
      setToken(null);
      toast.success('Password updated', 'Please sign in again with your new password.');
      this.dispatchEvent(new CustomEvent('signedout', { bubbles: true }));
    } catch (err) {
      toast.error('Could not change password', err.message);
    } finally {
      this.pwBusy = false;
    }
  }
  saveApiBase() {
    setApiBase(this.apiBase.trim());
    toast.success('API base saved', 'Reload the page to apply.');
  }
  reload() {
    window.location.reload();
  }
}
