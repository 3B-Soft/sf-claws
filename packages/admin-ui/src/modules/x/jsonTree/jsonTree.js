import { LightningElement, api } from 'lwc';
/** Collapsible JSON tree rendered as a flat list of indented rows (no recursion needed). */
export default class JsonTree extends LightningElement {
  static renderMode = 'light';
  @api value;
  @api maxDepth = 2; // auto-expanded depth
  collapsed = new Set();
  touched = false;

  get rows() {
    const out = [];
    const walk = (val, key, depth, path, isLast) => {
      const isObj = val !== null && typeof val === 'object';
      const isArr = Array.isArray(val);
      const keys = isObj ? Object.keys(val) : [];
      const autoCollapsed = depth >= Number(this.maxDepth) && keys.length > 0;
      const collapsed = this.touched ? this.collapsed.has(path) : autoCollapsed;
      const row = {
        id: path || '$',
        depth,
        pad: `padding-left:${depth * 14 + 6}px`,
        key,
        hasKey: key !== null && key !== undefined,
        isObj,
        collapsed,
        toggle: isObj && keys.length > 0,
        comma: !isLast,
        bracketOpen: isArr ? '[' : '{',
        bracketClose: isArr ? ']' : '}',
        count: keys.length,
        summary: isArr ? `${keys.length} item${keys.length === 1 ? '' : 's'}` : `${keys.length} key${keys.length === 1 ? '' : 's'}`,
        text: '',
        valCls: 'text-content',
      };
      if (!isObj) {
        if (typeof val === 'string') {
          row.text = JSON.stringify(val);
          row.valCls = 'text-emerald-700';
        } else if (typeof val === 'number') {
          row.text = String(val);
          row.valCls = 'text-sky-700';
        } else if (typeof val === 'boolean') {
          row.text = String(val);
          row.valCls = 'text-amber-700';
        } else {
          row.text = 'null';
          row.valCls = 'text-content-subtle';
        }
      }
      out.push(row);
      if (isObj && !collapsed) {
        keys.forEach((k, i) => walk(val[k], isArr ? null : k, depth + 1, `${path}/${k}`, i === keys.length - 1));
        out.push({
          id: `${path}/__close`,
          depth,
          pad: `padding-left:${depth * 14 + 6}px`,
          isClose: true,
          text: row.bracketClose + (isLast ? '' : ','),
          valCls: 'text-content-muted',
        });
      }
      return out;
    };
    walk(this.value, null, 0, '', true);
    if (this.touched) return out;
    // On first render compute the auto-collapsed set so toggles work from that state.
    return out;
  }
  toggle(e) {
    const id = e.currentTarget.dataset.id;
    if (!this.touched) {
      // seed collapsed set from current auto state
      this.collapsed = new Set(this.rows.filter((r) => r.collapsed).map((r) => r.id));
      this.touched = true;
    }
    const next = new Set(this.collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.collapsed = next;
  }
}
