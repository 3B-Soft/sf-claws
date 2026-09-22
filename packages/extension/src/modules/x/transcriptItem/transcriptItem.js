import { LightningElement, api } from 'lwc';
import { roleClass, roleLabel, fmtDate, jsonPretty, fileName, statusClass, statusLabel, truncate } from '../../../lib/format.js';

export default class TranscriptItem extends LightningElement {
  static renderMode = 'light';
  @api item;
  @api pro = false;
  expanded = false;

  get k() {
    return this.item?.kind;
  }
  get isUser() {
    return this.k === 'user';
  }
  get isAssistant() {
    return this.k === 'assistant';
  }
  get isThinking() {
    return this.k === 'thinking';
  }
  get isTool() {
    return this.k === 'tool';
  }
  get isAgent() {
    return this.k === 'agent';
  }
  get isWorkspace() {
    return this.k === 'workspace';
  }
  get isValidation() {
    return this.k === 'validation';
  }
  get isConfirmation() {
    return this.k === 'confirmation';
  }
  get isDeploy() {
    return this.k === 'deploy';
  }
  get isVerified() {
    return this.k === 'verified';
  }
  get isCommit() {
    return this.k === 'commit';
  }
  get isDoc() {
    return this.k === 'doc';
  }
  get isStatus() {
    return this.k === 'status';
  }
  get isError() {
    return this.k === 'error';
  }
  get isUnknown() {
    return this.k === 'unknown';
  }
  get isNote() {
    return this.k === 'note';
  }
  get isBlocked() {
    return this.k === 'blocked';
  }
  // note
  get noteTitle() {
    return this.item?.title || 'Note';
  }
  get noteTags() {
    return (this.item?.tags || []).map((t, i) => ({ key: i, text: t }));
  }
  get hasNoteTags() {
    return this.noteTags.length > 0;
  }
  // policy.blocked
  get blockedTool() {
    return String(this.item?.tool || '').replace(/_/g, ' ');
  }
  get blockedRule() {
    return this.item?.rule || '';
  }
  get blockedMessage() {
    return this.item?.message || '';
  }

  get at() {
    return fmtDate(this.item?.at);
  }
  get text() {
    return this.item?.text || '';
  }
  get role() {
    return this.item?.role;
  }
  get roleText() {
    return roleLabel(this.role);
  }
  get roleCls() {
    return `inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${roleClass(this.role)}`;
  }
  get isOrchestrator() {
    return !this.role || this.role === 'orchestrator';
  }
  get isSubAgent() {
    return this.isAssistant && !this.isOrchestrator;
  }
  get streaming() {
    return !!this.item?.streaming;
  }
  get subOpen() {
    return this.expanded;
  }
  get toggleGlyph() {
    return this.expanded ? '▾' : '▸';
  }
  get subPreview() {
    return truncate(this.text.replace(/\s+/g, ' '), 90);
  }
  get thinkingPreview() {
    return truncate(this.text.replace(/\s+/g, ' '), 120);
  }

  // agent
  get agentSpawned() {
    return this.item?.phase === 'spawned';
  }
  get agentOk() {
    return this.item?.ok;
  }
  get agentLine() {
    return this.agentSpawned ? `spawned ${roleLabel(this.role)}` : `${roleLabel(this.role)} ${this.item?.ok ? 'finished' : 'failed'}`;
  }
  get agentDetail() {
    // The server caps `summary` at 500 chars and the sub-agent's full message is its own
    // expandable row just above, so this line is a one-line footnote, not the findings.
    return truncate(String(this.agentSpawned ? this.item?.objective : this.item?.summary || '').replace(/\s+/g, ' '), 120);
  }
  get agentDotCls() {
    return `h-1.5 w-1.5 rounded-full ${this.agentSpawned ? 'bg-brand-400' : this.item?.ok ? 'bg-emerald-400' : 'bg-rose-400'}`;
  }

  // workspace
  get wsAction() {
    return this.item?.action;
  }
  get wsActionCls() {
    const a = this.item?.action;
    const c =
      a === 'created'
        ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
        : a === 'deleted'
          ? 'bg-rose-500/15 text-rose-700 border-rose-500/30'
          : 'bg-amber-500/15 text-amber-700 border-amber-500/30';
    return `inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${c}`;
  }
  get wsName() {
    return this.item?.fullName || fileName(this.item?.path);
  }
  get wsType() {
    return this.item?.metadataType || '';
  }
  get wsPath() {
    return this.item?.path || '';
  }

