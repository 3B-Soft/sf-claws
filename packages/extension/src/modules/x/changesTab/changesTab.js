import { LightningElement } from 'lwc';
import { appStore, api as http } from '../../../lib/state.js';
import { sessionStore, refreshSide } from '../../../lib/sessionController.js';
import { fileName, fmtDate } from '../../../lib/format.js';

export default class ChangesTab extends LightningElement {
  static renderMode = 'light';
  state = appStore.get();
  session = sessionStore.get();
  selectedPath = null;
  editing = false;
  editContent = '';
  busy = ''; // validate | deploy | commit | save
  awaiting = ''; // validate | deploy — started on the server, waiting for the deploy.* event
  _awaitSeq = 0;
  message = '';
  messageTone = 'emerald';
  commitOpen = false;
  commitMessage = '';
  createPr = false;
  /** 'deploy' | 'commit' | null: which in-panel confirmation is showing. */
  confirmKind = null;
  historyOpen = false;
  _unsubs = [];
  _lastTick = -1;

  exporting = false;
  async onExport() {
    this.exporting = true;
    try {
      const blob = await http.exportWorkspace(this.sessionId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `workspace-${this.sessionId}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      this.message = err.message;
      this.messageTone = 'rose';
    } finally {
      this.exporting = false;
    }
  }
  connectedCallback() {
    this._unsubs.push(
      appStore.subscribe((s) => {
        const t = s.reloadTick;
        this.state = s;
        if (t !== this._lastTick) {
          this._lastTick = t;
          if (s.sessionId) refreshSide();
        }
      }),
    );
    this._unsubs.push(
      sessionStore.subscribe((s) => {
        this.session = s;
        if (this.selectedPath && !s.workspace.some((f) => f.path === this.selectedPath)) this.selectedPath = null;
        this.checkAwaited();
      }),
    );
    this.createPr = false;
  }
  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }
  renderedCallback() {
    // LWC does not bind `value` on <textarea>; sync imperatively.
    const edit = this.querySelector('textarea[data-edit]');
    if (edit && edit.value !== this.editContent) edit.value = this.editContent;
    const commit = this.querySelector('textarea[data-commit]');
    if (commit && commit.value !== this.commitMessage) commit.value = this.commitMessage;
  }

  get sessionId() {
    return this.session.sessionId;
  }
  get hasSession() {
    return !!this.sessionId;
  }
  get isPro() {
    return this.state.uiMode === 'pro';
  }
  get workspace() {
    return this.session.workspace || [];
  }
  get hasFiles() {
    return this.workspace.length > 0;
  }
  get fileCount() {
    return this.workspace.length;
  }
  get groups() {
    const map = new Map();
    for (const f of this.workspace) {
      const t = f.metadataType || 'Other';
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(f);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, files]) => ({
        type,
        count: files.length,
        files: files.map((f) => ({
          path: f.path,
          name: f.fullName || fileName(f.path),
          file: fileName(f.path),
          action: f.action,
          selected: f.path === this.selectedPath,
          cls: `flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${f.path === this.selectedPath ? 'bg-brand-500/15 ring-1 ring-brand-500/40' : 'hover:bg-surface-sunken'}`,
          badgeCls: `inline-flex w-14 shrink-0 items-center justify-center rounded-md border px-1 py-0.5 text-[10px] font-medium ${f.action === 'created' ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700' : f.action === 'deleted' ? 'border-rose-500/30 bg-rose-500/15 text-rose-700' : 'border-amber-500/30 bg-amber-500/15 text-amber-700'}`,
        })),
      }));
  }
  get selected() {
    return this.workspace.find((f) => f.path === this.selectedPath) || null;
  }
  get selectedName() {
    return this.selected?.fullName || fileName(this.selected?.path);
  }
  get selectedPathText() {
    return this.selected?.path || '';
  }
  get selectedOriginal() {
    return this.selected?.original ?? '';
  }
  get selectedContent() {
    return this.selected?.content ?? '';
  }
  get selectedIsDeleted() {
    return this.selected?.action === 'deleted';
  }
  get selectedHasOriginal() {
    return this.selected?.original != null;
  }
  get diffOriginal() {
    return this.selected?.action === 'created' ? '' : this.selectedOriginal;
  }
  get diffModified() {
    return this.selectedIsDeleted ? '' : this.selectedContent;
  }
  get showDiff() {
    return !!this.selected && !this.editing;
  }
  get canEdit() {
    return this.isPro && !!this.selected && !this.selectedIsDeleted;
  }
  get isVisualNoOriginal() {
    return this.selected && this.selected.action === 'modified' && !this.selectedHasOriginal;
  }

  get deploys() {
    return (this.session.deploys || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  get lastValidation() {
    return this.deploys.find((d) => d.checkOnly && d.status !== 'cancelled') || null;
  }
  get lastValidationOk() {
    return this.lastValidation?.status === 'succeeded';
  }
  get lastRun() {
    return this.deploys[0] || null;
  }
  get hasRuns() {
    return this.deploys.length > 0;
  }
  get runCount() {
    return this.deploys.length;
  }
  get historyRuns() {
    return this.deploys.map((d) => ({ ...d, key: d.id, label: `${d.checkOnly ? 'Validate' : 'Deploy'} #${d.attempt} · ${fmtDate(d.createdAt)}` }));
  }
  get historyToggle() {
    return this.historyOpen ? '▾' : '▸';
  }
  get sessionRunning() {
    return this.session.status === 'running' || this.session.status === 'awaiting_confirmation';
  }
  get validateDisabled() {
    return !!this.busy || !!this.awaiting || !this.hasFiles || this.sessionRunning;
  }
  get deployDisabled() {
    return !!this.busy || !!this.awaiting || !this.hasFiles || !this.lastValidationOk || this.sessionRunning;
  }
  get awaitingRun() {
    return !!this.awaiting;
  }
  get awaitingText() {
    return this.awaiting === 'deploy'
      ? 'Deploying. Large orgs and slow orgs can take several minutes — the result appears here as soon as Salesforce reports it.'
      : 'Validating against the org. Large orgs and long test runs can take several minutes — the result appears here as soon as Salesforce reports it.';
  }
  get commitDisabled() {
    return !!this.busy || !this.hasFiles || this.sessionRunning;
  }
  get deployTitle() {
    return this.lastValidationOk ? 'Review and deploy the validated changes to this org' : 'Run a successful validation first';
  }
  get validateLabel() {
    return this.busy === 'validate' || this.awaiting === 'validate' ? 'Validating…' : 'Validate';
  }
  get deployLabel() {
    return this.busy === 'deploy' || this.awaiting === 'deploy' ? 'Deploying…' : 'Deploy';
  }
  get commitLabel() {
    return this.busy === 'commit' ? 'Committing…' : 'Commit to GitHub';
  }
  get saveLabel() {
    return this.busy === 'save' ? 'Saving…' : 'Save file';
  }
  get messageCls() {
    const tone =
      this.messageTone === 'rose'
        ? 'border-rose-500/30 bg-rose-500/10 text-rose-700'
        : this.messageTone === 'brand'
          ? 'border-brand-500/30 bg-brand-500/10 text-brand-700'
          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700';
    return `rounded-lg border px-3 py-2 text-[12px] ${tone}`;
  }
  get org() {
    return this.state.org;
  }
  get isProduction() {
    return this.org?.kind === 'production' || this.org?.protected;
  }
  get deployHint() {
    return this.isProduction
      ? 'Production / protected org: you confirm every deploy here before it runs.'
      : 'Deploys need a successful validation and your confirmation here.';
  }

  // ---- in-panel confirmation ---------------------------------------------------------------
  // The Deploy and Commit buttons call the server directly; nothing else asks first. So the
  // exact command and what it will do are shown here, and the button that runs it is this one.
  get confirmingDeploy() {
    return this.confirmKind === 'deploy';
  }
  get confirmingCommit() {
    return this.confirmKind === 'commit';
  }
  get confirmTitle() {
    return this.confirmingDeploy ? 'Deploy to Salesforce?' : 'Commit to GitHub?';
  }
  get confirmCommand() {
    if (this.confirmingDeploy) return 'deploy';
    const parts = ['commit_to_github'];
    if (this.commitMessage.trim()) parts.push(`message="${this.commitMessage.trim().replace(/"/g, '\\"')}"`);
    if (this.createPr) parts.push('createPullRequest=true');
    return parts.join(' ');
  }
  get confirmSummary() {
    const n = this.fileCount;
    const files = `${n} staged file${n === 1 ? '' : 's'}`;
    const org = this.org ? `${this.org.label} (${this.org.kind}${this.org.protected ? ', protected' : ''})` : 'this org';
    if (this.confirmingDeploy) {
      const v = this.lastValidation;
      const tests = v?.testLevel ? ` with test level ${v.testLevel}` : '';
      const attempt = v ? ` Validation #${v.attempt} passed.` : '';
      return `Sends ${files} to ${org}${tests}. This changes the org for every user; it cannot be undone from here.${attempt}`;
    }
    const msg = this.commitMessage.trim() ? `"${this.commitMessage.trim()}"` : 'a message the assistant writes from the session title';
    const pr = this.createPr ? ' and opens a pull request' : '';
    return `Commits ${files} and any session documentation to the client repository on the session branch, using ${msg},${pr ? pr : ' with no pull request'}. GitHub keeps the history; nothing is deployed.`;
  }
  get confirmButtonLabel() {
    return this.confirmingDeploy ? 'Confirm and deploy' : 'Confirm and commit';
  }
  get confirmCls() {
    return `mt-2 rounded-xl border p-3 ${this.confirmingDeploy ? 'border-amber-500/40 bg-amber-500/10' : 'border-brand-500/40 bg-brand-500/10'}`;
  }
  get confirmBtnCls() {
    return `rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50 ${this.confirmingDeploy ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-brand-500 hover:bg-brand-500'}`;
  }

  onSelect(e) {
    this.selectedPath = e.currentTarget.dataset.path;
    this.editing = false;
  }
  onClose() {
    this.selectedPath = null;
    this.editing = false;
  }
  onEdit() {
    this.editing = true;
    this.editContent = this.selectedContent;
  }
  onEditInput(e) {
    this.editContent = e.target.value;
  }
  onCancelEdit() {
    this.editing = false;
  }
  async onSave() {
    if (!this.selected) return;
    await this.run('save', async () => {
      await http.saveWorkspaceFile(this.sessionId, this.selected.path, this.editContent);
      await refreshSide('workspace.file');
      this.editing = false;
      this.flash('File saved to the session workspace.');
    });
  }
  async onValidate() {
    this.confirmKind = null;
    await this.run('validate', async () => {
      this.startAwaiting('validate');
      const run = await http.validate(this.sessionId);
      if (this.settle('validate', run)) return;
      this.flash('Validation running in the org. You can keep working; the result appears here.', 'brand');
      await refreshSide('deploy.result');
    });
  }
  onDeploy() {
    this.commitOpen = false;
    this.message = '';
    this.confirmKind = 'deploy';
  }
  onCancelConfirm() {
    this.confirmKind = null;
  }
  async onConfirm() {
    if (this.confirmingDeploy) await this.confirmDeploy();
    else if (this.confirmingCommit) await this.confirmCommit();
  }
  async confirmDeploy() {
    this.confirmKind = null;
    await this.run('deploy', async () => {
      this.startAwaiting('deploy');
      const run = await http.deploy(this.sessionId);
      if (this.settle('deploy', run)) return;
      // Pressing this button IS the approval; the confirmation card in Chat is for when the agent
      // asks. Saying otherwise sent people to a tab where nothing was waiting.
      this.flash('Deploying to the org. Progress shows here until it finishes.', 'brand');
      await refreshSide('deploy.result');
    });
  }
  /**
   * The HTTP call only starts the run; `deploy.validation` / `deploy.result` say how it ended. Note
   * the sequence we started at so an older event from a previous run cannot be mistaken for ours.
   */
  startAwaiting(kind) {
    this._awaitSeq = this.session.lastSeq || 0;
    this.awaiting = kind;
  }
  /** A server that answered with a finished run (not 202): no event to wait for. */
  settle(kind, run) {
    const status = run?.status;
    if (run?.running || !(status === 'succeeded' || status === 'failed' || status === 'cancelled')) return false;
    this.awaiting = '';
    const ok = status === 'succeeded';
    this.flash(
      kind === 'validate'
        ? ok
          ? 'Validation passed.'
          : 'Validation failed — see failures below.'
        : ok
          ? 'Deploy finished.'
          : 'Deploy did not complete — see the run below.',
      ok ? 'emerald' : 'rose',
    );
    refreshSide('deploy.result');
    return true;
  }
  /** Terminal event for the run we started? Then report it and stop showing progress. */
  checkAwaited() {
    if (!this.awaiting) return;
    const kind = this.awaiting === 'validate' ? 'validation' : 'deploy';
    const hit = (this.session.items || []).find((it) => it.kind === kind && (it.seq || 0) > this._awaitSeq);
    if (!hit) return;
    this.awaiting = '';
    if (kind === 'validation') this.flash(hit.ok ? 'Validation passed.' : 'Validation failed — see failures below.', hit.ok ? 'emerald' : 'rose');
    else this.flash(hit.message || (hit.ok ? 'Deploy finished.' : 'Deploy failed.'), hit.ok ? 'emerald' : 'rose');
    refreshSide('deploy.result');
  }
  onStopWaiting() {
    this.awaiting = '';
    this.message = '';
  }
  onToggleCommit() {
    this.commitOpen = !this.commitOpen;
  }
  onCommitMessage(e) {
    this.commitMessage = e.target.value;
  }
  onCreatePr(e) {
    this.createPr = e.target.checked;
  }
  onCommit() {
    this.message = '';
    this.confirmKind = 'commit';
  }
  async confirmCommit() {
    this.confirmKind = null;
    await this.run('commit', async () => {
      const r = await http.commit(this.sessionId, this.commitMessage.trim(), this.createPr);
      this.commitOpen = false;
      const where = r?.branch ? ` to ${r.branch}` : '';
      const sha = r?.sha ? ` (${String(r.sha).slice(0, 7)})` : '';
      this.flash(`Committed ${r?.filesChanged ?? this.fileCount} file(s)${where}${sha}.${r?.pullRequestUrl ? ' Pull request opened.' : ''}`);
      await refreshSide('github.commit');
    });
  }
  onToggleHistory() {
    this.historyOpen = !this.historyOpen;
  }
  onRefresh() {
    refreshSide();
  }

  async run(kind, fn) {
    this.busy = kind;
    this.message = '';
    try {
      await fn();
    } catch (e) {
      // A dropped or timed-out request does not mean the run failed: the server keeps going and the
      // deploy events are still coming. Only a real refusal clears the progress state.
      if (this.awaiting && e.isNetwork) this.flash('Still running on the server — the result will appear here when it finishes.', 'brand');
      else {
        this.awaiting = '';
        this.flash(e.message || 'Request failed', 'rose');
      }
    } finally {
      this.busy = '';
    }
  }
  flash(msg, tone = 'emerald') {
    this.message = msg;
    this.messageTone = tone;
  }
}
