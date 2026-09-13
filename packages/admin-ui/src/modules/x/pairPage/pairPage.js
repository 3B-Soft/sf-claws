import { LightningElement, api } from 'lwc';
import { Api } from '../../../lib/api.js';
import { toast } from '../../../lib/store.js';
import { setQuery } from '../../../lib/router.js';

/** Device pairing: approves an extension login code via POST /auth/device/approve { code }. */
export default class PairPage extends LightningElement {
  static renderMode = 'light';
  @api user;
  @api query = {};
  codeInput = '';
  busy = false;
  done = false;
  error = null;
  _lastCode;

  /** `/pair?code=XXXX` (server redirect) keeps the code in location.search; `#/pair?code=` keeps it in the hash query. */
  get searchCode() {
    try {
      return new URLSearchParams(window.location.search).get('code') || '';
    } catch {
      return '';
    }
  }
  get routeCode() {
    return String(this.query?.code || this.searchCode || '').trim();
  }
  get code() {
    return String(this.routeCode || this.codeInput || '')
      .trim()
      .toUpperCase();
  }
  get hasCode() {
    return !!this.routeCode;
  }
  get displayCode() {
    const c = this.code;
    return c.length > 4 ? `${c.slice(0, Math.ceil(c.length / 2))}-${c.slice(Math.ceil(c.length / 2))}` : c;
  }
  get userName() {
    return this.user?.displayName || this.user?.email || '';
  }
  get errorMessage() {
    return this.error?.message || '';
  }
  get canApprove() {
    return !this.busy && this.code.length >= 4;
  }
  get cannotContinue() {
    return this.codeInput.trim().length < 4;
  }
  handleCode(e) {
    this.codeInput = e.detail.value.toUpperCase();
    this.error = null;
  }
  submitCode(e) {
    e.preventDefault();
    if (this.codeInput) setQuery({ code: this.codeInput.trim() });
  }

  async approve() {
    this.busy = true;
    this.error = null;
    try {
      await Api.deviceApprove(this.code);
      this.done = true;
      toast.success('Extension paired', 'You can return to the Chrome side panel.');
    } catch (err) {
      this.error = err;
    } finally {
      this.busy = false;
    }
  }
  reset() {
    this.done = false;
    this.error = null;
    this.codeInput = '';
    if (this.searchCode) {
      try {
        window.history.replaceState(null, '', window.location.pathname + '#/pair');
      } catch {
        /* ignore */
      }
    }
    setQuery({ code: undefined });
  }
}
