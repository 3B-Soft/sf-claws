import { LightningElement, api } from 'lwc';
/** Live TODO list (todo.updated / GET /sessions/:id/todos). pending ○ · in_progress ◐ (spinner + activeForm) · completed ● · blocked ⊘ */
export default class TodoPanel extends LightningElement {
  static renderMode = 'light';
  @api items = [];
  @api agents = [];
  collapsed = false;
  get list() {
    return this.items || [];
  }
  get done() {
    return this.list.filter((t) => t.status === 'completed').length;
  }
  get total() {
    return this.list.length;
  }
  get percentValue() {
    return this.total ? Math.round((this.done / this.total) * 100) : 0;
  }
  get percent() {
    return `${this.percentValue}%`;
  }
  get progressStyle() {
    return `width:${this.percentValue}%`;
  }
  get summary() {
    const active = this.list.find((t) => t.status === 'in_progress');
    return active ? `${this.done}/${this.total} done · ${active.activeForm || active.content}` : `${this.done}/${this.total} done`;
  }
  get chevron() {
    return this.collapsed ? 'chevronRight' : 'chevronDown';
  }
  get rows() {
    return this.list.map((t, i) => {
      const s = t.status;
      const meta = {
        pending: { glyph: '○', color: 'slate', icon: 'text-content-subtle' },
        in_progress: { glyph: '◐', color: 'sky', icon: 'text-brand-600' },
        completed: { glyph: '●', color: 'emerald', icon: 'text-emerald-700' },
        blocked: { glyph: '⊘', color: 'rose', icon: 'text-rose-700' },
      }[s] || { glyph: '○', color: 'slate', icon: 'text-content-subtle' };
      const owner = (this.agents || []).find((a) => a.agentId === t.ownerAgentId)?.role;
      return {
        id: t.id || i,
        status: s,
        color: meta.color,
        glyph: meta.glyph,
        inProgress: s === 'in_progress',
        text: s === 'in_progress' ? t.activeForm || t.content : t.content,
        owner: owner ? owner.replace(/_/g, ' ') : '',
        cls: `flex items-center gap-3 px-4 py-2 text-sm ${s === 'in_progress' ? 'bg-brand-500/5' : ''}`,
        iconCls: `flex h-5 w-5 shrink-0 items-center justify-center text-base leading-none ${meta.icon}`,
        textCls: s === 'completed' ? 'text-content-subtle line-through' : s === 'in_progress' ? 'text-content-strong' : 'text-content',
      };
    });
  }
  toggle() {
    this.collapsed = !this.collapsed;
  }
}
