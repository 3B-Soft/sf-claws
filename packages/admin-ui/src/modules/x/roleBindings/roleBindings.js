import { LightningElement, api } from 'lwc';
import { AGENT_ROLES, roleMeta, EFFORTS } from '../../../lib/constants.js';
import { Api } from '../../../lib/api.js';
import { toast } from '../../../lib/store.js';

/** Role -> model bindings editor: one row per AgentRole. PUT /admin/role-bindings with the full array. */
export default class RoleBindings extends LightningElement {
  static renderMode = 'light';
  @api models = [];
  @api bindings = [];
  draft = {};
  dirty = false;
  busy = false;
  _seeded = null;

  renderedCallback() {
    const key = JSON.stringify([this.bindings || [], (this.models || []).map((m) => m.id)]);
    if (this._seeded !== key) {
      this._seeded = key;
      this.seed();
    }
  }
  seed() {
    const d = {};
    AGENT_ROLES.forEach((role) => {
      const b = (this.bindings || []).find((x) => x.role === role);
      // Bindings reference AiModel.id; older rows may still carry the provider model id — map them to the catalogue entry.
      const m = b && (this.models || []).find((x) => x.id === b.modelId || x.modelId === b.modelId);
      d[role] = { role, modelId: m?.id || b?.modelId || '', effort: b?.effort || 'high', maxIterations: b?.maxIterations || 40 };
    });
    this.draft = d;
    this.dirty = false;
  }
  get modelOptions() {
    return (this.models || []).filter((m) => m.enabled !== false).map((m) => ({ value: m.id, label: `${m.label} · ${m.provider} · ${m.modelId}` }));
  }
  get effortOptions() {
    return EFFORTS.map((e) => ({ value: e, label: e }));
  }
  get rows() {
    return AGENT_ROLES.map((role) => {
      const d = this.draft[role] || {};
      const model = (this.models || []).find((m) => m.id === d.modelId);
      return {
        role,
        label: roleMeta(role).label,
        desc: roleMeta(role).desc,
        color: roleMeta(role).color,
        modelId: d.modelId,
        effort: d.effort,
        maxIterations: d.maxIterations,
        thinking: !!model?.supportsThinking,
        missing: !d.modelId,
        cost: model ? `$${model.inputCostPerM}/$${model.outputCostPerM}` : '',
      };
    });
  }
  get missingCount() {
    return this.rows.filter((r) => r.missing).length;
  }
  get hasModels() {
    return this.modelOptions.length > 0;
  }
  get cannotSave() {
    return this.busy || !this.dirty;
  }
  update(e) {
    const { role, field } = e.target.closest('[data-role]').dataset;
    const name = e.detail?.name || field;
    let value = e.detail?.value;
    if (name === 'maxIterations') value = Math.max(1, parseInt(value, 10) || 1);
    this.draft = { ...this.draft, [role]: { ...this.draft[role], [name]: value } };
    this.dirty = true;
  }
  async save() {
    const body = AGENT_ROLES.map((r) => this.draft[r])
      .filter((b) => b.modelId)
      .map((b) => ({ role: b.role, modelId: b.modelId, effort: b.effort, maxIterations: Number(b.maxIterations) }));
    this.busy = true;
    try {
      await Api.setRoleBindings(body);
      toast.success('Role bindings saved');
      this.dirty = false;
      this.dispatchEvent(new CustomEvent('saved'));
    } catch (err) {
      toast.error('Could not save bindings', err.message);
    } finally {
      this.busy = false;
    }
  }
  reset() {
    this.seed();
  }
}
