import { LightningElement, api } from 'lwc';
import { prefsStore } from '../../../lib/store.js';
export default class Shell extends LightningElement {
  static renderMode = 'light';
  @api user;
  @api route;
  collapsed = false;
  mobileOpen = false;
  _unsub;
  connectedCallback() {
    this._unsub = prefsStore.subscribe((p) => {
      this.collapsed = !!p.sidebarCollapsed;
    });
  }
  disconnectedCallback() {
    this._unsub?.();
  }
  get mainCls() {
    return `flex min-h-screen flex-1 flex-col transition-[margin] duration-200 ${this.collapsed ? 'lg:ml-[4.5rem]' : 'lg:ml-64'}`;
  }
  toggleCollapse() {
    prefsStore.update((p) => ({ ...p, sidebarCollapsed: !p.sidebarCollapsed }));
  }
  openMobile() {
    this.mobileOpen = true;
  }
  closeMobile() {
    this.mobileOpen = false;
  }
  handleNavigate() {
    this.mobileOpen = false;
  }
  logout() {
    this.dispatchEvent(new CustomEvent('logout'));
  }
}
