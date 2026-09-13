import { LightningElement, api } from 'lwc';
import { Api } from '../../../lib/api.js';
import { toast } from '../../../lib/store.js';
import { parsePermissionRule } from '@sf-claws/shared';
import { DEFAULT_POLICY, IMPACT_COMMANDS, IMPACT_META, IMPACT_SUBJECTS } from '../../../lib/constants.js';

const splitPatterns = (s) =>
  String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Rules for one command, as rule strings. No scope text means the unscoped command. */
const rulesFor = (command, scope) => (splitPatterns(scope).length ? splitPatterns(scope).map((p) => `${command}(${p})`) : [command]);

/** The scope text for a command: its patterns joined, or '' when it is allowed unscoped. */
const scopeOf = (list, command) => {
  const mine = (list || []).map(parsePermissionRule).filter((r) => r && r.command === command);
  return mine.some((r) => r.pattern === null) ? '' : mine.map((r) => r.pattern).join(', ');
};
const covers = (list, command) => (list || []).some((r) => parsePermissionRule(r)?.command === command);

const NEVER_SESSION = new Set(['deploy', 'github_commit']);

/**
 * PolicyRules editor. GET /admin/policy?clientId= -> { effective, global, override }; PUT writes the global
 * policy (no clientId) or the client override. The form edits the *effective* rules so admins see what applies.
 */
