import { LightningElement, api } from 'lwc';
import { Api } from '../../../lib/api.js';
import { toast, confirm } from '../../../lib/store.js';

/** Workspace files with diff viewer (original vs content); pro mode allows editing via PUT /sessions/:id/workspace/file. */
export default class WorkspaceTab extends LightningElement {
  static renderMode = 'light';
  @api sessionId;
  @api files = [];
  @api proMode = false;
  @api running = false;
  @api get selectedPath() {
    return this._sel;
  }
  set selectedPath(v) {
    this._sel = v || null;
  }
  _sel = null;
  editing = false;
  draft = '';
  busy = false;

  get list() {
    return (this.files || []).map((f) => ({
      ...f,
      id: f.path,
      cls: `flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ${f.path === this.current?.path ? 'bg-brand-50 font-medium text-brand-700 ring-1 ring-inset ring-brand-500/30' : 'text-content hover:bg-surface-sunken'}`,
      name: f.path.split('/').pop(),
      dir: f.path.split('/').slice(0, -1).join('/'),
      actionColor: f.action === 'created' ? 'emerald' : f.action === 'deleted' ? 'rose' : 'amber',
    }));
  }
  get current() {
    const files = this.files || [];
    return files.find((f) => f.path === this._sel) || files[0] || null;
  }
  get hasFiles() {
    return (this.files || []).length > 0;
  }
  get currentLabel() {
    return this.current ? `${this.current.metadataType || 'File'}${this.current.fullName ? ' · ' + this.current.fullName : ''}` : '';
  }
  get original() {
    return this.current?.original ?? '';
  }
  get content() {
    return this.current?.content ?? '';
  }
  get isDeleted() {
    return this.current?.action === 'deleted';
  }
  get noOriginal() {
    return !this.current?.original;
  }
  get canEdit() {
    return this.proMode && this.current && !this.isDeleted && !this.running;
  }
  get runningNote() {
    return this.proMode && this.running ? 'Editing is disabled while the session is running.' : '';
  }
  get editLabel() {
    return this.editing ? 'Cancel' : 'Edit XML';
  }
  select(e) {
    this._sel = e.currentTarget.dataset.path;
    this.editing = false;
  }
  toggleEdit() {
    this.editing = !this.editing;
    this.draft = this.content;
  }
  handleDraft(e) {
    this.draft = e.detail.value;
  }
  async remove() {
    if (
      !(await confirm({
        title: `Remove ${this.current.path} from the workspace?`,
        message: 'The staged change is discarded; nothing is deployed.',
        confirmLabel: 'Remove',
        danger: true,
      }))
    )
      return;
    this.busy = true;
    try {
      await Api.deleteWorkspaceFile(this.sessionId, this.current.path);
      toast.success('File removed from workspace');
      this.editing = false;
      this.dispatchEvent(new CustomEvent('changed', { bubbles: true }));
    } catch (err) {
      toast.error('Could not remove file', err.message);
    } finally {
      this.busy = false;
    }
  }
  async save() {
    this.busy = true;
    try {
      await Api.putWorkspaceFile(this.sessionId, { path: this.current.path, content: this.draft });
      toast.success('File saved', 'The workspace was updated; validate again before deploying.');
      this.editing = false;
      this.dispatchEvent(new CustomEvent('changed', { bubbles: true }));
    } catch (err) {
      toast.error('Could not save file', err.message);
    } finally {
      this.busy = false;
    }
  }
}
