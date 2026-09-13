import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { ROLE_META, COLOR_CLASSES } from '../../../lib/constants.js';
import { fmtRelative, fmtDate } from '../../../lib/format.js';

/** Scratchpad notes for a session: GET /sessions/:id/notes, rendered as markdown. Re-fetches when `version` changes (note.written). */
export default class NotesPanel extends LightningElement {
  static renderMode = 'light';
  @api sessionId;
  @api get version() {
    return this._v;
  }
  set version(v) {
    if (v !== this._v) {
      this._v = v;
      if (this._loaded) this.load();
    }
  }
  @api get selectedId() {
    return this._sel;
  }
  set selectedId(v) {
    this._sel = v || null;
  }
  _v = 0;
  _sel = null;
  _loaded = false;
  notes = [];
  loading = true;
  error = null;

  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = !this._loaded;
    this.error = null;
    try {
      this.notes = asList(await Api.sessionNotes(this.sessionId), 'notes');
      this._loaded = true;
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  get sorted() {
    return [...this.notes].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  }
  get current() {
    return this.sorted.find((n) => n.id === this._sel) || this.sorted[0] || null;
  }
  get hasNotes() {
    return this.notes.length > 0;
  }
  get list() {
    return this.sorted.map((n) => {
      const meta = ROLE_META[n.role] || { label: n.role, color: 'slate' };
      return {
        ...n,
        roleLabel: meta.label,
        chipCls: `chip ${COLOR_CLASSES[meta.color] || COLOR_CLASSES.slate}`,
        when: fmtRelative(n.updatedAt || n.createdAt),
        cls: `flex w-full flex-col rounded-lg px-2.5 py-2 text-left ${n.id === this.current?.id ? 'bg-brand-50 font-medium text-brand-700 ring-1 ring-inset ring-brand-500/30' : 'text-content hover:bg-surface-sunken'}`,
      };
    });
  }
  get currentRole() {
    return ROLE_META[this.current?.role]?.label || this.current?.role || '';
  }
  get currentChipCls() {
    return `chip ${COLOR_CLASSES[ROLE_META[this.current?.role]?.color] || COLOR_CLASSES.slate}`;
  }
  get currentTags() {
    return (this.current?.tags || []).map((t) => ({ id: t, label: t }));
  }
  get currentWhen() {
    return fmtDate(this.current?.updatedAt || this.current?.createdAt);
  }
  select(e) {
    this._sel = e.currentTarget.dataset.id;
  }
}
