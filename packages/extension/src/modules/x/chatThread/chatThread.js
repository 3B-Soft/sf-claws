import { LightningElement } from 'lwc';
import { appStore, setTab } from '../../../lib/state.js';
import {
  sessionStore,
  sendMessage,
  cancel,
  feedback,
  confirm,
  reconnect,
  clearError,
  resume,
  resync,
  revokePermission,
  isResumable,
  compact,
  dismissContextPressure,
} from '../../../lib/sessionController.js';
import { quickActionsFor } from '../../../lib/context.js';
import { statusClass, statusLabel, fmtTokens, fmtUsd, roleClass, roleLabel, truncate, fmtRelative } from '../../../lib/format.js';

export default class ChatThread extends LightningElement {
  static renderMode = 'light';
  state = appStore.get();
  session = sessionStore.get();
  draft = '';
  swarmOpen = false;
  feedbackNote = '';
  feedbackChoice = null; // true | false | null
  feedbackSent = false;
  feedbackBusy = false;
  cancelBusy = false;
  revoking = '';
  compactBusy = false;
  compactNote = '';
  _unsubs = [];
  _stick = true;
  _lastVersion = -1;

  connectedCallback() {
    this._unsubs.push(
      appStore.subscribe((s) => {
        this.state = s;
      }),
    );
    this._unsubs.push(
      sessionStore.subscribe((s) => {
        const prevId = this.session.sessionId;
        this.session = s;
        if (prevId !== s.sessionId) {
          this.feedbackSent = false;
          this.feedbackChoice = null;
          this.feedbackNote = '';
        }
      }),
    );
  }
  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }
  renderedCallback() {
    // textarea values are set imperatively (LWC does not bind `value` on <textarea>)
    const ta = this.querySelector('textarea[data-draft]');
    if (ta && ta.value !== this.draft) ta.value = this.draft;
    const note = this.querySelector('textarea[data-note]');
    if (note && note.value !== this.feedbackNote) note.value = this.feedbackNote;
    if (this.session.version !== this._lastVersion) {
      this._lastVersion = this.session.version;
      if (this._stick) this.scrollToBottom();
    }
  }
  scrollToBottom() {
    const el = this.querySelector('[data-scroll]');
    if (el) el.scrollTop = el.scrollHeight;
  }
  onScroll(e) {
    const el = e.target;
    this._stick = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  get title() {
    return this.session.session?.title || 'Session';
  }
  get loading() {
    return this.session.loading && !this.session.session;
  }
  get error() {
    return this.session.error;
  }
  get items() {
    return this.session.items;
  }
  get hasItems() {
    return this.items.length > 0;
  }
  get status() {
    return this.session.status;
  }
  get statusCls() {
    return statusClass(this.status);
  }
  get statusText() {
    return statusLabel(this.status);
  }
  get isRunning() {
    return this.status === 'running';
  }
  get isAwaiting() {
    return this.status === 'awaiting_confirmation';
  }
  get isBusy() {
    return this.isRunning || this.isAwaiting;
  }
  get isDone() {
    return ['completed', 'failed', 'cancelled', 'idle'].includes(this.status) && this.hasItems;
  }
  get statusMessage() {
    return this.session.statusMessage || '';
  }
  get usageText() {
    const u = this.session.usage || {};
    return `${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out · ${fmtUsd(u.costUsd)}`;
  }
  get hasUsage() {
    const u = this.session.usage || {};
    return (u.inputTokens || 0) + (u.outputTokens || 0) > 0;
  }
  get connection() {
    return this.session.connection;
  }
  get connectionLost() {
    return !this.session.offline && (this.connection === 'error' || this.connection === 'reconnecting');
  }
  get offline() {
    return !!this.session.offline;
  }
  get lastSynced() {
    return this.session.lastSyncedAt ? fmtRelative(this.session.lastSyncedAt) : 'never';
  }
  get fromCache() {
    return !!this.session.fromCache && !this.session.offline;
  }
  get isPro() {
    return this.state.uiMode === 'pro';
  }
  get canSend() {
    return this.draft.trim().length > 0 && !this.session.sending && !this.isRunning && !this.offline;
  }
  get sendDisabled() {
    return !this.canSend;
  }
  get sendLabel() {
    return this.session.sending ? '…' : 'Send';
  }
  get composerPlaceholder() {
    return this.offline
      ? 'Offline — reconnect to continue this session'
      : this.isAwaiting
        ? 'Answer the confirmation above, or type a reply…'
        : this.isRunning
          ? 'Agent is working… you can queue a note'
          : 'Ask about this org, or describe a change…';
  }
  get quickActions() {
    return this.hasItems ? [] : quickActionsFor(this.state.context);
  }
  get showQuick() {
    return this.quickActions.length > 0 && !this.loading;
  }
  get agents() {
    return (this.session.agents || []).map((a) => ({
      ...a,
      roleCls: `inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${roleClass(a.role)}`,
      roleText: roleLabel(a.role),
      objectiveShort: truncate(a.objective, 90),
      running: a.status === 'running',
      done: a.status === 'done',
      failed: a.status === 'failed',
    }));
  }
  get agentCount() {
    return this.agents.length;
  }
  get runningAgents() {
    return this.agents.filter((a) => a.running).length;
  }
  get swarmLabel() {
    return `${this.agentCount} agent${this.agentCount === 1 ? '' : 's'}${this.runningAgents ? ` · ${this.runningAgents} working` : ''}`;
  }
  get hasAgents() {
    return this.agentCount > 0;
  }
  get pending() {
    return this.session.pending || [];
  }

  // ---- context pressure (session.context) ------------------------------------
  get contextPressure() {
    return this.session.contextPressure || null;
  }
  get showContextPressure() {
    return !!this.contextPressure;
  }
  get contextCritical() {
    return this.contextPressure?.level === 'critical';
  }
  get contextMessage() {
    return this.contextPressure?.message || '';
  }
  get contextPercentText() {
    const p = Number(this.contextPressure?.percent);
    return Number.isFinite(p) ? `${Math.round(p > 1 ? p : p * 100)}% of the context window used` : '';
  }
  get contextBannerCls() {
    return `mb-2 rounded-xl border px-3 py-2 ${this.contextCritical ? 'border-rose-500/40 bg-rose-500/10' : 'border-amber-500/40 bg-amber-500/10'}`;
  }
  get contextTitleCls() {
    return `text-[12px] font-semibold ${this.contextCritical ? 'text-rose-700' : 'text-amber-700'}`;
  }
  get contextTextCls() {
    return `mt-0.5 text-[11px] ${this.contextCritical ? 'text-rose-700/80' : 'text-amber-700/80'}`;
  }
  get contextBtnCls() {
    return `rounded-lg border px-2.5 py-1 text-[11px] font-medium ${this.contextCritical ? 'border-rose-500/40 text-rose-700 hover:bg-rose-500/15' : 'border-amber-500/40 text-amber-700 hover:bg-amber-500/15'}`;
  }
  get contextTitle() {
    return this.contextCritical ? 'This session is nearly out of context' : 'This session is filling up its context';
  }
  get compactLabel() {
    return this.compactBusy ? 'Compacting…' : 'Compact this session';
  }
  get todos() {
    return this.session.todos || [];
  }
  get hasTodos() {
    return this.todos.length > 0;
  }
  get permissions() {
    return (this.session.permissions || []).map((p) => ({
      ...p,
      key: p.command,
      label: String(p.command).replace(/_/g, ' '),
      busy: this.revoking === p.command,
    }));
  }
  get hasPermissions() {
    return this.permissions.length > 0;
  }
  get resumable() {
    return isResumable(this.session) && !this.offline;
  }
  get resumeLabel() {
    return this.session.resuming ? 'Resuming…' : 'Resume session';
  }
  get resumeHint() {
    return this.statusMessage || 'This session stopped before finishing. The assistant can pick up where it left off.';
  }
  get feedbackHelpful() {
    return this.session.session?.helpful;
  }
  get showFeedback() {
    return this.isDone && !this.feedbackSent && this.session.session?.helpful == null && !this.resumable;
  }
  get feedbackPicked() {
    return this.feedbackChoice !== null;
  }
  get upCls() {
    return `rounded-lg border px-2.5 py-1 text-[12px] ${this.feedbackChoice === true ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700' : 'border-line-strong text-content hover:bg-surface-sunken'}`;
  }
  get downCls() {
    return `rounded-lg border px-2.5 py-1 text-[12px] ${this.feedbackChoice === false ? 'border-rose-500/60 bg-rose-500/15 text-rose-700' : 'border-line-strong text-content hover:bg-surface-sunken'}`;
  }
  get feedbackThanks() {
    return this.feedbackSent || this.session.session?.helpful != null;
  }
  get swarmToggle() {
    return this.swarmOpen ? '▾' : '▸';
  }
  get noStatusMessage() {
    return !this.statusMessage;
  }
  get cancelLabel() {
    return this.cancelBusy ? 'Cancelling…' : 'Cancel';
  }

  onDraft(e) {
    this.draft = e.target.value;
  }
  onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (this.canSend) this.onSend();
    }
  }
  async onSend() {
    const text = this.draft.trim();
    if (!text) return;
    this.draft = '';
    this._stick = true;
    try {
      await sendMessage(text);
    } catch {
      this.draft = text;
    }
  }
  onQuick(e) {
    const qa = this.quickActions.find((q) => q.id === e.currentTarget.dataset.id);
    if (qa && !this.offline) {
      this._stick = true;
      sendMessage(qa.text).catch(() => {
        this.draft = qa.text;
      });
    }
  }
  async onCancel() {
    this.cancelBusy = true;
    try {
      await cancel();
    } catch (e) {
      sessionStore.set({ error: e.message });
    } finally {
      this.cancelBusy = false;
    }
  }
  async onResume() {
    try {
      await resume();
    } catch {
      /* error shown via store */
    }
  }
  onShowList() {
    this.dispatchEvent(new CustomEvent('showlist'));
  }
  onNew() {
    this.dispatchEvent(new CustomEvent('newsession'));
  }
  onToggleSwarm() {
    this.swarmOpen = !this.swarmOpen;
  }
  onReconnect() {
    reconnect();
  }
  onResync() {
    resync();
  }
  onDismissError() {
    clearError();
  }
  onDismissContext() {
    this.compactNote = '';
    dismissContextPressure();
  }
  async onCompact() {
    this.compactBusy = true;
    this.compactNote = '';
    try {
      const res = await compact();
      // An older server has no compact route: say so instead of leaving a button that does nothing.
      if (res?.unsupported) this.compactNote = 'This server cannot compact a session yet. Start a new session to carry on.';
    } catch (e) {
      this.compactNote = e.message || 'Could not compact this session.';
    } finally {
      this.compactBusy = false;
    }
  }
  onOpenChanges() {
    setTab('changes');
  }
  onOpenDocs() {
    setTab('notes');
  }
  onOpenNotes() {
    setTab('notes');
  }
  async onConfirm(e) {
    try {
      await confirm(e.detail.confirmationId, e.detail.optionId, e.detail.answerText);
    } catch (err) {
      sessionStore.set({ error: err.message });
    }
  }
  async onRevoke(e) {
    const command = e.currentTarget.dataset.command;
    this.revoking = command;
    try {
      await revokePermission(command);
    } catch (err) {
      sessionStore.set({ error: err.message });
    } finally {
      this.revoking = '';
    }
  }
  onThumb(e) {
    this.feedbackChoice = e.currentTarget.dataset.v === '1';
  }
  onNote(e) {
    this.feedbackNote = e.target.value;
  }
  async onSendFeedback() {
    if (this.feedbackChoice === null) return;
    this.feedbackBusy = true;
    try {
      await feedback(this.feedbackChoice, this.feedbackNote.trim() || undefined);
      this.feedbackSent = true;
    } catch (e) {
      sessionStore.set({ error: e.message });
    } finally {
      this.feedbackBusy = false;
    }
  }
}
