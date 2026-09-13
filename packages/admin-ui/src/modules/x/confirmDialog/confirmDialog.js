import { LightningElement } from 'lwc';
import { confirmStore } from '../../../lib/store.js';
export default class ConfirmDialog extends LightningElement {
  static renderMode = 'light';
  state = null;
  _unsub;
  connectedCallback() {
    this._unsub = confirmStore.subscribe((s) => {
      this.state = s;
    });
  }
  disconnectedCallback() {
    this._unsub?.();
  }
  get open() {
    return !!this.state;
  }
  get title() {
    return this.state?.title || '';
  }
  get message() {
    return this.state?.message || '';
  }
  get confirmLabel() {
    return this.state?.confirmLabel || 'Confirm';
  }
  get cancelLabel() {
    return this.state?.cancelLabel || 'Cancel';
  }
  get confirmCls() {
    return this.state?.danger ? 'btn-danger' : 'btn-primary';
  }
  get iconCls() {
    return `mb-3 flex h-10 w-10 items-center justify-center rounded-full ${this.state?.danger ? 'bg-rose-500/15 text-rose-700' : 'bg-brand-500/15 text-brand-600'}`;
  }
  get iconName() {
    return this.state?.danger ? 'warning' : 'info';
  }
  yes() {
    this.state?.resolve(true);
  }
  no() {
    this.state?.resolve(false);
  }
}
