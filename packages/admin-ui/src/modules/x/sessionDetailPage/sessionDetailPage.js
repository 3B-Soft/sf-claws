import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { toast, confirm } from '../../../lib/store.js';
import { connectSessionEvents } from '../../../lib/sse.js';
import { buildTranscript } from '../../../lib/transcript.js';
import { fmtUsd, fmtTokens, fmtDate } from '../../../lib/format.js';
import { setQuery } from '../../../lib/router.js';
import { isAdmin } from '../../../lib/rbac.js';

const LIVE = new Set(['running', 'awaiting_confirmation']);

/**
 * Session detail: header, transcript (SSE-live while running), workspace/deploys/docs/notes/usage tabs,
 * approval cards, todo panel, org limits, session permissions, resume/cancel/complete.
 */
export default class SessionDetailPage extends LightningElement {
  static renderMode = 'light';
  @api sessionId;
  @api user;
  @api query = {};
  detail = null;
  events = [];
  todos = null; // TodoItem[] from GET /todos (fallback when no todo.updated event yet)
  permissions = [];
  users = [];
  loading = true;
  error = null;
  historyError = null;
  sse = null;
  sseStatus = 'closed';
  proOverride = null;
  selectedFile = null;
  selectedDoc = null;
  selectedNote = null;
  notesVersion = 0;
  composer = '';
  busy = false;
  _loadedId = null;

  connectedCallback() {
    this.load();
  }
  disconnectedCallback() {
    this.closeSse();
  }
  renderedCallback() {
    if (this._loadedId !== this.sessionId) this.load();
  }

