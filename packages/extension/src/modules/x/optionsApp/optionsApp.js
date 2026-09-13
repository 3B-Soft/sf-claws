import { LightningElement } from 'lwc';
import { storage, KEYS, normalizeServerUrl } from '../../../lib/storage.js';
import { ensureHostPermission, hasChrome } from '../../../lib/bridge.js';
import { createApi } from '../../../lib/api.js';

export default class OptionsApp extends LightningElement {
  static renderMode = 'light';
  serverUrl = '';
  uiMode = 'visual';
  notifications = true;
  hasToken = false;
  user = null;
  msg = '';
  msgTone = 'emerald';
  health = null;
  busy = false;
  version = '0.1.0';

  async connectedCallback() {
    this.serverUrl = (await storage.sync.get(KEYS.serverUrl, '')) || '';
    this.uiMode = (await storage.sync.get(KEYS.uiMode, 'visual')) || 'visual';
    this.notifications = (await storage.sync.get(KEYS.notifications, true)) !== false;
    this.hasToken = !!(await storage.local.get(KEYS.token, null));
    this.user = await storage.local.get(KEYS.user, null);
    try {
      this.version = chrome.runtime.getManifest().version;
    } catch {
      /* web mode */
    }
  }
  get isVisual() {
    return this.uiMode !== 'pro';
  }
  get isPro() {
    return this.uiMode === 'pro';
  }
  get userLabel() {
    return this.user ? `${this.user.displayName || ''} <${this.user.email || ''}>` : 'Not signed in';
  }
  get msgCls() {
    return `mt-3 rounded-lg border px-3 py-2 text-[12px] ${this.msgTone === 'rose' ? 'border-rose-500/30 bg-rose-500/10 text-rose-700' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'}`;
  }
  get healthText() {
    return this.health ? `Server OK (v${this.health.version})` : '';
  }
  get isChrome() {
    return hasChrome;
  }
  get noToken() {
    return !this.hasToken;
  }
  get visualBtn() {
    return `rounded-md px-3 py-1 text-[12px] font-medium ${this.isVisual ? 'bg-brand-500 text-white' : 'text-content-muted hover:text-content'}`;
  }
  get proBtn() {
    return `rounded-md px-3 py-1 text-[12px] font-medium ${this.isPro ? 'bg-brand-500 text-white' : 'text-content-muted hover:text-content'}`;
  }

  onUrl(e) {
    this.serverUrl = e.target.value;
  }
  async onSave() {
    const n = normalizeServerUrl(this.serverUrl);
    if (!n) {
      this.flash('Enter a valid URL', 'rose');
      return;
    }
    this.busy = true;
    try {
      await storage.sync.set(KEYS.serverUrl, n);
      this.serverUrl = n;
      const granted = await ensureHostPermission(n);
      if (!granted) {
        this.flash('Saved, but host permission was not granted.', 'rose');
        return;
      }
      const client = createApi({ getBaseUrl: () => n, getToken: () => null });
      this.health = await client.health();
      this.flash(`Saved. ${this.healthText}`);
    } catch (e) {
      this.flash(`Saved, but the server could not be reached: ${e.message}`, 'rose');
    } finally {
      this.busy = false;
    }
  }
  async onMode(e) {
    this.uiMode = e.currentTarget.dataset.mode;
    await storage.sync.set(KEYS.uiMode, this.uiMode);
    this.flash(`Default interface set to ${this.uiMode}.`);
  }
  async onNotifications(e) {
    this.notifications = !!e.target.checked;
    await storage.sync.set(KEYS.notifications, this.notifications);
    this.flash(this.notifications ? 'You will be notified when an approval card is waiting.' : 'Notifications off. The icon badge still shows the count.');
  }
  async onClearLogin() {
    await storage.local.remove(KEYS.token);
    await storage.local.remove(KEYS.user);
    await storage.local.remove(KEYS.lastSessionByOrg);
    this.hasToken = false;
    this.user = null;
    this.flash('Login cleared. Open the side panel to sign in again.');
  }
  flash(msg, tone = 'emerald') {
    this.msg = msg;
    this.msgTone = tone;
  }
}
