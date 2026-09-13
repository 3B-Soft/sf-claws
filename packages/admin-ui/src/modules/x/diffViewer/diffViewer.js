import { LightningElement, api } from 'lwc';
import { lineDiff, patchToRows } from '../../../lib/diff.js';

/** Visual line diff. Either `original` + `content` (computes with jsdiff) or `patch` (unified diff). */
export default class DiffViewer extends LightningElement {
  static renderMode = 'light';
  @api original;
  @api content;
  @api patch;
  @api path = '';
  @api noCollapse = false;
  @api maxRows = 600;
  showAll = false;

  get model() {
    if (this.patch) {
      const rows = patchToRows(this.patch);
      return { rows, stats: { additions: rows.filter((r) => r.type === 'add').length, deletions: rows.filter((r) => r.type === 'del').length } };
    }
    const orig = this.original ?? '';
    const cur = this.content ?? '';
    if (!this.original && this.content) {
      const rows = cur.split('\n').map((text, i) => ({ id: i, type: 'add', oldNo: null, newNo: i + 1, text }));
      return { rows, stats: { additions: rows.length, deletions: 0 }, isNew: true };
    }
    return lineDiff(orig, cur, { collapse: !this.noCollapse && !this.showAll });
  }
  get rows() {
    const rows = this.model.rows.slice(0, this.showAll ? Infinity : this.maxRows);
    return rows.map((r) => ({
      ...r,
      cls: `diff-line ${r.type === 'add' ? 'diff-add' : r.type === 'del' ? 'diff-del' : r.type === 'hunk' ? 'diff-hunk' : ''}`,
      sign: r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ',
      oldNoText: r.oldNo ?? '',
      newNoText: r.newNo ?? '',
      isHunk: r.type === 'hunk',
    }));
  }
  get truncated() {
    return this.model.rows.length > this.maxRows && !this.showAll;
  }
  get hiddenCount() {
    return this.model.rows.length - this.maxRows;
  }
  get additions() {
    return this.model.stats.additions;
  }
  get deletions() {
    return this.model.stats.deletions;
  }
  get isEmpty() {
    return this.model.rows.length === 0;
  }
  get noChanges() {
    return !this.isEmpty && this.additions === 0 && this.deletions === 0;
  }
  get showToggle() {
    return !this.noCollapse && !this.patch && this.additions + this.deletions > 0;
  }
  get toggleLabel() {
    return this.showAll ? 'Collapse unchanged' : 'Show full file';
  }
  toggle() {
    this.showAll = !this.showAll;
  }
}