export default class PolicyTab extends LightningElement {
  static renderMode = 'light';
  @api clientId;
  effective = null;
  override = null;
  form = null;
  loading = true;
  error = null;
  busy = false;

  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      const res = await Api.getPolicy(this.clientId);
      // Tolerate a bare PolicyRules object as well as the { effective, global, override } envelope.
      const eff = res?.effective || (res && !('global' in res) ? res : null) || {};
      this.effective = { ...DEFAULT_POLICY, ...eff };
      this.override = this.clientId ? res?.override || {} : null;
    } catch (e) {
      if (e.status === 404) {
        this.effective = { ...DEFAULT_POLICY };
        this.override = {};
      } else this.error = e;
    } finally {
      this.loading = false;
    }
    if (this.effective) this.form = this.toForm(this.effective);
  }
  toForm(p) {
    return {
      ...p,
      forbiddenMetadataTypes: (p.forbiddenMetadataTypes || []).join('\n'),
      protectedComponents: (p.protectedComponents || []).join('\n'),
      impactAllowList: [...(p.impactAllowList || [])],
      impactDenyList: (p.impactDenyList || []).join('\n'),
      sessionAllowable: [...(p.sessionAllowable || [])],
    };
  }
  get f() {
    return this.form || {};
  }
  get isClient() {
    return !!this.clientId;
  }
  get scopeLabel() {
    return this.clientId ? "Client policy (effective rules = global default merged with this client's overrides)" : 'Global default policy';
  }
  get dirty() {
    return !!this.form && JSON.stringify(this.body()) !== JSON.stringify(this.normalize(this.effective));
  }
  get cannotSave() {
    return this.busy || !this.dirty || !!this.coverageError || !!this.warnError || !!this.denyError;
  }
  /** A malformed rule saved silently would read as "denied" while denying nothing. */
  get denyError() {
    const bad = this.lines(this.f.impactDenyList).filter((r) => !parsePermissionRule(r));
    return bad.length ? `Not a permission rule: ${bad.join(', ')}. Use a command name, optionally scoped: delete_record(Account).` : '';
  }
  get scopeError() {
    const bad = (this.f.impactAllowList || []).filter((r) => !parsePermissionRule(r));
    return bad.length ? `Not a permission rule: ${bad.join(', ')}.` : '';
  }
  get coverageError() {
    const v = Number(this.f.minCodeCoverage);
    return v < 0 || v > 100 ? 'Must be between 0 and 100' : '';
  }
  get planOptions() {
    return [
      { value: 'always', label: 'Always — every change needs an approved plan' },
      { value: 'nontrivial', label: 'Non-trivial only — a single simple component goes straight through' },
      { value: 'never', label: 'Never — no plan gate (not recommended)' },
    ];
  }
  get warnError() {
    const v = Number(this.f.apiLimitWarnPercent);
    return v < 1 || v > 100 ? 'Must be between 1 and 100' : '';
  }
  get overrideChips() {
    return Object.keys(this.override || {}).map((k) => ({ id: k, label: k }));
  }
  get hasOverrides() {
    return this.overrideChips.length > 0;
  }
  get commandRows() {
    return IMPACT_COMMANDS.map((id) => {
      const on = covers(this.f.impactAllowList, id);
      const s = covers(this.f.sessionAllowable, id);
      const never = NEVER_SESSION.has(id);
      return {
        id,
        label: IMPACT_META[id]?.label || id,
        desc: IMPACT_META[id]?.desc || '',
        scope: scopeOf(this.f.impactAllowList, id),
        scopePlaceholder: on ? 'everything' : '',
        scopeHint: IMPACT_SUBJECTS[id] || '',
        scopeDisabled: !on,
        rowCls: on ? '' : 'opacity-60',
        allowCls: `btn-xs ${on ? 'btn-primary' : 'btn-secondary'}`,
        allowLabel: on ? 'Allowed' : 'Refused',
        sessionCls: `btn-xs ${s && on && !never ? 'bg-emerald-600 text-white btn' : 'btn-secondary'}`,
        sessionLabel: never ? 'Never' : s ? 'Yes' : 'Ask each time',
        sessionDisabled: never || !on,
        sessionTitle: never ? 'Deploys and commits always require an explicit approval.' : !on ? 'Enable the command first.' : '',
      };
    });
  }

  handle(e) {
    this.form = { ...this.form, [e.detail.name]: e.detail.value };
  }
  toggleList(e) {
    const { id, list } = e.currentTarget.dataset;
    const on = covers(this.form[list], id);
    // Turning a command off drops every rule for it, scoped ones included.
    const rest = (this.form[list] || []).filter((r) => parsePermissionRule(r)?.command !== id);
    const next = { ...this.form, [list]: on ? rest : [...rest, id] };
    if (list === 'impactAllowList' && on) next.sessionAllowable = (next.sessionAllowable || []).filter((r) => parsePermissionRule(r)?.command !== id);
    this.form = this.ordered(next);
  }
  /** Edit one command's scope patterns. Empty means unscoped, which is how it was before scoping existed. */
  editScope(e) {
    const id = e.currentTarget.dataset.id;
    const rest = (this.form.impactAllowList || []).filter((r) => parsePermissionRule(r)?.command !== id);
    this.form = this.ordered({ ...this.form, impactAllowList: [...rest, ...rulesFor(id, e.target.value)] });
  }
  /** Keep both lists in command order so a reordering edit never reads as a change. */
  ordered(form) {
    const sort = (list) =>
      [...(list || [])].sort((a, b) => {
        const ca = IMPACT_COMMANDS.indexOf(parsePermissionRule(a)?.command);
        const cb = IMPACT_COMMANDS.indexOf(parsePermissionRule(b)?.command);
        return ca === cb ? String(a).localeCompare(String(b)) : ca - cb;
      });
    return { ...form, impactAllowList: sort(form.impactAllowList), sessionAllowable: sort(form.sessionAllowable) };
  }
  normalize(p) {
    return {
      forbiddenMetadataTypes: [...(p.forbiddenMetadataTypes || [])],
      protectedComponents: [...(p.protectedComponents || [])],
      requireTestsForApex: !!p.requireTestsForApex,
      minCodeCoverage: Number(p.minCodeCoverage) || 0,
      alwaysConfirmDeploy: !!p.alwaysConfirmDeploy,
      productionRequiresProMode: !!p.productionRequiresProMode,
      maxComponentsPerDeploy: Number(p.maxComponentsPerDeploy) || 200,
      allowDataModification: !!p.allowDataModification,
      // Rule strings pass through untouched: filtering against the bare command names would delete
      // every scoped rule the moment an admin opened this page and saved.
      impactAllowList: this.ordered(p).impactAllowList,
      impactDenyList: [...(p.impactDenyList || [])],
      sessionAllowable: this.ordered(p).sessionAllowable.filter((r) => !NEVER_SESSION.has(parsePermissionRule(r)?.command)),
      apiLimitWarnPercent: Number(p.apiLimitWarnPercent) || 80,
      // Spend ceilings and plan strictness must round-trip even though most admins never touch them.
      // Leaving them out did not "keep the default": PUT replaces the whole rules object, so every
      // save silently reset the ceilings to 0, which means unlimited.
      maxSessionCostUsd: Number(p.maxSessionCostUsd) || 0,
      maxTurnCostUsd: Number(p.maxTurnCostUsd) || 0,
      maxClientMonthlyCostUsd: Number(p.maxClientMonthlyCostUsd) || 0,
      costCeilingDocReserveUsd: Number(p.costCeilingDocReserveUsd) || 0,
      requirePlanApproval: ['always', 'nontrivial', 'never'].includes(p.requirePlanApproval) ? p.requirePlanApproval : 'nontrivial',
    };
  }
  lines(s) {
    return String(s || '')
      .split(/\r?\n|,/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  body() {
    const f = this.form;
    const lines = (s) => this.lines(s);
    return this.normalize({
      ...f,
      forbiddenMetadataTypes: lines(f.forbiddenMetadataTypes),
      protectedComponents: lines(f.protectedComponents),
      // Deny rules are one per line, not comma-split: a pattern may legitimately contain a comma.
      impactDenyList: String(f.impactDenyList || '')
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean),
      minCodeCoverage: Math.min(100, Math.max(0, Number(f.minCodeCoverage) || 0)),
      maxComponentsPerDeploy: Math.max(1, parseInt(f.maxComponentsPerDeploy, 10) || 200),
      apiLimitWarnPercent: Math.min(100, Math.max(1, parseInt(f.apiLimitWarnPercent, 10) || 80)),
    });
  }
  async save() {
    this.busy = true;
    try {
      await Api.setPolicy(this.clientId, this.body());
      toast.success('Policy saved');
      await this.load();
    } catch (err) {
      toast.error('Could not save policy', err.message);
    } finally {
      this.busy = false;
    }
  }
  reset() {
    this.form = this.toForm(this.effective);
  }
}
