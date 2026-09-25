import { LightningElement } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { AGENT_ROLES } from '../../../lib/constants.js';
import { toast, confirm } from '../../../lib/store.js';

/**
 * Knowledge sources and specialists — the two things a super admin configures to make the agents
 * understand this agency's products rather than Salesforce in the abstract.
 *
 * Both carry real weight: a source's credential is used by every session in scope, and a
 * specialist's instructions reach every session that consults it. The copy on this page says so
 * rather than presenting them as ordinary settings.
 */

/** Roles a specialist can be built on. The orchestrator delegates and cannot be delegated to. */
const DELEGATABLE_ROLES = AGENT_ROLES.filter((r) => r !== 'orchestrator' && r !== 'summarizer');

const EMPTY_SOURCE = { kind: 'docs', name: '', repoRef: '', guidance: '', scope: 'global', clientId: '', token: '', enabled: true };
const EMPTY_AGENT = { name: '', whenToUse: '', baseRole: 'explore', instructions: '', scope: 'global', clientId: '', enabled: true };

export default class KnowledgePage extends LightningElement {
  static renderMode = 'light';

  sources = [];
  agents = [];
  clients = [];
  form = null;
  formKind = null; // 'source' | 'agent'
  testResults = {};
  loading = true;
  busy = false;
  error = null;
  tab = 'sources';

  connectedCallback() {
    this.load();
  }

