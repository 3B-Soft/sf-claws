import { LightningElement } from 'lwc';
import { appStore, saveServerUrl, api as http, boot } from '../../../lib/state.js';
import { normalizeServerUrl } from '../../../lib/storage.js';
import { ensureHostPermission, hasChrome } from '../../../lib/bridge.js';

export default class SetupScreen extends LightningElement {
  static renderMode = 'light';
  url = '';
  busy = false;
  step = ''; // '' | permission | health | done
  error = '';
  health = null;
  granted = null;

  connectedCallback() {
    this.url = appStore.get().serverUrl || '';
  }

  get normalized() {
    return normalizeServerUrl(this.url);
  }
  get canContinue() {
    return !!this.normalized && !this.busy;
  }
  get disabledContinue() {
    return !this.canContinue;
  }
  get isChrome() {
    return hasChrome;
  }
  get healthOk() {
    return !!this.health?.ok;
  }
  get healthVersion() {
    return this.health?.version ? `v${this.health.version}` : '';
  }
  get setupRequired() {
    return !!this.health?.setupRequired;
  }
  get stepPermission() {
    return this.step === 'permission';
  }
  get stepHealth() {
    return this.step === 'health';
  }
  get permissionDenied() {
    return this.granted === false;
  }
  get buttonLabel() {
    return this.busy ? (this.step === 'permission' ? 'Waiting for permission…' : 'Checking server…') : 'Connect';
  }

  onInput(e) {
    this.url = e.target.value;
    this.error = '';
  }
  onKey(e) {
    if (e.key === 'Enter' && this.canContinue) this.onContinue();
  }

  async onContinue() {
    const normalized = this.normalized;
    if (!normalized) {
      this.error = 'Enter a valid URL like https://harness.example.com';
      return;
    }
    this.busy = true;
    this.error = '';
    this.health = null;
    this.granted = null;
    try {
      await saveServerUrl(normalized);
      this.step = 'permission';
      this.granted = await ensureHostPermission(normalized);
      if (!this.granted) {
        this.error = 'Permission to reach the server was not granted. Click Connect and accept the Chrome prompt.';
        return;
      }
      this.step = 'health';
      this.health = await http.health();
      if (!this.health?.ok) {
        this.error = 'Server responded but reports it is not healthy.';
        return;
      }
      this.step = 'done';
      appStore.set({ hostPermission: true, health: this.health });
      await boot();
    } catch (e) {
      this.error = e.isNetwork ? `Cannot reach ${normalized}. Check the URL and that the server is running.` : e.message || 'Something went wrong';
    } finally {
      this.busy = false;
    }
  }
}
