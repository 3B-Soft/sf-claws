import { LightningElement } from 'lwc';
import { appStore, api as http } from '../../../lib/state.js';
import { sessionStore, refreshSide } from '../../../lib/sessionController.js';
import { asList } from '../../../lib/api.js';
import { fmtDate, fmtRelative, roleClass, roleLabel } from '../../../lib/format.js';

/**
 * Notes tab: agent scratchpad notes (GET /sessions/:id/notes), session documentation
 * (GET /sessions/:id/docs) and org history (GET /orgs/:orgId/docs). Markdown rendered.
 */
export default class NotesTab extends LightningElement {
  static renderMode = 'light';
  state = appStore.get();
  session = sessionStore.get();
  view = 'notes'; // notes | docs | history
  openId = null;
  orgDocs = [];
  orgDocsLoading = false;
  orgDocsError = '';
  notesError = '';
  _unsubs = [];
  _lastTick = -1;
  _orgId = null;

  connectedCallback() {
    this._unsubs.push(
      appStore.subscribe((s) => {
        const t = s.reloadTick;
        this.state = s;
        if (t !== this._lastTick || s.org?.id !== this._orgId) {
          this._lastTick = t;
          this._orgId = s.org?.id || null;
          if (this.view === 'history') this.loadOrgDocs();
        }
      }),
    );
    this._unsubs.push(
      sessionStore.subscribe((s) => {
        this.session = s;
      }),
    );
    if (this.session.sessionId) refreshSide('note.written');
  }
  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  get isNotes() {
    return this.view === 'notes';
  }
  get isDocs() {
    return this.view === 'docs';
  }
  get isHistory() {
    return this.view === 'history';
  }
  get notesCls() {
    return this.btn(this.isNotes);
  }
  get docsCls() {
    return this.btn(this.isDocs);
  }
  get historyCls() {
    return this.btn(this.isHistory);
  }
  btn(a) {
    return `rounded-lg px-3 py-1 text-[12px] font-medium ${a ? 'bg-surface-sunken text-content-strong' : 'text-content-muted hover:text-content'}`;
  }
  get hasSession() {
    return !!this.session.sessionId;
  }
  get sessionRunning() {
    return this.session.status === 'running';
  }

  // ---- scratchpad notes
  get notes() {
    return (this.session.notes || [])
      .slice()
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
      .map((n) => ({
        ...n,
        key: n.id,
        open: this.openId === n.id,
        when: fmtRelative(n.updatedAt || n.createdAt),
        roleText: roleLabel(n.role),
        roleCls: `inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${roleClass(n.role)}`,
        tagsText: (n.tags || []).map((t) => `#${t}`).join(' '),
        cls: `w-full rounded-xl border px-3 py-2 text-left ${this.openId === n.id ? 'border-violet-500/40 bg-surface' : 'border-line bg-surface hover:border-line-strong'}`,
      }));
  }
  get hasNotes() {
    return this.notes.length > 0;
  }
  get noteCount() {
    return this.notes.length;
  }

  // ---- session docs
  get docs() {
    return (this.session.docs || []).map((d) => this.decorate(d));
  }
  get hasDocs() {
    return this.docs.length > 0;
  }
  decorate(d) {
    return {
      ...d,
      key: d.id,
      when: fmtDate(d.createdAt),
      open: this.openId === d.id,
      tagsText: (d.tags || []).join(' · '),
      committed: !!d.committedSha,
      sha: String(d.committedSha || '').slice(0, 7),
      cls: `w-full rounded-xl border px-3 py-2 text-left ${this.openId === d.id ? 'border-brand-500/40 bg-surface' : 'border-line bg-surface hover:border-line-strong'}`,
    };
  }

  // ---- org history
  /**
   * Documentation from earlier sessions is the assistant's memory of this org, and the prompt tells
   * the model to read it as an observation from its time rather than current fact. The consultant
   * reading the same note deserves the same caveat, so each older note carries its age and one line
   * saying what that means.
   */
  get historyRows() {
    return this.orgDocs.map((d) => {
      const isCurrent = d.sessionId === this.session.sessionId;
      return {
        ...this.decorate(d),
        isCurrent,
        stale: !isCurrent,
        age: fmtRelative(d.createdAt),
        staleNote: `Written ${fmtRelative(d.createdAt)} — it describes the org as it was then, not as it is now.`,
      };
    });
  }
  get hasHistory() {
    return this.orgDocs.length > 0;
  }
  get historyIdle() {
    return !this.orgDocsLoading && !this.orgDocs.length && !this.orgDocsError;
  }
  get orgLabel() {
    return this.state.org?.label || 'this org';
  }

  onView(e) {
    this.view = e.currentTarget.dataset.view;
    this.openId = null;
    if (this.view === 'history' && !this.orgDocs.length) this.loadOrgDocs();
  }
  onToggle(e) {
    const id = e.currentTarget.dataset.id;
    this.openId = this.openId === id ? null : id;
  }
  onReload() {
    if (this.view === 'history') this.loadOrgDocs();
    else refreshSide(this.view === 'notes' ? 'note.written' : 'doc.written');
  }
  async loadOrgDocs() {
    const org = this.state.org;
    if (!org) return;
    this.orgDocsLoading = true;
    this.orgDocsError = '';
    try {
      const list = asList(await http.orgDocs(org.id), 'docs');
      this.orgDocs = list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    } catch (e) {
      this.orgDocsError = e.message;
    } finally {
      this.orgDocsLoading = false;
    }
  }
}