  // deploy
  get deployOk() {
    return !!this.item?.ok;
  }
  get deployCls() {
    return `rounded-xl border p-3 ${this.deployOk ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-rose-500/40 bg-rose-500/10'}`;
  }
  get deployTitle() {
    return this.deployOk ? `Deployed ${this.item?.componentsDeployed ?? 0} component(s)` : 'Deployment failed';
  }
  get deployMsg() {
    return this.item?.message || '';
  }
  get sfDeployId() {
    return this.item?.sfDeployId || '';
  }

  // deploy.verified — what the org actually contains, read back component by component
  get verifiedOk() {
    return !!this.item?.ok;
  }
  get verifiedCls() {
    return `rounded-xl border p-3 ${this.verifiedOk ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-rose-500/50 bg-rose-500/10'}`;
  }
  get verifiedTitle() {
    return this.verifiedOk ? 'Verified in the org' : 'Not everything landed in the org';
  }
  get verifiedTitleCls() {
    return `text-[12px] font-semibold ${this.verifiedOk ? 'text-emerald-700' : 'text-rose-700'}`;
  }
  get verifiedSummary() {
    return this.item?.summary || '';
  }
  get verifiedComponents() {
    return (this.item?.components || []).map((c, i) => {
      const missing = c.status === 'missing';
      const unreadable = c.status === 'unreadable';
      return {
        ...c,
        key: `${c.metadataType}-${c.fullName}-${i}`,
        marker: missing ? '✕' : unreadable ? '?' : '✓',
        statusText: missing ? 'missing' : unreadable ? 'could not check' : 'confirmed',
        rowCls: `flex items-center gap-2 px-2 py-1 ${missing ? 'bg-rose-500/15' : ''}`,
        markerCls: `w-3 shrink-0 text-center text-[11px] font-bold ${missing ? 'text-rose-700' : unreadable ? 'text-amber-700' : 'text-emerald-700'}`,
        nameCls: `min-w-0 flex-1 truncate text-[11px] ${missing ? 'font-semibold text-rose-700' : 'text-content-strong'}`,
        statusCls: `shrink-0 text-[10px] uppercase tracking-wide ${missing ? 'font-semibold text-rose-700' : unreadable ? 'text-amber-700' : 'text-content-subtle'}`,
      };
    });
  }
  get hasVerifiedComponents() {
    return this.verifiedComponents.length > 0;
  }
  get missingCount() {
    return (this.item?.components || []).filter((c) => c.status === 'missing').length;
  }
  get hasMissing() {
    return this.missingCount > 0;
  }
  get missingText() {
    return `${this.missingCount} component(s) are not in the org — the deploy reported success but they are not there.`;
  }

  // commit
  get commitTitle() {
    return `Committed to ${this.item?.owner}/${this.item?.repo}`;
  }
  get commitBranch() {
    return this.item?.branch;
  }
  get commitSha() {
    return String(this.item?.sha || '').slice(0, 7);
  }
  get commitUrl() {
    return this.item?.url;
  }
  get commitFiles() {
    return `${this.item?.filesChanged ?? 0} file(s)`;
  }
  get prUrl() {
    return this.item?.pullRequestUrl;
  }
  get commitMessage() {
    return this.item?.message;
  }

  // doc
  get docTitle() {
    return this.item?.title;
  }
  get docPath() {
    return this.item?.path;
  }

  // status / error
  get statusCls() {
    return statusClass(this.item?.status).replace('text-[11px]', 'text-[10px]');
  }
  get statusText() {
    return statusLabel(this.item?.status);
  }
  get statusMessage() {
    return this.item?.message || '';
  }
  get errorMessage() {
    return this.item?.message;
  }
  get errorRecoverable() {
    return this.item?.recoverable;
  }
  get rawJson() {
    return jsonPretty(this.item?.raw ?? this.item);
  }
  get unknownType() {
    return this.item?.type;
  }

  onToggle() {
    this.expanded = !this.expanded;
  }
  onConfirm(e) {
    this.dispatchEvent(new CustomEvent('confirm', { detail: e.detail }));
  }
  onOpenChanges() {
    this.dispatchEvent(new CustomEvent('openchanges'));
  }
  onOpenDocs() {
    this.dispatchEvent(new CustomEvent('opendocs'));
  }
  onOpenNotes() {
    this.dispatchEvent(new CustomEvent('opennotes', { detail: { noteId: this.item?.noteId } }));
  }
}
