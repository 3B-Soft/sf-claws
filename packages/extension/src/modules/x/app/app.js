import { LightningElement } from 'lwc';
import { appStore, boot, initContextTracking, setTab, retry, TABS, refreshOrg } from '../../../lib/state.js';
import { openSession, closeSession, sessionStore } from '../../../lib/sessionController.js';

export default class App extends LightningElement {
  static renderMode = 'light';
  state = appStore.get();
  session = sessionStore.get();
  _unsubs = [];

  connectedCallback() {
    this._unsubs.push(
      appStore.subscribe((s) => {
        this.state = s;
        this.syncSession();
      }),
    );
    this._unsubs.push(
      sessionStore.subscribe((s) => {
        this.session = s;
      }),
    );
    boot().then(() => initContextTracking());
  }
  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
  }

  syncSession() {
    const { sessionId, screen } = this.state;
    if (screen !== 'main') {
      if (this.session.sessionId) closeSession();
      return;
    }
    if (sessionId && sessionId !== this.session.sessionId) openSession(sessionId);
    if (!sessionId && this.session.sessionId) closeSession();
  }

  get isLoading() {
    return this.state.screen === 'loading';
  }
  get isSetup() {
    return this.state.screen === 'setup';
  }
  get isLogin() {
    return this.state.screen === 'login';
  }
  get isPending() {
    return this.state.screen === 'pending';
  }
  get isMain() {
    return this.state.screen === 'main';
  }
  get networkError() {
    return this.state.networkError;
  }
  get orgReady() {
    return this.state.orgState === 'resolved';
  }
  get orgUnregistered() {
    return this.state.orgState === 'unregistered';
  }
  get orgResolving() {
    return this.state.orgState === 'resolving';
  }
  get orgError() {
    return this.state.orgState === 'error';
  }
  get orgErrorMessage() {
    return this.state.orgError;
  }
  get noSalesforceTab() {
    return this.state.orgState === 'none';
  }
  get hostName() {
    return this.state.context?.host || '';
  }
  get pendingCount() {
    return this.session.pending?.length || 0;
  }

  get tabs() {
    const badgeFor = {
      chat: this.pendingCount,
      changes: this.session.workspace?.length || 0,
      notes: (this.session.notes?.length || 0) + (this.session.docs?.length || 0),
    };
    return TABS.map((t) => {
      const active = t.id === this.state.tab;
      return {
        ...t,
        active,
        badge: badgeFor[t.id] || 0,
        cls: `relative inline-flex flex-1 min-w-0 items-center justify-center px-2 py-2 text-[12px] font-medium rounded-lg transition-colors ${active ? 'bg-surface-sunken text-content-strong shadow-inner' : 'text-content-muted hover:text-content hover:bg-surface-sunken'}`,
        badgeCls: `ml-1 inline-flex shrink-0 min-w-[16px] h-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold ${t.id === 'chat' ? 'bg-amber-600 text-white' : 'bg-brand-500 text-white'}`,
      };
    });
  }
  get isChat() {
    return this.state.tab === 'chat';
  }
  get isChanges() {
    return this.state.tab === 'changes';
  }
  get isExplore() {
    return this.state.tab === 'explore';
  }
  get isNotes() {
    return this.state.tab === 'notes';
  }
  get isGithub() {
    return this.state.tab === 'github';
  }

  onTab(e) {
    setTab(e.currentTarget.dataset.id);
  }
  onRetry() {
    retry();
  }
  onRetryOrg() {
    refreshOrg();
  }
}
