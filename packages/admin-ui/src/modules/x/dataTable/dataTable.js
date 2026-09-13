import { LightningElement, api } from 'lwc';
import { fmtDate, fmtRelative, fmtUsd, fmtTokens, fmtInt, truncate } from '../../../lib/format.js';

/**
 * Generic table. columns: [{ key, label, type, align, width, format(row), href(row), color(row), max }]
 * type: text | mono | badge | date | relative | usd | tokens | int | bool | link | percent
 * rows: objects with `id`. actions: [{ id, label, style: 'primary'|'secondary'|'danger'|'ghost', when(row) }]
 * Emits: rowclick {row}, action {id, row}.
 */
export default class DataTable extends LightningElement {
  static renderMode = 'light';
  @api columns = [];
  @api rows = [];
  @api actions = [];
  @api loading = false;
  @api error;
  @api clickable = false;
  @api emptyTitle = 'No results';
  @api emptyDescription = '';
  @api emptyIcon = 'inbox';
  @api dense = false;
  @api rowClass; // fn(row) -> string

  get hasActions() {
    return (this.actions || []).length > 0;
  }
  get isEmpty() {
    return !this.loading && !this.error && (!this.rows || this.rows.length === 0);
  }
  get showTable() {
    return !this.loading && !this.error && this.rows && this.rows.length > 0;
  }
  get tableCls() {
    return `table ${this.clickable ? 'table-hover' : ''} ${this.dense ? '[&_td]:py-1.5' : ''}`;
  }

  get headers() {
    return (this.columns || []).map((c) => ({ key: c.key, label: c.label ?? c.key, cls: `${c.align === 'right' ? 'text-right' : ''} ${c.width || ''}` }));
  }

  get viewRows() {
    const cols = this.columns || [];
    return (this.rows || []).map((row, i) => {
      const id = row.id ?? row.key ?? i;
      const cells = cols.map((c) => {
        const raw = typeof c.format === 'function' ? c.format(row) : getPath(row, c.key);
        const type = c.type || 'text';
        const cell = {
          key: `${id}-${c.key}`,
          type,
          text: '',
          cls: `${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.cls || ''}`,
          isBadge: false,
          isBool: false,
          isLink: false,
          href: null,
          color: null,
          isMono: false,
          isMuted: false,
        };
        switch (type) {
          case 'badge':
            cell.isBadge = true;
            cell.text = raw ?? '';
            cell.color = typeof c.color === 'function' ? c.color(row) : c.color;
            break;
          case 'date':
            cell.text = fmtDate(raw);
            cell.isMuted = true;
            break;
          case 'relative':
            cell.text = fmtRelative(raw);
            cell.isMuted = true;
            break;
          case 'usd':
            cell.text = fmtUsd(raw);
            cell.cls += ' tabular-nums';
            break;
          case 'tokens':
            cell.text = fmtTokens(raw);
            cell.cls += ' tabular-nums';
            break;
          case 'int':
            cell.text = fmtInt(raw);
            cell.cls += ' tabular-nums';
            break;
          case 'percent':
            cell.text = raw === null || raw === undefined ? '—' : `${Number(raw).toFixed(0)}%`;
            break;
          case 'bool':
            cell.isBool = true;
            cell.text = raw ? 'Yes' : 'No';
            cell.boolCls = raw ? 'text-emerald-700' : 'text-content-subtle';
            break;
          case 'mono':
            cell.isMono = true;
            cell.text = raw ?? '—';
            break;
          case 'link':
            cell.isLink = true;
            cell.text = raw ?? '—';
            cell.href = typeof c.href === 'function' ? c.href(row) : c.href;
            break;
          default:
            cell.text = raw === null || raw === undefined || raw === '' ? '—' : truncate(String(raw), c.max || 120);
        }
        return cell;
      });
      const acts = (this.actions || [])
        .filter((a) => (typeof a.when === 'function' ? a.when(row) : true))
        .map((a) => ({
          key: `${id}-${a.id}`,
          id: a.id,
          label: a.label,
          cls: `btn-${a.style || 'secondary'} btn-xs`,
          icon: a.icon,
        }));
      const extra = typeof this.rowClass === 'function' ? this.rowClass(row) || '' : '';
      return { id, row, cells, acts, cls: `${this.clickable ? 'cursor-pointer' : ''} ${extra}` };
    });
  }

  handleRow(e) {
    if (!this.clickable) return;
    const id = e.currentTarget.dataset.id;
    const vr = this.viewRows.find((r) => String(r.id) === id);
    if (vr) this.dispatchEvent(new CustomEvent('rowclick', { detail: { row: vr.row } }));
  }
  handleAction(e) {
    e.stopPropagation();
    const { id, action } = e.currentTarget.dataset;
    const vr = this.viewRows.find((r) => String(r.id) === id);
    if (vr) this.dispatchEvent(new CustomEvent('action', { detail: { id: action, row: vr.row } }));
  }
  stop(e) {
    e.stopPropagation();
  }
  retry() {
    this.dispatchEvent(new CustomEvent('retry'));
  }
}

function getPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path)
    .split('.')
    .reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}
