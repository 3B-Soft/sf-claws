import { LightningElement } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { toast, confirm } from '../../../lib/store.js';
import { AI_PROVIDERS } from '../../../lib/constants.js';

export default class AiPage extends LightningElement {
  static renderMode = 'light';
  providers = [];
  models = [];
  bindings = [];
  loading = true;
  error = null;
  modalOpen = false;
  editing = null;
  busy = false;

  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    const errs = [];
    await Promise.all([
      Api.listProviders()
        .then((r) => {
          this.providers = asList(r, 'providers');
        })
        .catch((e) => errs.push(e)),
      Api.listModels()
        .then((r) => {
          this.models = asList(r, 'models');
        })
        .catch((e) => errs.push(e)),
      Api.getRoleBindings()
        .then((r) => {
          this.bindings = asList(r, 'bindings');
        })
        .catch((e) => errs.push(e)),
    ]);
    if (errs.length === 3) this.error = errs[0];
    else if (errs.length) toast.warning('Some data failed to load', errs.map((e) => e.message).join('; '));
    this.loading = false;
  }
  /** One card per provider in the shared enum, so a new provider needs no template change. */
  get providerCards() {
    return AI_PROVIDERS.map((p) => ({ provider: p, credential: this.providers.find((c) => c.provider === p) }));
  }
  get modelColumns() {
    return [
      { key: 'provider', label: 'Provider', type: 'badge' },
      { key: 'label', label: 'Label' },
      { key: 'modelId', label: 'Model id', type: 'mono' },
      { key: 'inputCostPerM', label: 'In $/1M', align: 'right', format: (m) => `$${Number(m.inputCostPerM).toFixed(2)}` },
      { key: 'outputCostPerM', label: 'Out $/1M', align: 'right', format: (m) => `$${Number(m.outputCostPerM).toFixed(2)}` },
      {
        key: 'cachedInputCostPerM',
        label: 'Cached $/1M',
        align: 'right',
        format: (m) => (m.cachedInputCostPerM === null || m.cachedInputCostPerM === undefined ? '—' : `$${Number(m.cachedInputCostPerM).toFixed(3)}`),
      },
      { key: 'contextWindow', label: 'Context', type: 'tokens', align: 'right' },
      { key: 'supportsThinking', label: 'Thinking', type: 'bool' },
      { key: 'enabled', label: 'Status', type: 'badge', format: (m) => (m.enabled ? 'enabled' : 'disabled') },
    ];
  }
  get modelActions() {
    return [
      { id: 'edit', label: 'Edit', style: 'secondary' },
      { id: 'toggle', label: 'Disable', style: 'ghost', when: (m) => m.enabled },
      { id: 'toggle', label: 'Enable', style: 'ghost', when: (m) => !m.enabled },
      { id: 'delete', label: 'Delete', style: 'danger' },
    ];
  }
  get sortedModels() {
    return [...this.models].sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
  }
  get modalTitle() {
    return this.editing ? `Edit ${this.editing.label}` : 'Add model';
  }

  openAdd() {
    this.editing = null;
    this.modalOpen = true;
  }
  closeModal() {
    this.modalOpen = false;
    this.editing = null;
  }
  async handleModelAction(e) {
    const { id, row } = e.detail;
    if (id === 'edit') {
      this.editing = row;
      this.modalOpen = true;
      return;
    }
    if (id === 'toggle') {
      await this.run(() => Api.updateModel(row.id, { enabled: !row.enabled }), row.enabled ? 'Model disabled' : 'Model enabled');
      return;
    }
    if (id === 'delete') {
      const bound = this.bindings.filter((b) => b.modelId === row.id || b.modelId === row.modelId).map((b) => b.role);
      const ok = await confirm({
        title: `Delete ${row.label}?`,
        message: bound.length
          ? `This model is bound to: ${bound.join(', ')}. The server refuses to delete a bound model — rebind those roles first.`
          : 'This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (ok) await this.run(() => Api.deleteModel(row.id), 'Model deleted');
    }
  }
  async submitModel(e) {
    const body = e.detail.body;
    const ok = await this.run(
      () => (this.editing ? Api.updateModel(this.editing.id, body) : Api.createModel(body)),
      this.editing ? 'Model updated' : 'Model added',
    );
    if (ok) this.closeModal();
  }
  async run(fn, okMsg) {
    this.busy = true;
    try {
      await fn();
      toast.success(okMsg);
      await this.load();
      return true;
    } catch (err) {
      toast.error('Action failed', err.message);
      return false;
    } finally {
      this.busy = false;
    }
  }
  reload() {
    this.load();
  }
}
