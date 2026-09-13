import { LightningElement, api } from 'lwc';
import { appStore, api as http } from '../../../lib/state.js';
import { asList } from '../../../lib/api.js';
import { fmtRelative, statusClass, statusLabel, fmtUsd, truncate } from '../../../lib/format.js';
import { quickActionsFor } from '../../../lib/context.js';
import { getCachedSessionList, putCachedSessionList, pruneSnapshots } from '../../../lib/cache.js';

export default class SessionList extends LightningElement {
  static renderMode = 'light';
  @api creating = false;
  @api error = '';
  @api canback = false;
  sessions = [];
  loading = true;
  loadError = '';
  fromCache = false;
  cachedAt = null;
  state = appStore.get();
  _unsub = null;
  _lastTick = -1;

  connectedCallback() {
    this._unsub = appStore.subscribe((s) => {
      const orgChanged = this.state.org?.id !== s.org?.id;
      this.state = s;
      if (orgChanged || s.reloadTick !== this._lastTick) {
        this._lastTick = s.reloadTick;
        this.load();
      }
    });
  }
  disconnectedCallback() {
    this._unsub?.();
  }

  async load() {
    const org = this.state.org;
    if (!org) return;
    this.loading = true;
    this.loadError = '';
    // Render the cached list for this org immediately, then refresh from the server.
    try {
      const cached = await getCachedSessionList(org.id);
      if (cached?.items?.length && this.state.org?.id === org.id) {
        this.sessions = cached.items;
        this.fromCache = true;
        this.cachedAt = cached.cachedAt;
        this.loading = false;
      }
    } catch {
      /* ignore */
    }
    try {
      const list = asList(await http.listSessions({ mine: 1, orgId: org.id }));
      if (this.state.org?.id !== org.id) return;
      this.sessions = list
        .filter((s) => !s.orgId || s.orgId === org.id)
        .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
      this.fromCache = false;
      this.cachedAt = null;
      putCachedSessionList(org.id, this.sessions);
      pruneSnapshots(this.sessions.map((s) => s.id));
    } catch (e) {
      if (!(e.isNetwork && this.fromCache)) this.loadError = e.message;
    } finally {
      this.loading = false;
    }
  }
  get cacheNote() {
    return this.fromCache ? `Offline — showing sessions cached ${fmtRelative(this.cachedAt)}` : '';
  }

  get rows() {
    return this.sessions.map((s) => ({
      id: s.id,
      title: s.title || 'Untitled session',
      when: fmtRelative(s.updatedAt || s.createdAt),
      statusCls: statusClass(s.status),
      statusLabel: statusLabel(s.status),
      cost: s.costUsd ? fmtUsd(s.costUsd) : '',
      helpful: s.helpful === true,
      unhelpful: s.helpful === false,
      note: truncate(s.feedbackNote || '', 60),
      isRunning: s.status === 'running' || s.status === 'awaiting_confirmation',
    }));
  }
  get creatingLabel() {
    return this.creating ? 'Creating…' : 'New session';
  }
  get isEmpty() {
    return !this.loading && !this.loadError && this.sessions.length === 0;
  }
  get quickActions() {
    return quickActionsFor(this.state.context);
  }
  get contextHint() {
    const c = this.state.context;
    return c?.isSalesforce ? `Starting from: ${c.label}` : '';
  }
  get orgLabel() {
    return this.state.org?.label || '';
  }

  onPick(e) {
    this.dispatchEvent(new CustomEvent('select', { detail: { id: e.currentTarget.dataset.id } }));
  }
  onNew() {
    this.dispatchEvent(new CustomEvent('new'));
  }
  onBack() {
    this.dispatchEvent(new CustomEvent('select', { detail: { id: this.state.sessionId } }));
  }
  onReload() {
    this.load();
  }
}