  async load() {
    this._loadedId = this.sessionId;
    this.closeSse();
    this.loading = true;
    this.error = null;
    this.historyError = null;
    try {
      this.detail = await Api.getSession(this.sessionId);
      const side = [
        Api.sessionHistory(this.sessionId)
          .then((r) => {
            this.events = asList(r, 'events');
          })
          .catch((e) => {
            this.historyError = e;
            this.events = [];
          }),
        Api.sessionTodos(this.sessionId)
          .then((r) => {
            this.todos = asList(r, 'items');
          })
          .catch(() => {
            this.todos = null;
          }),
        Api.sessionPermissions(this.sessionId)
          .then((r) => {
            this.permissions = asList(r, 'permissions');
          })
          .catch(() => {
            this.permissions = [];
          }),
      ];
      if (isAdmin(this.user) && !this.users.length)
        side.push(
          Api.listUsers()
            .then((r) => {
              this.users = asList(r, 'users');
            })
            .catch(() => {}),
        );
      await Promise.all(side);
      this.maybeConnect();
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  maybeConnect() {
    if (!this.session || !this.shouldStream || this.sse) return;
    const after = Math.max(this.model.lastSeq, this.detail?.lastSeq || 0);
    this.sse = connectSessionEvents(this.sessionId, {
      after,
      onEvent: (ev) => this.onEvent(ev),
      onStatus: (s) => {
        this.sseStatus = s;
      },
      onReady: (info) => {
        if (info && info.running === false && !LIVE.has(this.session?.status)) {
          this.closeSse();
        }
      },
    });
  }
  get shouldStream() {
    return !!this.session && (LIVE.has(this.session.status) || this.detail?.running === true);
  }
  closeSse() {
    this.sse?.close();
    this.sse = null;
    this.sseStatus = 'closed';
  }
  onEvent(ev) {
    if (typeof ev?.seq === 'number' && this.events.some((e) => e.seq === ev.seq && e.type === ev.type)) return;
    this.events = [...this.events, ev];
    switch (ev.type) {
      case 'session.status':
        this.detail = { ...this.detail, session: { ...this.detail.session, status: ev.status }, running: LIVE.has(ev.status) };
        if (!LIVE.has(ev.status)) {
          this.closeSse();
          this.refreshDetail();
        }
        break;
      case 'session.usage':
        this.detail = {
          ...this.detail,
          session: {
            ...this.detail.session,
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            cachedInputTokens: ev.cachedInputTokens,
            costUsd: ev.costUsd,
          },
        };
        break;
      case 'todo.updated':
        this.todos = ev.items || [];
        break;
      case 'note.written':
        this.notesVersion += 1;
        break;
      case 'confirmation.resolved':
        if (ev.optionId === 'approve_session') this.refreshPermissions();
        break;
      case 'workspace.file':
      case 'deploy.validation':
      case 'deploy.result':
      case 'doc.written':
      case 'github.commit':
        this.refreshDetail();
        break;
      default:
        break;
    }
  }
  async refreshDetail() {
    try {
      this.detail = await Api.getSession(this.sessionId);
    } catch {
      /* keep current */
    }
  }
  async refreshPermissions() {
    try {
      this.permissions = asList(await Api.sessionPermissions(this.sessionId), 'permissions');
    } catch {
      /* ignore */
    }
  }

  // ---- derived -------------------------------------------------------------
  get session() {
    return this.detail?.session;
  }
  get model() {
    return buildTranscript(this.events);
  }
  get blocks() {
    return this.model.blocks;
  }
  get agents() {
    return this.model.agents;
  }
  get todoItems() {
    return this.model.todos?.items || this.todos || [];
  }
  get limits() {
    return this.model.limits;
  }
  get hasLimitWarnings() {
    return !!this.limits && (this.limits.warnings || []).length > 0;
  }
  get running() {
    return this.detail?.running === true || LIVE.has(this.session?.status);
  }
  get isLive() {
    return this.running;
  }
  get proMode() {
    return this.proOverride !== null ? this.proOverride : this.user?.uiMode === 'pro' || this.session?.uiMode === 'pro';
  }
  get proLabel() {
    return this.proMode ? 'Pro' : 'Visual';
  }
  get proBtnCls() {
    return `btn-secondary btn-sm ${this.proMode ? 'ring-1 ring-brand-500' : ''}`;
  }
  get title() {
    return this.session?.title || 'Session';
  }
  get subtitle() {
    const d = this.detail;
    if (!d) return '';
    return `${d.client?.name || ''} · ${d.org?.label || ''}${d.project ? ' · ' + d.project.name : ''}${d.task ? ' · ' + d.task.title : ''}`;
  }
  get orgKind() {
    return this.detail?.org?.kind;
  }
  get orgProtected() {
    return !!this.detail?.org?.protected;
  }
  get orgHref() {
    return this.detail?.client?.id ? `#/clients/${this.detail.client.id}?tab=orgs` : '#/clients';
  }
  get userLabel() {
    const id = this.session?.userId;
    const u = this.users.find((x) => x.id === id);
    return u ? u.displayName || u.email : id === this.user?.id ? this.user.displayName || 'You' : id || '';
  }
  get cost() {
    return fmtUsd(this.session?.costUsd);
  }
  get tokens() {
    return `${fmtTokens(this.session?.inputTokens)} in · ${fmtTokens(this.session?.outputTokens)} out`;
  }
  get cached() {
    return this.session?.cachedInputTokens ? `${fmtTokens(this.session.cachedInputTokens)} cached` : '';
  }
  get created() {
    return fmtDate(this.session?.createdAt);
  }
  get statusMessage() {
    return this.model.statusMessage || '';
  }
  get isResumable() {
    return this.session?.status === 'failed' && /resumable/i.test(this.statusMessage || '');
  }
  get canResume() {
    return this.canInteract && this.session?.status === 'failed' && !this.running;
  }
  get canComplete() {
    return this.canInteract && this.session?.status === 'idle' && !this.running;
  }
  get sseLabel() {
    return { connecting: 'connecting', open: 'live', reconnecting: 'reconnecting', closed: '' }[this.sseStatus] || '';
  }
  get sseCls() {
    return `chip ${this.sseStatus === 'open' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/30 bg-amber-500/10 text-amber-700'}`;
  }
  get showSse() {
    return this.isLive && !!this.sseLabel;
  }
  get helpfulUp() {
    return this.session?.helpful === true;
  }
  get helpfulDown() {
    return this.session?.helpful === false;
  }
  get upCls() {
    return `btn-ghost btn-sm ${this.helpfulUp ? 'text-emerald-700 ring-1 ring-emerald-500/40' : 'text-content-muted'}`;
  }
  get downCls() {
    return `btn-ghost btn-sm ${this.helpfulDown ? 'text-rose-700 ring-1 ring-rose-500/40' : 'text-content-muted'}`;
  }
  get feedbackNote() {
    return this.session?.feedbackNote || '';
  }
  get canCancel() {
    return this.canInteract && this.isLive;
  }
  get isOwner() {
    return this.session?.userId === this.user?.id;
  }
  get canInteract() {
    return this.isOwner || isAdmin(this.user);
  }
  get readonlyTranscript() {
    return !this.canInteract;
  }
  get workspace() {
    return this.detail?.workspace || [];
  }
  get deploys() {
    return this.detail?.deploys || [];
  }
  get docs() {
    return this.detail?.docs || [];
  }
  get permissionChips() {
    return (this.permissions || []).map((p) => ({ id: p.command, command: p.command, grantedAt: p.grantedAt }));
  }
  get hasPermissions() {
    return this.permissionChips.length > 0;
  }
  get tab() {
    return this.query?.tab || 'transcript';
  }
  get tabs() {
    const t = [
      { id: 'transcript', label: 'Transcript', count: this.blocks.length || undefined },
      { id: 'workspace', label: 'Workspace', count: this.workspace.length },
      { id: 'deploys', label: 'Deploys', count: this.deploys.length },
      { id: 'docs', label: 'Docs', count: this.docs.length },
      { id: 'notes', label: 'Notes', count: this.model.notes.length || undefined },
    ];
    if (isAdmin(this.user)) t.push({ id: 'usage', label: 'Usage' });
    if (this.proMode) t.push({ id: 'events', label: 'Events (raw)', count: this.events.length });
    return t;
  }
  get isTranscript() {
    return this.tab === 'transcript';
  }
  get isWorkspace() {
    return this.tab === 'workspace';
  }
  get isDeploys() {
    return this.tab === 'deploys';
  }
  get isDocs() {
    return this.tab === 'docs';
  }
  get isNotes() {
    return this.tab === 'notes';
  }
  get isUsage() {
    return this.tab === 'usage' && isAdmin(this.user);
  }
  get isEvents() {
    return this.tab === 'events' && this.proMode;
  }
  get rawEvents() {
    return this.events.map((e, i) => ({ id: `${e.seq ?? i}-${e.type}`, seq: e.seq, type: e.type, at: fmtDate(e.at), event: e }));
  }
  get pendingCount() {
    // Prefer the server's view (survives reloads / missing history); fall back to what the transcript saw.
    const fromServer = this.detail?.pendingConfirmations?.length;
    return fromServer !== undefined && fromServer !== null ? fromServer : this.model.pendingConfirmations.length;
  }
  get hasPending() {
    return this.pendingCount > 0;
  }
  get cannotSend() {
    return this.busy || !this.composer.trim() || this.running;
  }
  get showComposer() {
    return this.canInteract && this.session && this.session.status !== 'completed' && this.session.status !== 'cancelled';
  }

  // ---- actions -------------------------------------------------------------
  selectTab(e) {
    setQuery({ tab: e.detail.id });
  }
  togglePro() {
    this.proOverride = !this.proMode;
  }
  reload() {
    this.load();
  }
  openFile(e) {
    this.selectedFile = e.detail.path;
    setQuery({ tab: 'workspace' });
  }
  openDoc(e) {
    this.selectedDoc = e.detail.docId;
    setQuery({ tab: 'docs' });
  }
  openNote(e) {
    this.selectedNote = e.detail.noteId;
    setQuery({ tab: 'notes' });
  }
  async choose(e) {
    const { confirmationId, optionId } = e.detail;
    this.busy = true;
    try {
      await Api.confirmSession(this.sessionId, { confirmationId, optionId });
      toast.success('Decision sent');
      await this.refreshDetail();
      if (optionId === 'approve_session') this.refreshPermissions();
      this.maybeConnect();
    } catch (err) {
      toast.error('Could not send decision', err.message);
    } finally {
      this.busy = false;
    }
  }
  async feedback(e) {
    const helpful = e.currentTarget.dataset.value === 'true';
    try {
      await Api.feedback(this.sessionId, { helpful });
      this.detail = { ...this.detail, session: { ...this.session, helpful } };
      toast.success('Feedback saved');
    } catch (err) {
      toast.error('Could not save feedback', err.message);
    }
  }
  async cancel() {
    if (
      !(await confirm({
        title: 'Cancel this session?',
        message: 'The agent loop stops. Staged workspace changes are kept but not deployed.',
        confirmLabel: 'Cancel session',
        danger: true,
      }))
    )
      return;
    try {
      await Api.cancelSession(this.sessionId);
      toast.success('Session cancelled');
      await this.refreshDetail();
    } catch (err) {
      toast.error('Could not cancel', err.message);
    }
  }
  async resume() {
    this.busy = true;
    try {
      await Api.resumeSession(this.sessionId);
      toast.success('Session resuming', 'The orchestrator continues from its persisted memory.');
      await this.refreshDetail();
      this.detail = { ...this.detail, running: true, session: { ...this.session, status: 'running' } };
      this.maybeConnect();
    } catch (err) {
      toast.error('Could not resume', err.message);
    } finally {
      this.busy = false;
    }
  }
  async complete() {
    if (
      !(await confirm({
        title: 'Mark this session as completed?',
        message: 'The session is closed; a new session is needed for further changes.',
        confirmLabel: 'Complete',
      }))
    )
      return;
    this.busy = true;
    try {
      await Api.completeSession(this.sessionId);
      toast.success('Session completed');
      await this.refreshDetail();
    } catch (err) {
      toast.error('Could not complete', err.message);
    } finally {
      this.busy = false;
    }
  }
  async revoke(e) {
    const command = e.currentTarget.dataset.command;
    try {
      await Api.revokePermission(this.sessionId, command);
      toast.success(`Revoked "${command}"`, 'The agent will ask again next time.');
      await this.refreshPermissions();
    } catch (err) {
      toast.error('Could not revoke', err.message);
    }
  }
  handleComposer(e) {
    this.composer = e.detail.value;
  }
  async send(e) {
    e?.preventDefault?.();
    if (this.cannotSend) return;
    this.busy = true;
    try {
      await Api.sendMessage(this.sessionId, { text: this.composer.trim() });
      this.composer = '';
      await this.refreshDetail();
      this.detail = { ...this.detail, running: true };
      this.maybeConnect();
    } catch (err) {
      toast.error('Could not send message', err.message);
    } finally {
      this.busy = false;
    }
  }
  workspaceChanged() {
    this.refreshDetail();
  }
}
