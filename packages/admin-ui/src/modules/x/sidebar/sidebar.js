import { LightningElement, api } from 'lwc';
import { navForUser } from '../../../lib/rbac.js';
export default class Sidebar extends LightningElement {
  static renderMode = 'light';
  @api user;
  @api route;
  @api collapsed = false;
  @api mobileOpen = false;

  get sections() {
    const active = this.route?.name;
    const activeId = active === 'client' ? 'clients' : active === 'skill' ? 'skills' : active === 'session' ? 'sessions' : active;
    return navForUser(this.user).map((s) => ({
      ...s,
      items: s.items.map((i) => ({
        ...i,
        href: '#' + i.path,
        cls: `nav-item ${i.id === activeId ? 'nav-item-active' : ''} ${this.collapsed ? 'lg:justify-center lg:px-0' : ''}`,
        title: this.collapsed ? i.label : '',
      })),
    }));
  }
  get asideCls() {
    return `fixed inset-y-0 left-0 z-40 flex flex-col border-r border-line bg-surface backdrop-blur transition-all duration-200 ${this.collapsed ? 'lg:w-[4.5rem]' : 'lg:w-64'} w-64 ${this.mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`;
  }
  get labelCls() {
    return this.collapsed ? 'lg:hidden' : '';
  }
  get sectionLabelCls() {
    return `mb-1 mt-4 px-3 text-[10px] font-semibold uppercase tracking-wider text-content-subtle first:mt-0 ${this.collapsed ? 'lg:hidden' : ''}`;
  }
  get toggleIcon() {
    return this.collapsed ? 'chevronRight' : 'chevronRight';
  }
  get toggleIconCls() {
    return `h-4 w-4 transition-transform ${this.collapsed ? '' : 'rotate-180'}`;
  }
  get roleLabel() {
    return this.user?.role || '';
  }
  toggle() {
    this.dispatchEvent(new CustomEvent('toggle'));
  }
  closeMobile() {
    this.dispatchEvent(new CustomEvent('closemobile'));
  }
  navigate() {
    this.dispatchEvent(new CustomEvent('navigate'));
  }
}
