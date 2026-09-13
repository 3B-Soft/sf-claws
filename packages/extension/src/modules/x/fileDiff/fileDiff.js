import { LightningElement, api } from 'lwc';
import { lineDiff, sideBySide, collapseContext, parsePatch } from '../../../lib/diff.js';

/** Visual line diff. Provide original+modified, or a unified `patch`. Side-by-side on wide panels, unified when narrow. */
export default class FileDiff extends LightningElement {
  static renderMode = 'light';
  @api original = '';
  @api modified = '';
  @api patch = null;
  @api forceUnified = false;
  @api context = 3;
  wide = false;
  _ro = null;

  connectedCallback() {
    this._onResize = () => {
      this.wide = (this.clientWidth || window.innerWidth) >= 640;
    };
    window.addEventListener('resize', this._onResize);
  }
  renderedCallback() {
    if (!this._ro && typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._onResize());
      this._ro.observe(this);
    }
    const w = (this.clientWidth || window.innerWidth) >= 640;
    if (w !== this.wide) this.wide = w;
  }
  disconnectedCallback() {
    window.removeEventListener('resize', this._onResize);
    this._ro?.disconnect();
  }

  get diff() {
    if (this.patch != null) {
      const rows = parsePatch(this.patch);
      return { rows, additions: rows.filter((r) => r.type === 'add').length, deletions: rows.filter((r) => r.type === 'del').length };
    }
    return lineDiff(this.original || '', this.modified || '');
  }
  get rows() {
    return this.patch != null ? this.diff.rows : collapseContext(this.diff.rows, this.context);
  }
  get stats() {
    const d = this.diff;
    return `+${d.additions} −${d.deletions}`;
  }
  get sideBySideMode() {
    return this.wide && !this.forceUnified && this.patch == null;
  }
  get unifiedRows() {
    return this.rows.map((r, i) => {
      if (r.type === 'gap') return { key: i, gap: true, text: `… ${r.count} unchanged lines …` };
      if (r.type === 'hunk') return { key: i, gap: true, text: r.text };
      const add = r.type === 'add',
        del = r.type === 'del';
      return {
        key: i,
        gap: false,
        ln: r.ln ?? '',
        rn: r.rn ?? '',
        text: add ? r.right : r.left,
        sign: add ? '+' : del ? '−' : ' ',
        cls: `flex font-mono text-[11px] leading-5 ${add ? 'bg-emerald-500/15 text-emerald-700' : del ? 'bg-rose-500/15 text-rose-700' : 'text-content'}`,
      };
    });
  }
  get sbsRows() {
    return sideBySide(this.rows.filter((r) => r.type !== 'gap')).map((r, i) => ({
      key: i,
      ln: r.ln ?? '',
      rn: r.rn ?? '',
      l: r.l,
      r: r.r,
      lcls: `min-w-0 flex-1 truncate whitespace-pre px-1 ${r.lt === 'del' ? 'bg-rose-500/15 text-rose-700' : r.lt === 'empty' ? 'bg-surface' : 'text-content'}`,
      rcls: `min-w-0 flex-1 truncate whitespace-pre px-1 ${r.rt === 'add' ? 'bg-emerald-500/15 text-emerald-700' : r.rt === 'empty' ? 'bg-surface' : 'text-content'}`,
    }));
  }
  get isEmpty() {
    return this.rows.length === 0;
  }
}
