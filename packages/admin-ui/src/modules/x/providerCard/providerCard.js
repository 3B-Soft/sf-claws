import { LightningElement, api } from 'lwc';
import { Api } from '../../../lib/api.js';
import { toast } from '../../../lib/store.js';
import { fmtRelative } from '../../../lib/format.js';
import { PROVIDER_META } from '../../../lib/constants.js';

/** One AI provider: key status, set/replace key + optional base URL, test connection. */
export default class ProviderCard extends LightningElement {
  static renderMode = 'light';
  @api provider = 'anthropic';
  @api credential; // ProviderCredential | undefined
  editing = false;
  apiKey = '';
  baseUrl = '';
  busy = false;
  testing = false;
  testResult = null;

  get meta() {
    return PROVIDER_META[this.provider] || PROVIDER_META.anthropic;
  }
  get label() {
    return this.meta.label;
  }
  get desc() {
    return this.meta.desc;
  }
  get placeholder() {
    return this.meta.placeholder;
  }
  get hasKey() {
    return !!this.credential?.hasKey;
  }
  get statusValue() {
    return this.hasKey ? 'configured' : 'missing';
  }
  get statusColor() {
    return this.hasKey ? 'emerald' : 'amber';
  }
  get statusLabel() {
    return this.hasKey ? 'Key configured' : 'No key';
  }
  get updated() {
    return this.credential?.updatedAt ? `Updated ${fmtRelative(this.credential.updatedAt)}` : '';
  }
  get currentBaseUrl() {
    return this.credential?.baseUrl || 'Default endpoint';
  }
  get badgeCls() {
    return `flex h-10 w-10 items-center justify-center rounded-lg text-xs font-bold ${this.meta.badgeCls}`;
  }
  get badgeText() {
    return this.meta.badge;
  }
  get editLabel() {
    return this.hasKey ? 'Replace key' : 'Set key';
  }
  get cannotSave() {
    return this.busy || !this.apiKey.trim();
  }
  get testCls() {
    return `mt-3 rounded-lg border px-3 py-2 text-xs ${this.testResult?.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/30 bg-rose-500/10 text-rose-700'}`;
  }
  get testMessage() {
    return this.testResult?.message || (this.testResult?.ok ? 'Connection OK' : 'Connection failed');
  }

  startEdit() {
    this.editing = true;
    this.apiKey = '';
    this.baseUrl = this.credential?.baseUrl || '';
  }
  cancel() {
    this.editing = false;
    this.apiKey = '';
  }
  handleKey(e) {
    this.apiKey = e.detail.value;
  }
  handleBase(e) {
    this.baseUrl = e.detail.value;
  }
  async save() {
    this.busy = true;
    try {
      const body = { apiKey: this.apiKey.trim() };
      if (this.baseUrl.trim()) body.baseUrl = this.baseUrl.trim();
      else body.baseUrl = null;
      await Api.setProvider(this.provider, body);
      toast.success(`${this.label} key saved`);
      this.editing = false;
      this.apiKey = '';
      this.dispatchEvent(new CustomEvent('changed'));
    } catch (err) {
      toast.error('Could not save key', err.message);
    } finally {
      this.busy = false;
    }
  }
  async test() {
    this.testing = true;
    this.testResult = null;
    try {
      const r = await Api.testProvider(this.provider);
      this.testResult = { ok: r?.ok !== false, message: r?.message };
    } catch (err) {
      this.testResult = { ok: false, message: err.message };
    } finally {
      this.testing = false;
    }
  }
}
