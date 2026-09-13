import { LightningElement, api } from 'lwc';
import { appStore, api as http, setAuth, setUser, logout, clearAuth } from '../../../lib/state.js';
import { openTab } from '../../../lib/bridge.js';

const POLL_MS = 2000;

export default class LoginScreen extends LightningElement {
  static renderMode = 'light';
  @api pending = false;
  mode = 'device'; // device | password
  device = null; // { code, expiresAt, verifyUrl }
  polling = false;
  error = '';
  busy = false;
  email = '';
  password = '';
  expired = false;
  _timer = null;
  _unsub = null;
  user = null;

  connectedCallback() {
    this._unsub = appStore.subscribe((s) => {
      this.user = s.user;
    });
    if (!this.pending) this.startDevice();
  }
  disconnectedCallback() {
    this.stopPolling();
    this._unsub?.();
  }

  get serverUrl() {
    return appStore.get().serverUrl;
  }
  get isDevice() {
    return this.mode === 'device' && !this.pending;
  }
  get isPassword() {
    return this.mode === 'password' && !this.pending;
  }
  get code() {
    return this.device?.code || '';
  }
  get codeChars() {
    return this.code.split('').map((c, i) => ({ i, c }));
  }
  get verifyUrl() {
    if (this.device?.verifyUrl) return this.device.verifyUrl;
    return `${this.serverUrl}/pair?code=${encodeURIComponent(this.code)}`;
  }
  get pendingName() {
    return this.user?.displayName || this.user?.email || 'your account';
  }
  get pendingEmail() {
    return this.user?.email || '';
  }
  get loginDisabled() {
    return this.busy || !this.email || !this.password;
  }
  get loginLabel() {
    return this.busy ? 'Signing in…' : 'Sign in';
  }
  get deviceButtonLabel() {
    return this.busy && !this.device ? 'Requesting code…' : 'Open admin to approve';
  }
  get openDisabled() {
    return !this.code || this.busy;
  }

  async startDevice() {
    this.stopPolling();
    this.error = '';
    this.expired = false;
    this.busy = true;
    this.device = null;
    try {
      const d = await http.deviceStart();
      this.device = d;
      this.startPolling();
    } catch (e) {
      this.error = e.isNotFound ? 'Device pairing is not available on this server. Use email & password.' : e.message;
      if (e.isNotFound) this.mode = 'password';
    } finally {
      this.busy = false;
    }
  }

  startPolling() {
    this.polling = true;
    const tick = async () => {
      if (!this.polling || !this.device) return;
      if (this.device.expiresAt && new Date(this.device.expiresAt).getTime() < Date.now()) {
        this.expired = true;
        this.stopPolling();
        return;
      }
      try {
        const auth = await http.devicePoll(this.device.code);
        if (auth) {
          this.stopPolling();
          await setAuth(auth);
          return;
        }
      } catch (e) {
        if (e.status === 404 || e.status === 410) {
          this.expired = true;
          this.stopPolling();
          return;
        }
        // network errors: keep polling
      }
      this._timer = setTimeout(tick, POLL_MS);
    };
    this._timer = setTimeout(tick, POLL_MS);
  }
  stopPolling() {
    this.polling = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  onOpenAdmin() {
    if (this.code) openTab(this.verifyUrl);
  }
  onNewCode() {
    this.startDevice();
  }
  onUsePassword() {
    this.stopPolling();
    this.mode = 'password';
    this.error = '';
  }
  onUseDevice() {
    this.mode = 'device';
    this.startDevice();
  }
  onEmail(e) {
    this.email = e.target.value;
  }
  onPassword(e) {
    this.password = e.target.value;
  }
  onKey(e) {
    if (e.key === 'Enter' && !this.loginDisabled) this.onLogin();
  }
  async onLogin() {
    this.busy = true;
    this.error = '';
    try {
      const auth = await http.login(this.email.trim(), this.password);
      await setAuth(auth);
    } catch (e) {
      this.error =
        e.status === 401 || e.status === 400 ? 'Invalid email or password.' : e.status === 403 ? e.message || 'Your account is not approved yet.' : e.message;
    } finally {
      this.busy = false;
    }
  }
  async onCheckApproval() {
    this.busy = true;
    this.error = '';
    try {
      const user = await http.me();
      await setUser(user);
      if (user.status === 'pending') this.error = 'Still waiting for an admin to approve your account.';
    } catch (e) {
      this.error = e.message;
    } finally {
      this.busy = false;
    }
  }
  onLogout() {
    logout();
  }
  onChangeServer() {
    clearAuth().then(() => appStore.set({ screen: 'setup' }));
  }
}
