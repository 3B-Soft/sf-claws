import { LightningElement, api } from 'lwc';
export default class ErrorState extends LightningElement {
  static renderMode = 'light';
  @api title = 'Something went wrong';
  @api error; // Error | string
  @api compact = false;
  get message() {
    return typeof this.error === 'string' ? this.error : this.error?.message || 'Unknown error';
  }
  get code() {
    return this.error?.code && this.error.code !== 'UNKNOWN' ? this.error.code : null;
  }
  get isNetwork() {
    return this.error?.status === 0;
  }
  get cls() {
    return this.compact
      ? 'flex items-start gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm'
      : 'flex flex-col items-center rounded-xl border border-rose-500/30 bg-rose-500/5 px-6 py-10 text-center';
  }
  retry() {
    this.dispatchEvent(new CustomEvent('retry'));
  }
}
