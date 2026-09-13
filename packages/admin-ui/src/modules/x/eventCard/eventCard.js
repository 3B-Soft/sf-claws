import { LightningElement, api } from 'lwc';
import { ROLE_META, COLOR_CLASSES } from '../../../lib/constants.js';
import { fmtTime, shortSha, truncate } from '../../../lib/format.js';

/** Renders one transcript block by kind. */
export default class EventCard extends LightningElement {
  static renderMode = 'light';
  @api block;
  @api proMode = false;
  @api readonly = false;
  @api busy = false;
  expanded = false;

  get b() {
    return this.block || {};
  }
  get kind() {
    return this.b.kind;
  }
  get time() {
    return fmtTime(this.b.at);
  }
  get isMessage() {
    return this.kind === 'message';
  }
  get isThinking() {
    return this.kind === 'thinking';
  }
  get isTool() {
    return this.kind === 'tool';
  }
  get isValidation() {
    return this.kind === 'validation';
  }
  get isConfirmation() {
    return this.kind === 'confirmation';
  }
  get isDeploy() {
    return this.kind === 'deploy';
  }
  get isCommit() {
    return this.kind === 'commit';
  }
  get isDoc() {
    return this.kind === 'doc';
  }
  get isStatus() {
    return this.kind === 'status';
  }
  get isError() {
    return this.kind === 'error';
  }
  get isUser() {
    return this.kind === 'user';
  }
  get isWorkspace() {
    return this.kind === 'workspace';
  }
  get isAgent() {
    return this.kind === 'agent';
  }
  get isRaw() {
    return this.kind === 'raw';
  }
  get isNote() {
    return this.kind === 'note';
  }
  get isBlocked() {
    return this.kind === 'blocked';
  }
  get isLimits() {
    return this.kind === 'limits';
  }
  get noteTags() {
    return (this.b.tags || []).slice(0, 4).map((t) => ({ id: t, label: t }));
  }
  openNote() {
    this.dispatchEvent(new CustomEvent('opennote', { bubbles: true, detail: { noteId: this.b.noteId } }));
  }

  // role / agent chip
  get roleMeta() {
    return ROLE_META[this.b.role] || { label: this.b.role || 'agent', color: 'slate' };
  }
  get roleLabel() {
    return this.roleMeta.label;
  }
  get roleChipCls() {
    return `chip ${COLOR_CLASSES[this.roleMeta.color] || COLOR_CLASSES.slate}`;
  }
  get isOrchestrator() {
    return this.b.role === 'orchestrator' || !this.b.role;
  }
  // message
  get bubbleCls() {
    return this.isOrchestrator
      ? 'rounded-2xl rounded-tl-md border border-brand-500/20 bg-brand-500/[0.07] px-4 py-3'
      : 'rounded-xl border border-line bg-surface px-4 py-3';
  }
  get streaming() {
    return !!this.b.streaming;
  }
  get textCls() {
    return this.streaming ? 'caret' : '';
  }
  get subAgentCollapsed() {
    return !this.isOrchestrator && !this.expanded;
  }
  get messagePreview() {
    return truncate((this.b.text || '').replace(/\s+/g, ' '), 140);
  }
  toggleExpand() {
    this.expanded = !this.expanded;
  }
  // thinking
  get thinkingText() {
    return this.b.text || '';
  }
  // deploy
  get deploy() {
    return this.b.result || {};
  }
  get deployCls() {
    return `flex items-start gap-3 rounded-xl border p-3 ${this.deploy.ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5'}`;
  }
  get deployIcon() {
    return this.deploy.ok ? 'check' : 'error';
  }
  get deployIconCls() {
    return `h-5 w-5 ${this.deploy.ok ? 'text-emerald-700' : 'text-rose-700'}`;
  }
  get deployTitle() {
    return this.deploy.ok ? `Deployed ${this.deploy.componentsDeployed} component${this.deploy.componentsDeployed === 1 ? '' : 's'}` : 'Deploy failed';
  }
  // commit
  get commit() {
    return this.b.commit || {};
  }
  get commitSha() {
    return shortSha(this.commit.sha);
  }
  get commitRepo() {
    return `${this.commit.owner}/${this.commit.repo}`;
  }
  get commitFiles() {
    return `${this.commit.filesChanged} file${this.commit.filesChanged === 1 ? '' : 's'}`;
  }
  get hasPr() {
    return !!this.commit.pullRequestUrl;
  }
  // doc
  get doc() {
    return this.b.doc || {};
  }
  // status
  get statusMessage() {
    return this.b.message || '';
  }
  // workspace
  get wsAction() {
    return this.b.action;
  }
  get wsLabel() {
    return this.b.metadataType ? `${this.b.metadataType} · ${this.b.fullName || ''}` : '';
  }
  // agent
  get agentSpawned() {
    return this.b.phase === 'spawned';
  }
  get agentText() {
    return this.agentSpawned
      ? `spawned · ${truncate(this.b.objective || '', 120)}`
      : `${this.b.ok ? 'finished' : 'failed'} · ${truncate(this.b.summary || '', 140)}`;
  }
  get agentIcon() {
    return this.agentSpawned ? 'ai' : this.b.ok ? 'check' : 'error';
  }
  get agentIconCls() {
    return `h-3.5 w-3.5 ${this.agentSpawned ? 'text-brand-600' : this.b.ok ? 'text-emerald-700' : 'text-rose-700'}`;
  }
  get rawEvent() {
    return this.b.event;
  }
  get rawType() {
    return this.b.event?.type || 'event';
  }
  openDoc() {
    this.dispatchEvent(new CustomEvent('opendoc', { bubbles: true, detail: { docId: this.doc.docId } }));
  }
  openWs() {
    this.dispatchEvent(new CustomEvent('openfile', { bubbles: true, detail: { path: this.b.path } }));
  }
}
