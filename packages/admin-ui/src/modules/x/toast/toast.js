import { LightningElement } from 'lwc';
import { toastStore, dismissToast } from '../../../lib/store.js';
export default class Toast extends LightningElement {
  static renderMode = 'light';
  toasts = [];
  _unsub;
  connectedCallback() {
    this._unsub = toastStore.subscribe((list) => {
      this.toasts = list;
    });
  }
  disconnectedCallback() {
    this._unsub?.();
  }
  get items() {
    const tone = {
      success: 'border-emerald-500/40 text-emerald-700',
      error: 'border-rose-500/40 text-rose-700',
      warning: 'border-amber-500/40 text-amber-700',
      info: 'border-sky-500/40 text-sky-700',
    };
    const icon = { success: 'check', error: 'error', warning: 'warning', info: 'info' };
    return this.toasts.map((t) => ({
      ...t,
      cls: `pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-xl border bg-surface p-3.5 shadow-xl backdrop-blur ${tone[t.kind] || tone.info}`,
      icon: icon[t.kind] || 'info',
    }));
  }
  dismiss(e) {
    dismissToast(Number(e.currentTarget.dataset.id));
  }
}
