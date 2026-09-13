import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { toast, confirm } from '../../../lib/store.js';
import { SKILL_KINDS } from '../../../lib/constants.js';
import { ROLE_META } from '../../../lib/constants.js';
import { fmtRelative, truncate } from '../../../lib/format.js';

/** Skills table + editor modal. Global (no clientId) or scoped to a client. */
export default class SkillsList extends LightningElement {
  static renderMode = 'light';
  @api clientId;
  @api clientName;
  @api get openSkillId() {
    return this._openId;
  }
  set openSkillId(v) {
    this._openId = v;
    this._tryOpenFromId();
  }
  _openId = null;
  skills = [];
  clients = [];
  loading = true;
  error = null;
  kind = 'all';
  search = '';
  modalOpen = false;
  editing = null;
  busy = false;

  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      const [skills, clients] = await Promise.all([
        Api.listSkills(this.clientId ? { clientId: this.clientId } : {}).then((r) => asList(r, 'skills')),
        this.clientId
          ? Promise.resolve([])
          : Api.listClients()
              .then((r) => asList(r, 'clients'))
              .catch(() => []),
      ]);
      this.skills = skills;
      this.clients = clients;
      this._tryOpenFromId();
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  _tryOpenFromId() {
    if (!this._openId || this.loading) return;
    if (this._openId === 'new') {
      this.editing = null;
      this.modalOpen = true;
      return;
    }
    const s = this.skills.find((x) => x.id === this._openId);
    if (s) {
      this.editing = s;
      this.modalOpen = true;
    }
  }
  get kindFilters() {
    return ['all', ...SKILL_KINDS].map((k) => ({
      id: k,
      label: k[0].toUpperCase() + k.slice(1),
      cls: `btn-sm ${this.kind === k ? 'btn-primary' : 'btn-secondary'}`,
    }));
  }
  get rows() {
    const q = this.search.trim().toLowerCase();
    return this.skills
      .filter((s) => (this.kind === 'all' || s.kind === this.kind) && (!q || s.name.toLowerCase().includes(q) || (s.content || '').toLowerCase().includes(q)))
      .sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name))
      .map((s) => ({
        ...s,
        rolesText: s.roles?.length ? s.roles.map((r) => ROLE_META[r]?.label || r).join(', ') : 'All roles',
        excerpt: truncate(
          (s.content || '')
            .replace(/[#*`>_]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
          110,
        ),
        when: fmtRelative(s.updatedAt),
        versionText: `v${s.version ?? 1}`,
        clientLabel: s.scope === 'global' ? '' : this.clients.find((c) => c.id === s.clientId)?.name || this.clientName || s.clientId || '',
        enabledLabel: s.enabled === false ? 'disabled' : 'enabled',
        rowCls: `group cursor-pointer ${s.enabled === false ? 'opacity-60' : ''}`,
        toggleLabel: s.enabled === false ? 'Enable' : 'Disable',
      }));
  }
  get hasRows() {
    return this.rows.length > 0;
  }
  get isEmpty() {
    return !this.loading && !this.error && this.skills.length === 0;
  }
  get modalTitle() {
    return this.editing ? `Edit skill · ${this.editing.name}` : 'New skill';
  }
  get emptyDescription() {
    return this.clientId
      ? 'Client-specific knowledge, policies and playbooks live here and are merged with global skills.'
      : 'Skills are markdown files injected into agent system prompts: knowledge, policies, quality rules and playbooks.';
  }

  setKind(e) {
    this.kind = e.currentTarget.dataset.id;
  }
  handleSearch(e) {
    this.search = e.detail.value;
  }
  openNew() {
    this.editing = null;
    this.modalOpen = true;
  }
  edit(e) {
    this.editing = this.skills.find((s) => s.id === e.currentTarget.dataset.id) || null;
    this.modalOpen = true;
  }
  closeModal() {
    this.modalOpen = false;
    this.editing = null;
    this.dispatchEvent(new CustomEvent('closed'));
  }
  async submit(e) {
    this.busy = true;
    try {
      if (this.editing) await Api.updateSkill(this.editing.id, e.detail.body);
      else await Api.createSkill(e.detail.body);
      toast.success(this.editing ? 'Skill updated' : 'Skill created');
      this.modalOpen = false;
      this.editing = null;
      this.dispatchEvent(new CustomEvent('closed'));
      await this.load();
    } catch (err) {
      toast.error('Could not save skill', err.message);
    } finally {
      this.busy = false;
    }
  }
  async toggle(e) {
    e.stopPropagation();
    const s = this.skills.find((x) => x.id === e.currentTarget.dataset.id);
    if (!s) return;
    try {
      await Api.updateSkill(s.id, { enabled: s.enabled === false });
      toast.success(s.enabled === false ? 'Skill enabled' : 'Skill disabled');
      await this.load();
    } catch (err) {
      toast.error('Could not update skill', err.message);
    }
  }
  async remove(e) {
    e.stopPropagation();
    const s = this.skills.find((x) => x.id === e.currentTarget.dataset.id);
    if (!s) return;
    if (
      !(await confirm({
        title: `Delete "${s.name}"?`,
        message: 'Agents will no longer receive this skill. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      await Api.deleteSkill(s.id);
      toast.success('Skill deleted');
      await this.load();
    } catch (err) {
      toast.error('Could not delete skill', err.message);
    }
  }
}
