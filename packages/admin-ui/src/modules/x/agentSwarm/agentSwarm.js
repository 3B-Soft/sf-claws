import { LightningElement, api } from 'lwc';
import { ROLE_META, COLOR_CLASSES } from '../../../lib/constants.js';
import { truncate } from '../../../lib/format.js';

/** Swarm panel: agents spawned during the session with role, model, objective and status. */
export default class AgentSwarm extends LightningElement {
  static renderMode = 'light';
  @api agents = [];
  collapsed = false;
  get items() {
    const list = this.agents || [];
    const depthOf = (a, d = 0) => (a.parentAgentId && d < 6 ? depthOf(list.find((x) => x.agentId === a.parentAgentId) || {}, d + 1) : d);
    return list.map((a) => {
      const meta = ROLE_META[a.role] || { label: a.role, color: 'slate' };
      return {
        id: a.agentId,
        label: meta.label,
        chipCls: `chip ${COLOR_CLASSES[meta.color]}`,
        modelId: a.modelId || '',
        objective: truncate(a.objective || '', 140),
        summary: truncate(a.summary || '', 160),
        running: a.status === 'running',
        ok: a.status === 'finished',
        failed: a.status === 'failed',
        style: `margin-left:${Math.min(depthOf(a), 4) * 16}px`,
        rowCls: `flex items-start gap-3 rounded-lg border px-3 py-2 ${a.status === 'failed' ? 'border-rose-500/30 bg-rose-500/5' : a.status === 'running' ? 'border-brand-500/30 bg-brand-500/5' : 'border-line bg-canvas'}`,
      };
    });
  }
  get count() {
    return (this.agents || []).length;
  }
  get running() {
    return (this.agents || []).filter((a) => a.status === 'running').length;
  }
  get summary() {
    return this.running ? `${this.count} agents · ${this.running} running` : `${this.count} agents`;
  }
  get chevron() {
    return this.collapsed ? 'chevronRight' : 'chevronDown';
  }
  toggle() {
    this.collapsed = !this.collapsed;
  }
}
