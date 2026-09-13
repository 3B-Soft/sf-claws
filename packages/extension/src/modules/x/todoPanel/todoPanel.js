import { LightningElement, api } from 'lwc';

/** Live TODO list from `todo.updated` (pending ○ / in_progress ◐ / completed ● / blocked ⊘) with a progress bar. */
export default class TodoPanel extends LightningElement {
  static renderMode = 'light';
  @api items = [];
  collapsed = false;

  get list() {
    return Array.isArray(this.items) ? this.items : [];
  }
  get hasItems() {
    return this.list.length > 0;
  }
  get total() {
    return this.list.length;
  }
  get done() {
    return this.list.filter((t) => t.status === 'completed').length;
  }
  get inProgress() {
    return this.list.filter((t) => t.status === 'in_progress');
  }
  get blocked() {
    return this.list.filter((t) => t.status === 'blocked').length;
  }
  get percent() {
    return this.total ? Math.round((this.done / this.total) * 100) : 0;
  }
  get barStyle() {
    return `width:${this.percent}%`;
  }
  get barCls() {
    return `h-full rounded transition-all ${this.blocked ? 'bg-amber-400' : this.percent === 100 ? 'bg-emerald-400' : 'bg-brand-400'}`;
  }
  get summary() {
    const cur = this.inProgress[0];
    if (cur) return cur.activeForm || cur.content;
    if (this.percent === 100) return 'All steps completed';
    if (this.blocked) return `${this.blocked} step(s) blocked`;
    return 'Waiting to start';
  }
  get counter() {
    return `${this.done}/${this.total}`;
  }
  get toggle() {
    return this.collapsed ? '▸' : '▾';
  }
  get rows() {
    return this.list.map((t, i) => {
      const s = t.status;
      const glyph = s === 'completed' ? '●' : s === 'in_progress' ? '◐' : s === 'blocked' ? '⊘' : '○';
      const glyphCls = `w-4 shrink-0 text-center text-[13px] leading-5 ${s === 'completed' ? 'text-emerald-700' : s === 'in_progress' ? 'text-brand-600 pulse-dot' : s === 'blocked' ? 'text-amber-700' : 'text-content-subtle'}`;
      const textCls = `min-w-0 flex-1 text-[12px] leading-5 ${s === 'completed' ? 'text-content-subtle line-through decoration-line-strong' : s === 'in_progress' ? 'text-content-strong font-medium' : s === 'blocked' ? 'text-amber-700' : 'text-content'}`;
      return {
        key: t.id || i,
        glyph,
        glyphCls,
        textCls,
        text: s === 'in_progress' && t.activeForm ? t.activeForm : t.content,
        isBlocked: s === 'blocked',
        isActive: s === 'in_progress',
      };
    });
  }
  onToggle() {
    this.collapsed = !this.collapsed;
  }
}
