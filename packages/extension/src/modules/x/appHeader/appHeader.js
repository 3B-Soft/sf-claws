import { LightningElement } from 'lwc';
import { appStore, setUiMode, logout, refreshOrg } from '../../../lib/state.js';
import { sessionStore } from '../../../lib/sessionController.js';
import { openOptions, openTab } from '../../../lib/bridge.js';
import { initials, kindClass, statusClass, statusLabel, fmtTokens, fmtUsd } from '../../../lib/format.js';

export default class AppHeader extends LightningElement {
  static renderMode = 'light';
  state = appStore.get();
  session = sessionStore.get();
  menuOpen = false;
  _unsubs = [];
  connectedCallback() {
    this._unsubs.push(
      appStore.subscribe((s) => {
        this.state = s;
      }),
    );
    this._unsubs.push(
      sessionStore.subscribe((s) => {
        this.session = s;
      }),
    );
    this._onDoc = (e) => {
      if (this.menuOpen && !this.contains(e.target)) this.menuOpen = false;
    };
    document.addEventListener('click', this._onDoc, true);
  }
  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
    document.removeEventListener('click', this._onDoc, true);
  }

  get org() {
    return this.state.org;
  }
  get client() {
    return this.state.client;
  }
  get hasOrg() {
    return this.state.orgState === 'resolved' && !!this.org;
  }
  get clientName() {
    return this.client?.name || '';
  }
  get orgLabel() {
    return this.org?.label || '';
  }
  get orgKind() {
    return this.org?.kind || '';
  }
  get kindCls() {
    return kindClass(this.org?.kind);
  }
  get orgStatusCls() {
    return statusClass(this.org?.status);
  }
  get orgStatusLabel() {
    return statusLabel(this.org?.status);
  }
  get isProtected() {
    return !!this.org?.protected;
  }
  get hostName() {
    return this.state.context?.host || '';
  }
  get contextLabel() {
    return this.state.context?.isSalesforce ? this.state.context.label : '';
  }
  get hasContext() {
    return !!this.contextLabel;
  }
  get showContextRow() {
    return this.hasContext || this.hasOrg;
  }
  get contextDotCls() {
    const k = this.state.context?.kind;
    const c =
      { record: 'bg-sky-400', list: 'bg-sky-400', setup: 'bg-violet-400', flow: 'bg-fuchsia-400', flexipage: 'bg-brand-400', home: 'bg-content-subtle' }[k] ||
      'bg-content-subtle';
    return `h-1.5 w-1.5 shrink-0 rounded-full ${c}`;
  }
  get contextTitle() {
    return this.state.context?.url || '';
  }
  get user() {
    return this.state.user;
  }
  get userInitials() {
    return initials(this.user?.displayName || this.user?.email);
  }
  get userName() {
    return this.user?.displayName || '';
  }
  get userEmail() {
    return this.user?.email || '';
  }
  get userRole() {
    return this.user?.role || '';
  }
  get isPro() {
    return this.state.uiMode === 'pro';
  }
  get visualCls() {
    return `flex-1 rounded-md px-2 py-1 text-[11px] font-medium ${this.isPro ? 'text-content-muted hover:text-content' : 'bg-brand-500 text-white'}`;
  }
  get proCls() {
    return `flex-1 rounded-md px-2 py-1 text-[11px] font-medium ${this.isPro ? 'bg-brand-500 text-white' : 'text-content-muted hover:text-content'}`;
  }
  get modeBadge() {
    return this.isPro ? 'PRO' : '';
  }
  get usage() {
    return this.session.usage;
  }
  get hasSession() {
    return !!this.session.sessionId;
  }
  get usageText() {
    const u = this.usage || {};
    return `${fmtTokens((u.inputTokens || 0) + (u.outputTokens || 0))} tok · ${fmtUsd(u.costUsd)}`;
  }
  /** Set when a spend ceiling stopped the run — the user needs to know why work halted. */
  get costLimit() {
    return this.session.costLimit;
  }
  get hasCostLimit() {
    return !!this.costLimit;
  }
  get costLimitText() {
    const c = this.costLimit;
    if (!c) return '';
    const scope = c.scope === 'turn' ? 'this request' : c.scope === 'session' ? 'this session' : 'this client this month';
    return `Spend ceiling reached for ${scope}: ${fmtUsd(c.spentUsd)} of ${fmtUsd(c.limitUsd)}. An admin can raise it, then you can resume.`;
  }

  get connectionCls() {
    const c = this.session.connection;
    const color =
      c === 'open'
        ? 'bg-emerald-400'
        : c === 'connecting' || c === 'reconnecting'
          ? 'bg-amber-400 pulse-dot'
          : c === 'error'
            ? 'bg-rose-400'
            : 'bg-line-strong';
    return `h-1.5 w-1.5 rounded-full ${color}`;
  }
  get connectionTitle() {
    return `Event stream: ${this.session.connection}`;
  }
  get serverUrl() {
    return this.state.serverUrl;
  }

  onToggleMenu(e) {
    e.stopPropagation();
    this.menuOpen = !this.menuOpen;
  }
  onVisual() {
    setUiMode('visual');
  }
  onPro() {
    setUiMode('pro');
  }
  onOptions() {
    this.menuOpen = false;
    openOptions();
  }
  onAdmin() {
    this.menuOpen = false;
    openTab(this.serverUrl);
  }
  onLogout() {
    this.menuOpen = false;
    logout();
  }
  onRefreshOrg() {
    refreshOrg();
  }
  onOpenOrg() {
    if (this.org?.instanceUrl) openTab(this.org.instanceUrl);
  }
}
