import { LightningElement, api } from 'lwc';
/** Modal dialog. Slots: default (body), footer. Emits 'close'. */
export default class Modal extends LightningElement {
  static renderMode = 'light';
  @api open = false;
  @api title = '';
  @api subtitle = '';
  @api size = 'md'; // sm | md | lg | xl | full
  @api hideFooter = false;
  _keyHandler = (e) => {
    if (e.key === 'Escape' && this.open) this.close();
  };
  connectedCallback() {
    window.addEventListener('keydown', this._keyHandler);
  }
  disconnectedCallback() {
    window.removeEventListener('keydown', this._keyHandler);
  }
  get panelCls() {
    const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl', full: 'max-w-[96vw]' };
    return `card relative flex max-h-[90vh] w-full ${sizes[this.size] || sizes.md} flex-col overflow-hidden bg-surface shadow-2xl ring-1 ring-black/40`;
  }
  get footerCls() {
    return `border-t border-line bg-surface px-5 py-3 ${this.hideFooter ? 'hidden' : ''}`;
  }
  close() {
    this.dispatchEvent(new CustomEvent('close'));
  }
  stop(e) {
    e.stopPropagation();
  }
}