  async load() {
    this.loading = true;
    this.error = null;
    try {
      const [sources, agents, clients] = await Promise.all([Api.listKnowledge(), Api.listCustomAgents(), Api.listClients()]);
      this.sources = asList(sources, 'sources');
      this.agents = asList(agents, 'agents');
      this.clients = asList(clients, 'clients');
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }

  // ---- tabs -----------------------------------------------------------------
  get isSources() {
    return this.tab === 'sources';
  }
  get isAgents() {
    return this.tab === 'agents';
  }
  get sourcesTabCls() {
    return tabCls(this.isSources);
  }
  get agentsTabCls() {
    return tabCls(this.isAgents);
  }
  onTab(e) {
    this.tab = e.currentTarget.dataset.tab;
  }

  clientName(id) {
    return this.clients.find((c) => c.id === id)?.name ?? 'Unknown client';
  }

  // ---- rows -----------------------------------------------------------------
  get sourceRows() {
    return this.sources.map((s) => {
      const test = this.testResults[s.id];
      return {
        ...s,
        kindLabel: s.kind === 'docs' ? 'Documentation' : 'Source repository',
        scopeLabel: s.scope === 'global' ? 'All clients' : this.clientName(s.clientId),
        statusLabel: s.enabled ? 'Enabled' : 'Disabled',
        statusCls: `text-xs font-medium ${s.enabled ? 'text-emerald-700' : 'text-content-subtle'}`,
        tokenLabel: s.hasToken ? 'Access token available' : 'No access token — the agents cannot read this',
        tokenCls: `text-xs ${s.hasToken ? 'text-content-subtle' : 'text-amber-700'}`,
        hasTest: !!test,
        testMessage: test?.message,
        testCls: `mt-2 rounded-lg border px-2 py-1.5 text-xs ${test?.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/40 bg-rose-500/10 text-rose-700'}`,
      };
    });
  }
  get hasSources() {
    return this.sources.length > 0;
  }

  get agentRows() {
    return this.agents.map((a) => ({
      ...a,
      roleLabel: a.baseRole.replace(/_/g, ' '),
      scopeLabel: a.scope === 'global' ? 'All clients' : this.clientName(a.clientId),
      statusLabel: a.enabled ? 'Enabled' : 'Disabled',
      statusCls: `text-xs font-medium ${a.enabled ? 'text-emerald-700' : 'text-content-subtle'}`,
    }));
  }
  get hasAgents() {
    return this.agents.length > 0;
  }

  // ---- form -----------------------------------------------------------------
  get modalOpen() {
    return !!this.form;
  }
  get isSourceForm() {
    return this.formKind === 'source';
  }
  get isAgentForm() {
    return this.formKind === 'agent';
  }
  get modalTitle() {
    const noun = this.isSourceForm ? 'knowledge source' : 'specialist';
    return this.form?.id ? `Edit ${noun}` : `Add a ${noun}`;
  }
  get isClientScoped() {
    return this.form?.scope === 'client';
  }

  get kindOptions() {
    return [
      { value: 'docs', label: 'Documentation (markdown files)' },
      { value: 'repo', label: 'Source repository (searched on demand)' },
    ];
  }
  get scopeOptions() {
    return [
      { value: 'global', label: 'All clients' },
      { value: 'client', label: 'One client only' },
    ];
  }
  get clientOptions() {
    return this.clients.map((c) => ({ value: c.id, label: c.name }));
  }
  get baseRoleOptions() {
    return DELEGATABLE_ROLES.map((r) => ({ value: r, label: r.replace(/_/g, ' ') }));
  }
  get tokenHint() {
    return this.form?.id
      ? 'Leave blank to keep the current token or use the shared server token when no custom token is stored. A custom token overrides the shared token.'
      : 'Optional when the server has GITHUB_TOKEN configured. Add a custom token with read access to override it for this source.';
  }
  get repoRefHint() {
    return 'owner/repo, or owner/repo#branch to pin a branch.';
  }

  onNewSource() {
    this.formKind = 'source';
    this.form = { ...EMPTY_SOURCE };
  }
  onNewAgent() {
    this.formKind = 'agent';
    this.form = { ...EMPTY_AGENT };
  }
  onEditSource(e) {
    const s = this.sources.find((x) => x.id === e.currentTarget.dataset.id);
    this.formKind = 'source';
    // Never prefill the token: it is write-only, and blank means "leave it as it is".
    this.form = { ...s, clientId: s.clientId ?? '', token: '' };
  }
  onEditAgent(e) {
    const a = this.agents.find((x) => x.id === e.currentTarget.dataset.id);
    this.formKind = 'agent';
    this.form = { ...a, clientId: a.clientId ?? '' };
  }
  onCloseModal() {
    this.form = null;
    this.formKind = null;
  }
  onField(e) {
    const { name, value } = e.detail;
    this.form = { ...this.form, [name]: value };
  }

  async onSave() {
    const f = this.form;
    this.busy = true;
    try {
      if (this.isSourceForm) {
        const body = { kind: f.kind, name: f.name, repoRef: f.repoRef, guidance: f.guidance ?? '', scope: f.scope, enabled: !!f.enabled };
        if (f.scope === 'client') body.clientId = f.clientId;
        if (f.token) body.token = f.token;
        if (f.id) await Api.updateKnowledge(f.id, body);
        else await Api.createKnowledge(body);
        toast.success('Knowledge source saved');
      } else {
        const body = { name: f.name, whenToUse: f.whenToUse, baseRole: f.baseRole, instructions: f.instructions, scope: f.scope, enabled: !!f.enabled };
        if (f.scope === 'client') body.clientId = f.clientId;
        if (f.id) await Api.updateCustomAgent(f.id, body);
        else await Api.createCustomAgent(body);
        toast.success('Specialist saved');
      }
      this.onCloseModal();
      await this.load();
    } catch (e) {
      toast.error('Could not save', e.message);
    } finally {
      this.busy = false;
    }
  }

  async onDeleteSource(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await confirm({
      title: 'Remove this knowledge source?',
      message: 'Sessions will stop being able to search it. The repository itself is untouched.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await Api.deleteKnowledge(id);
      await this.load();
    } catch (err) {
      toast.error('Could not remove', err.message);
    }
  }

  async onDeleteAgent(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await confirm({
      title: 'Remove this specialist?',
      message: 'Agents will no longer be able to consult it.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await Api.deleteCustomAgent(id);
      await this.load();
    } catch (err) {
      toast.error('Could not remove', err.message);
    }
  }

  async onTestSource(e) {
    const id = e.currentTarget.dataset.id;
    this.testResults = { ...this.testResults, [id]: { ok: true, message: 'Checking…' } };
    try {
      const r = await Api.testKnowledge(id);
      this.testResults = { ...this.testResults, [id]: { ok: r.ok, message: r.message } };
    } catch (err) {
      this.testResults = { ...this.testResults, [id]: { ok: false, message: err.message } };
    }
  }
}

const tabCls = (active) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium ${active ? 'bg-brand-500 text-white' : 'text-content-muted hover:bg-surface-sunken hover:text-content'}`;
