import { LightningElement, api } from 'lwc';
import { DEFAULT_PACKAGE_XML } from '@sf-claws/shared';
import { Api, asList } from '../../../lib/api.js';
import { toast, confirm, authStore } from '../../../lib/store.js';
import { isSuperadmin } from '../../../lib/rbac.js';

/** Compare an org's metadata (by package.xml) with a branch, and pull it into the branch (super admin). */
export default class OrgSync extends LightningElement {
  static renderMode = 'light';
  @api clientId;
  @api defaultBranch = 'main';
  orgs = [];
  orgId = '';
  branch = '';
  packageXml = DEFAULT_PACKAGE_XML;
  message = '';
  result = null;
  running = null; // 'diff' | 'pull'
  error = null;
  expanded = new Set();

  async connectedCallback() {
    this.branch = this.defaultBranch;
    try {
      this.orgs = asList(await Api.listOrgs(this.clientId), 'orgs');
      this.orgId = this.orgs[0]?.id || '';
    } catch (e) {
      this.error = e;
    }
  }
  get orgOptions() {
    return this.orgs.map((o) => ({ value: o.id, label: `${o.label}${o.kind ? ` (${o.kind})` : ''}` }));
  }
  get canPull() {
    return isSuperadmin(authStore.get().user);
  }
  get cannotRun() {
    return !!this.running || !this.orgId || !this.branch.trim() || !this.packageXml.trim();
  }
  get diffing() {
    return this.running === 'diff';
  }
  get pulling() {
    return this.running === 'pull';
  }
  get files() {
    return (this.result?.files || []).map((f) => ({
      ...f,
      id: f.path,
      open: this.expanded.has(f.path),
      label: { added: 'only in org', removed: 'only in branch', modified: 'differs' }[f.status] || f.status,
      statusColor: f.status === 'added' ? 'emerald' : f.status === 'removed' ? 'rose' : 'amber',
      component: f.metadataType ? `${f.metadataType} · ${f.fullName || ''}` : '',
      hasPatch: !!f.patch,
      chevron: this.expanded.has(f.path) ? 'chevronDown' : 'chevronRight',
    }));
  }
  get hasFiles() {
    return this.files.length > 0;
  }
  get summary() {
    const r = this.result;
    if (!r) return '';
    const n = (s) => r.files.filter((f) => f.status === s).length;
    return `${n('modified')} differ · ${n('added')} only in org · ${n('removed')} only in branch · ${r.identical} identical${r.branchExists ? '' : ' · branch does not exist yet'}`;
  }
  body() {
    return { orgId: this.orgId, branch: this.branch.trim(), packageXml: this.packageXml, message: this.message.trim() || undefined };
  }
  handleField(e) {
    this[e.detail.name] = e.detail.value;
  }
  resetXml() {
    this.packageXml = DEFAULT_PACKAGE_XML;
  }
  async diff() {
    this.running = 'diff';
    this.error = null;
    this.result = null;
    try {
      this.result = await Api.githubOrgDiff(this.clientId, this.body());
      this.expanded = new Set(
        this.result.files
          .filter((f) => f.status === 'modified')
          .slice(0, 3)
          .map((f) => f.path),
      );
    } catch (e) {
      this.error = e;
    } finally {
      this.running = null;
    }
  }
  async pull() {
    const org = this.orgs.find((o) => o.id === this.orgId);
    if (
      !(await confirm({
        title: `Pull ${org?.label || 'org'} into ${this.branch}?`,
        message:
          'Every file in the manifest that differs from the branch is committed with the org’s version. The branch is created from the default branch if missing. Nothing is deleted.',
        confirmLabel: 'Pull and commit',
      }))
    )
      return;
    this.running = 'pull';
    try {
      const r = await Api.githubOrgPull(this.clientId, this.body());
      if (r.sha) toast.success(`Committed ${r.filesChanged} file${r.filesChanged === 1 ? '' : 's'} to ${r.branch}`);
      else toast.success(`${r.branch} already matches the org`);
      this.dispatchEvent(new CustomEvent('pulled'));
    } catch (e) {
      toast.error('Pull failed', e.message);
    } finally {
      this.running = null;
    }
  }
  toggle(e) {
    const p = e.currentTarget.dataset.path;
    const n = new Set(this.expanded);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    this.expanded = n;
  }
}
