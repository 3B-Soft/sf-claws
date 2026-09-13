import { LightningElement, api } from 'lwc';
import { toCsv } from '../../../lib/format.js';

export default class DataTable extends LightningElement {
  static renderMode = 'light';
  @api columns = [];
  @api rows = [];
  @api instanceUrl = '';
  @api compact = false;
  @api exportName = 'query';
  @api maxRows = 500;
  copied = ''; // '' | ok | fail
  _copyTimer = null;

  get cols() {
    return (this.columns || []).map((c) => ({ name: c, isId: c === 'Id' || /\.Id$/.test(c) }));
  }
  get viewRows() {
    const cols = this.cols;
    return (this.rows || []).slice(0, this.maxRows).map((r, i) => ({
      key: r.Id || i,
      cells: cols.map((c) => {
        const v = r[c.name];
        const text = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        const link = c.isId && this.instanceUrl && /^[a-zA-Z0-9]{15,18}$/.test(text) ? `${this.instanceUrl.replace(/\/$/, '')}/${text}` : '';
        return { key: c.name, text, link, isBool: typeof v === 'boolean', isEmpty: v == null, isNum: typeof v === 'number' };
      }),
    }));
  }
  get hasRows() {
    return (this.rows || []).length > 0;
  }
  get truncated() {
    return (this.rows || []).length > this.maxRows;
  }
  get countText() {
    return `${(this.rows || []).length} row(s)`;
  }
  get cellCls() {
    return this.compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-[12px]';
  }
  get copyLabel() {
    return this.copied === 'ok' ? 'Copied CSV ✓' : this.copied === 'fail' ? 'Copy failed' : 'Copy CSV';
  }
  get copyCls() {
    return `rounded border px-1.5 py-0.5 text-[10px] ${this.copied === 'ok' ? 'border-emerald-500/40 text-emerald-700' : this.copied === 'fail' ? 'border-rose-500/40 text-rose-700' : 'border-line-strong text-content hover:bg-surface-sunken'}`;
  }
  disconnectedCallback() {
    if (this._copyTimer) clearTimeout(this._copyTimer);
  }

  /** CSV export goes to the clipboard: file downloads are often blocked inside the side panel. */
  async onExport() {
    const csv = toCsv(this.columns || [], this.rows || []);
    let ok = false;
    try {
      await navigator.clipboard.writeText(csv);
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok) {
      // Fallback: hidden textarea + execCommand for contexts without the async clipboard API.
      try {
        const ta = document.createElement('textarea');
        ta.value = csv;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch {
        ok = false;
      }
    }
    this.copied = ok ? 'ok' : 'fail';
    if (this._copyTimer) clearTimeout(this._copyTimer);
    this._copyTimer = setTimeout(() => {
      this.copied = '';
    }, 2500);
  }
}
