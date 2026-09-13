import { LightningElement, api } from 'lwc';
import { initials } from '../../../lib/format.js';
import { getApiBase } from '../../../lib/api.js';
export default class Topbar extends LightningElement {
  static renderMode = 'light';
  @api user;
  @api route;
  menuOpen = false;
  _outside = (e) => {
    const menu = this.querySelector('[data-user-menu]');
    if (menu && !menu.contains(e.target)) this.menuOpen = false;
  };
  connectedCallback() {
    document.addEventListener('click', this._outside);
  }
  disconnectedCallback() {
    document.removeEventListener('click', this._outside);
  }
  get initials() {
    return initials(this.user?.displayName || this.user?.email);
  }
  get name() {
    return this.user?.displayName || this.user?.email || '';
  }
  get role() {
    return this.user?.role || '';
  }
  get uiMode() {
    return this.user?.uiMode || 'visual';
  }
  get apiBase() {
    return getApiBase() || 'same origin';
  }
  get title() {
    const map = {
      dashboard: 'Dashboard',
      users: 'Users',
      ai: 'AI models',
      clients: 'Clients',
      client: 'Client',
      skills: 'Skills',
      skill: 'Skill',
      sessions: 'Sessions',
      session: 'Session',
      usage: 'Usage',
      audit: 'Audit log',
      settings: 'Settings',
      pair: 'Pair extension',
      oauthResult: 'Salesforce connection',
      policy: 'Global policy',
    };
    return map[this.route?.name] || '';
  }
  toggleMenu(e) {
    e.stopPropagation();
    this.menuOpen = !this.menuOpen;
  }
  openMenu() {
    this.dispatchEvent(new CustomEvent('menu'));
  }
  logout() {
    this.menuOpen = false;
    this.dispatchEvent(new CustomEvent('logout'));
  }
  closeMenu() {
    this.menuOpen = false;
  }
}
