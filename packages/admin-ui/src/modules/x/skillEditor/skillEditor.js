import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { AGENT_ROLES, roleMeta, SKILL_KINDS, SKILL_SCOPES } from '../../../lib/constants.js';
import { fmtDate } from '../../../lib/format.js';

/** Skill create/edit form with markdown textarea + live preview. Emits 'submit' {body}, 'cancel'. */
export default class SkillEditor extends LightningElement {
  static renderMode = 'light';
  @api skill; // existing or null
  @api clients = [];
  @api lockedClientId; // when used inside a client tab
  @api busy = false;
  form = null;
  orgs = [];
  view = 'split'; // edit | split | preview
  _key = null;

  renderedCallback() {
    const key = `${this.skill?.id || 'new'}:${this.lockedClientId || ''}`;
    if (this._key !== key) {
      this._key = key;
      const s = this.skill;
      this.form = s
        ? {
            name: s.name,
            kind: s.kind,
            scope: s.scope,
            clientId: s.clientId || '',
            orgId: s.orgId || '',
            roles: [...(s.roles || [])],
            content: s.content,
            enabled: s.enabled !== false,
          }
        : {
            name: '',
            kind: 'knowledge',
            scope: this.lockedClientId ? 'client' : 'global',
            clientId: this.lockedClientId || '',
            orgId: '',
            roles: [],
            content: '',
            enabled: true,
          };
      if (this.form.clientId) this.loadOrgs(this.form.clientId);
    }
  }
  async loadOrgs(clientId) {
    try {
      this.orgs = asList(await Api.listOrgs(clientId), 'orgs');
    } catch {
      this.orgs = [];
    }
  }

  get f() {
    return this.form || {};
  }
  get isEdit() {
    return !!this.skill;
  }
  get kindOptions() {
    return SKILL_KINDS.map((k) => ({
      value: k,
      label: {
        knowledge: 'Knowledge — how our packages/patterns work',
        policy: 'Policy — restrictions, approvals, commit rules',
        quality: 'Quality — naming, code quality, tests',
        playbook: 'Playbook — step-by-step recipes',
      }[k],
    }));
  }
  get scopeOptions() {
    return SKILL_SCOPES.filter((s) => !this.lockedClientId || s !== 'global').map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }));
  }
  get clientOptions() {
    return (this.clients || []).map((c) => ({ value: c.id, label: c.name }));
  }
  get orgOptions() {
    return this.orgs.map((o) => ({ value: o.id, label: `${o.label} (${o.kind})` }));
  }
  get needsClient() {
    return this.f.scope === 'client' || this.f.scope === 'org';
  }
  get needsOrg() {
    return this.f.scope === 'org';
  }
  get clientLocked() {
    return !!this.lockedClientId;
  }
  get roleChips() {
    return AGENT_ROLES.map((r) => ({
      id: r,
      label: roleMeta(r).label,
      cls: `chip cursor-pointer select-none transition-colors ${this.f.roles?.includes(r) ? 'border-brand-500/50 bg-brand-500/20 text-brand-700' : 'border-line-strong bg-surface-sunken text-content-muted hover:text-content'}`,
    }));
  }
  get rolesHint() {
    return this.f.roles?.length ? `Injected into ${this.f.roles.length} role(s).` : 'No roles selected = every agent receives this skill.';
  }
  get views() {
    return ['edit', 'split', 'preview'].map((v) => ({
      id: v,
      label: v[0].toUpperCase() + v.slice(1),
      cls: `btn-xs ${this.view === v ? 'btn-primary' : 'btn-ghost'}`,
    }));
  }
  get showEdit() {
    return this.view !== 'preview';
  }
  get showPreview() {
    return this.view !== 'edit';
  }
  get gridCls() {
    return `grid gap-3 ${this.view === 'split' ? 'lg:grid-cols-2' : ''}`;
  }
  get cannotSubmit() {
    return this.busy || !this.f.name?.trim() || !this.f.content?.trim() || (this.needsClient && !this.f.clientId) || (this.needsOrg && !this.f.orgId);
  }
  get version() {
    return this.skill ? `v${this.skill.version} · updated ${fmtDate(this.skill.updatedAt)}${this.skill.updatedBy ? ' by ' + this.skill.updatedBy : ''}` : '';
  }
  get wordCount() {
    return `${(this.f.content || '').trim().split(/\s+/).filter(Boolean).length} words`;
  }

  handle(e) {
    const { name, value } = e.detail;
    const next = { ...this.form, [name]: value };
    if (name === 'scope' && value === 'global') {
      next.clientId = '';
      next.orgId = '';
    }
    if (name === 'clientId') {
      next.orgId = '';
      if (value) this.loadOrgs(value);
      else this.orgs = [];
    }
    this.form = next;
  }
  toggleRole(e) {
    const r = e.currentTarget.dataset.id;
    const roles = this.f.roles.includes(r) ? this.f.roles.filter((x) => x !== r) : [...this.f.roles, r];
    this.form = { ...this.form, roles };
  }
  setView(e) {
    this.view = e.currentTarget.dataset.id;
  }
  submit() {
    const f = this.form;
    const body = {
      name: f.name.trim(),
      kind: f.kind,
      scope: f.scope,
      clientId: this.needsClient ? f.clientId : null,
      orgId: this.needsOrg ? f.orgId : null,
      roles: f.roles,
      content: f.content,
      enabled: !!f.enabled,
    };
    this.dispatchEvent(new CustomEvent('submit', { detail: { body } }));
  }
  cancel() {
    this.dispatchEvent(new CustomEvent('cancel'));
  }
}
