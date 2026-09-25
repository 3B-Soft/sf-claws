import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { toast, confirm } from '../../../lib/store.js';
import { COMMIT_STRATEGIES } from '../../../lib/constants.js';
import { fmtRelative, shortSha, truncate } from '../../../lib/format.js';

/** GitHub repo settings + branches + compare + commits for a client. */
export default class GithubTab extends LightningElement {
  static renderMode = 'light';
  @api clientId;
  repo = null;
  loading = true;
  error = null;
  form = null;
  busy = false;
  section = 'settings';
  branches = [];
  branchesLoading = false;
  branchesError = null;
  commits = [];
  commitsBranch = '';
  commitsLoading = false;
  commitsError = null;
  compareBase = '';
  compareHead = '';
  testing = false;
  testResult = null;

  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      this.repo = await Api.getGithub(this.clientId);
      if (this.repo && !this.repo.owner) this.repo = null;
    } catch (e) {
      if (e.status === 404) this.repo = null;
      else this.error = e;
    } finally {
      this.loading = false;
    }
    this.form = this.repo
      ? { ...this.repo, token: '' }
      : {
          owner: '',
          repo: '',
          defaultBranch: 'main',
          sourceRoot: 'force-app/main/default',
          docsRoot: 'docs/harness',
          commitStrategy: 'branch-per-session',
          branchPrefix: 'harness/',
          token: '',
        };
    if (this.repo) {
      this.compareBase = this.repo.defaultBranch;
      this.commitsBranch = this.repo.defaultBranch;
      this.loadBranches();
    }
  }
  get configured() {
    return !!this.repo;
  }
  get testCls() {
    return `flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs ${this.testResult?.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/30 bg-rose-500/10 text-rose-700'}`;
  }
  get testIcon() {
    return this.testResult?.ok ? 'check' : 'error';
  }
  get testMessage() {
    return this.testResult?.message || (this.testResult?.ok ? 'Connection OK' : 'Connection failed');
  }
  get testExtra() {
    const r = this.testResult;
    if (!r?.ok) return '';
    const perms =
      r.permissions && typeof r.permissions === 'object'
        ? Object.entries(r.permissions)
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(', ')
        : '';
    return [r.defaultBranch ? `default branch ${r.defaultBranch}` : '', perms ? `permissions: ${perms}` : ''].filter(Boolean).join(' · ');
  }
  async test() {
    this.testing = true;
    this.testResult = null;
    try {
      const r = await Api.githubTest(this.clientId);
      this.testResult = { ...r, ok: r?.ok !== false };
    } catch (err) {
      this.testResult = { ok: false, message: err.message };
    } finally {
      this.testing = false;
    }
  }
  async remove() {
    if (
      !(await confirm({
        title: 'Remove GitHub settings?',
        message: 'The stored token is deleted. Sessions can no longer commit for this client until a repository is configured again.',
        confirmLabel: 'Remove',
        danger: true,
      }))
    )
      return;
    try {
      await Api.deleteGithub(this.clientId);
      toast.success('GitHub settings removed');
      this.section = 'settings';
      await this.load();
    } catch (err) {
      toast.error('Could not remove settings', err.message);
    }
  }
  get f() {
    return this.form || {};
  }
  get repoUrl() {
    return this.repo ? `https://github.com/${this.repo.owner}/${this.repo.repo}` : '';
  }
  get repoName() {
    return this.repo ? `${this.repo.owner}/${this.repo.repo}` : '';
  }
  get tokenLabel() {
    return this.repo?.hasToken ? 'Access token (leave blank to keep the current one)' : 'Access token';
  }
  get tokenHint() {
    return this.repo?.hasToken
      ? 'A token is available. Leave blank to keep it, or enter a repository-specific token to override the shared token.'
      : 'Optional when the server has GITHUB_TOKEN configured. A custom token overrides it and needs contents read/write on this repo.';
  }
  get tokenStatus() {
    return this.repo?.hasToken ? 'Token available' : 'No token';
  }
  get tokenColor() {
    return this.repo?.hasToken ? 'emerald' : 'amber';
  }
  get strategyOptions() {
    return COMMIT_STRATEGIES.map((s) => ({
      value: s,
      label: {
        direct: 'Direct to default branch',
        'branch-per-session': 'Branch per session',
        'branch-per-task': 'Branch per task',
        'pull-request': 'Pull request',
      }[s],
    }));
  }
  get strategyHint() {
    return (
      {
        direct: 'Commits land on the default branch without review — only for sandboxes.',
        'branch-per-session': 'Each session gets its own branch under the prefix; merge manually.',
        'branch-per-task': 'One branch per task, shared by all its sessions.',
        'pull-request': 'Branch per session plus an automatic pull request for review.',
      }[this.f.commitStrategy] || ''
    );
  }
  get cannotSave() {
    return this.busy || !this.f.owner?.trim() || !this.f.repo?.trim();
  }
  get sections() {
    return [
      { id: 'settings', label: 'Settings' },
      { id: 'branches', label: 'Branches', count: this.branches.length || undefined },
      { id: 'compare', label: 'Compare' },
      { id: 'org', label: 'Org sync' },
      { id: 'commits', label: 'Commits' },
    ];
  }
  get isSettings() {
    return this.section === 'settings';
  }
  get isBranches() {
    return this.section === 'branches';
  }
  get isCompare() {
    return this.section === 'compare';
  }
  get isOrgSync() {
    return this.section === 'org';
  }
  get isCommits() {
    return this.section === 'commits';
  }
  get branchRows() {
    const def = this.repo?.defaultBranch;
    const prefix = this.repo?.branchPrefix || 'harness/';
    return this.branches
      .map((b) => {
        const name = typeof b === 'string' ? b : b.name;
        const sha = typeof b === 'string' ? '' : b.sha || b.commit?.sha || '';
        return {
          id: name,
          name,
          sha: shortSha(sha),
          isDefault: name === def,
          isHarness: name.startsWith(prefix),
          url: `${this.repoUrl}/tree/${encodeURIComponent(name)}`,
          protectedFlag: typeof b === 'object' && !!b.protected,
        };
      })
      .sort((a, b) => b.isDefault - a.isDefault || b.isHarness - a.isHarness || a.name.localeCompare(b.name));
  }
  get branchOptions() {
    return this.branchRows.map((b) => ({ value: b.name, label: b.name }));
  }
  get commitRows() {
    return this.commits.map((c, i) => {
      const sha = c.sha || c.id || String(i);
      const msg = c.message || c.commit?.message || '';
      const author = c.author?.name || c.author || c.commit?.author?.name || '';
      const date = c.date || c.commit?.author?.date || c.createdAt;
      return {
        id: sha,
        sha: shortSha(sha),
        title: truncate(msg.split('\n')[0], 100),
        author,
        when: fmtRelative(date),
        url: c.url || c.html_url || `${this.repoUrl}/commit/${sha}`,
      };
    });
  }
  get hasCommits() {
    return this.commitRows.length > 0;
  }
  get hasBranches() {
    return this.branchRows.length > 0;
  }

  selectSection(e) {
    this.section = e.detail.id;
    if (this.section === 'commits' && !this.commits.length && !this.commitsLoading) this.loadCommits();
  }
  handleField(e) {
    this.form = { ...this.form, [e.detail.name]: e.detail.value };
  }
  async save() {
    this.busy = true;
    try {
      const f = this.form;
      const body = {
        owner: f.owner.trim(),
        repo: f.repo.trim(),
        defaultBranch: f.defaultBranch || 'main',
        sourceRoot: f.sourceRoot || 'force-app/main/default',
        docsRoot: f.docsRoot || 'docs/harness',
        commitStrategy: f.commitStrategy,
        branchPrefix: f.branchPrefix || 'harness/',
      };
      if (f.token?.trim()) body.token = f.token.trim();
      await Api.setGithub(this.clientId, body);
      toast.success('GitHub settings saved');
      await this.load();
    } catch (err) {
      toast.error('Could not save GitHub settings', err.message);
    } finally {
      this.busy = false;
    }
  }
  async loadBranches() {
    this.branchesLoading = true;
    this.branchesError = null;
    try {
      this.branches = asList(await Api.githubBranches(this.clientId), 'branches');
    } catch (e) {
      this.branchesError = e;
    } finally {
      this.branchesLoading = false;
    }
  }
  async loadCommits() {
    this.commitsLoading = true;
    this.commitsError = null;
    try {
      this.commits = asList(await Api.githubCommits(this.clientId, this.commitsBranch || this.repo?.defaultBranch), 'commits');
    } catch (e) {
      this.commitsError = e;
    } finally {
      this.commitsLoading = false;
    }
  }
  handleCommitsBranch(e) {
    this.commitsBranch = e.detail.value;
    this.loadCommits();
  }
  compareBranch(e) {
    this.compareHead = e.currentTarget.dataset.name;
    this.compareBase = this.repo?.defaultBranch || this.compareBase;
    this.section = 'compare';
  }
  commitsOf(e) {
    this.commitsBranch = e.currentTarget.dataset.name;
    this.section = 'commits';
    this.loadCommits();
  }
}
