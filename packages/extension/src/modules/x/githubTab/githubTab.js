import { LightningElement } from 'lwc';
import { appStore, api as http } from '../../../lib/state.js';
import { sessionStore } from '../../../lib/sessionController.js';
import { asList } from '../../../lib/api.js';
import { fmtRelative, truncate } from '../../../lib/format.js';

export default class GithubTab extends LightningElement {
  static renderMode = 'light';
  state = appStore.get();
  session = sessionStore.get();
  repo = null;
  repoState = 'loading'; // loading | ready | none | error
  error = '';
  branches = [];
  head = '';
  base = '';
  compare = null;
  compareLoading = false;
  compareError = '';
  commits = [];
  commitsLoading = false;
  openFile = null;
  view = 'compare'; // compare | commits
  _unsubs = [];
  _clientId = null;
  _lastTick = -1;

  connectedCallback() {
    this._unsubs.push(
      appStore.subscribe((s) => {
        this.state = s;
        if (s.client?.id !== this._clientId || s.reloadTick !== this._lastTick) {
          this._clientId = s.client?.id || null;
          this._lastTick = s.reloadTick;
          this.load();
        }
      }),
    );
    this._unsubs.push(
      sessionStore.subscribe((s) => {
        const prev = this.session.sessionId;
        const prevBranch = this.session.session?.branchName;
        this.session = s;
        if ((prev !== s.sessionId || prevBranch !== s.session?.branchName) && this.branches.length) this.pickDefaultHead();
      }),
    );
  }
  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  get clientId() {
    return this.state.client?.id || this.state.org?.clientId;
  }
  get repoName() {
    return this.repo ? `${this.repo.owner}/${this.repo.repo}` : '';
  }
  get repoUrl() {
    return this.repo ? `https://github.com/${this.repo.owner}/${this.repo.repo}` : '';
  }
  get repoReady() {
    return this.repoState === 'ready';
  }
  get repoNone() {
    return this.repoState === 'none';
  }
  get repoError() {
    return this.repoState === 'error';
  }
  get repoLoading() {
    return this.repoState === 'loading';
  }
  get repoMeta() {
    return this.repo ? `${this.repo.commitStrategy} · ${this.repo.sourceRoot}` : '';
  }
  get tokenCls() {
    return `rounded px-1 text-[10px] ${this.repo?.hasToken ? 'bg-emerald-500/15 text-emerald-700' : 'bg-rose-500/15 text-rose-700'}`;
  }
  get tokenText() {
    return this.repo?.hasToken ? 'token ok' : 'no token';
  }
  get branchOptions() {
    return this.branches.map((b) => ({ value: b, label: b, selected: b === this.head }));
  }
  get baseOptions() {
    return this.branches.map((b) => ({ value: b, label: b, selected: b === this.base }));
  }
  get hasBranches() {
    return this.branches.length > 0;
  }
  get isCompare() {
    return this.view === 'compare';
  }
  get isCommits() {
    return this.view === 'commits';
  }
  get compareCls() {
    return this.btn(this.isCompare);
  }
  get commitsCls() {
    return this.btn(this.isCommits);
  }
  btn(a) {
    return `rounded-lg px-3 py-1 text-[12px] font-medium ${a ? 'bg-surface-sunken text-content-strong' : 'text-content-muted hover:text-content'}`;
  }
  get compareSummary() {
    const c = this.compare;
    return c ? `${c.aheadBy} ahead · ${c.behindBy} behind · ${c.files?.length || 0} file(s)` : '';
  }
  get compareUrl() {
    return this.compare?.url || '';
  }
  get files() {
    return (this.compare?.files || []).map((f) => ({
      ...f,
      key: f.path,
      name: f.fullName || f.path.split('/').pop(),
      open: this.openFile === f.path,
      stats: `+${f.additions} −${f.deletions}`,
      hasPatch: !!f.patch,
      badgeCls: `inline-flex w-16 shrink-0 items-center justify-center rounded-md border px-1 py-0.5 text-[10px] font-medium ${f.status === 'added' ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700' : f.status === 'removed' ? 'border-rose-500/30 bg-rose-500/15 text-rose-700' : 'border-amber-500/30 bg-amber-500/15 text-amber-700'}`,
      cls: `flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${this.openFile === f.path ? 'bg-brand-500/10' : 'hover:bg-surface-sunken'}`,
    }));
  }
  get hasFiles() {
    return this.files.length > 0;
  }
  get compareEmpty() {
    return this.compare && !this.files.length;
  }
  get sameBranch() {
    return this.head && this.head === this.base;
  }
  get commitRows() {
    return this.commits.map((c) => {
      const sha = c.sha || c.oid || '';
      const msg = c.message || c.commit?.message || '';
      const author = c.author?.name || c.commit?.author?.name || c.author?.login || c.author || '';
      const date = c.date || c.commit?.author?.date || c.commit?.committer?.date || c.createdAt || '';
      return {
        key: sha || msg,
        sha: sha.slice(0, 7),
        title: truncate(msg.split('\n')[0], 100),
        author,
        when: fmtRelative(date),
        url: c.url || c.html_url || (this.repo ? `${this.repoUrl}/commit/${sha}` : ''),
      };
    });
  }
  get hasCommits() {
    return this.commitRows.length > 0;
  }
  get sessionBranchHint() {
    return this.sessionBranch || (this.session.sessionId ? `${this.repo?.branchPrefix || 'harness/'}…` : '');
  }
  get sessionBranchMissing() {
    return !!this.sessionBranch && !this.branches.includes(this.sessionBranch);
  }

  async load() {
    if (!this.clientId) {
      this.repoState = 'none';
      return;
    }
    this.repoState = 'loading';
    this.error = '';
    this.compare = null;
    this.commits = [];
    try {
      const r = await http.github(this.clientId);
      this.repo = r?.repo || r;
      if (!this.repo?.owner) {
        this.repoState = 'none';
        return;
      }
      this.repoState = 'ready';
      this.base = this.repo.defaultBranch || 'main';
      await this.loadBranches();
    } catch (e) {
      if (e.isNotFound) {
        this.repoState = 'none';
        return;
      }
      this.repoState = 'error';
      this.error = e.message;
    }
  }
  async loadBranches() {
    try {
      const list = asList(await http.githubBranches(this.clientId))
        .map((b) => (typeof b === 'string' ? b : b.name))
        .filter(Boolean);
      this.branches = list;
      if (!list.includes(this.base) && list.length) this.base = list[0];
      this.pickDefaultHead();
    } catch (e) {
      this.error = e.message;
    }
  }
  get sessionBranch() {
    return this.session.session?.branchName || '';
  }
  pickDefaultHead() {
    const prefix = this.repo?.branchPrefix || 'harness/';
    const sid = this.session.sessionId;
    const named = this.sessionBranch && this.branches.includes(this.sessionBranch) ? this.sessionBranch : '';
    const candidates = sid ? this.branches.filter((b) => b.includes(sid)) : [];
    const sessionBranch = named || candidates[0] || this.branches.find((b) => b.startsWith(prefix) && b !== this.base);
    this.head = sessionBranch || this.branches.find((b) => b !== this.base) || this.base;
    this.runCompare();
    this.loadCommits();
  }
  async runCompare() {
    if (!this.head || !this.base) return;
    if (this.head === this.base) {
      this.compare = null;
      return;
    }
    this.compareLoading = true;
    this.compareError = '';
    this.openFile = null;
    try {
      this.compare = await http.githubCompare(this.clientId, this.base, this.head);
    } catch (e) {
      this.compareError = e.message;
      this.compare = null;
    } finally {
      this.compareLoading = false;
    }
  }
  async loadCommits() {
    if (!this.head) return;
    this.commitsLoading = true;
    try {
      this.commits = asList(await http.githubCommits(this.clientId, this.head));
    } catch (e) {
      this.error = e.message;
    } finally {
      this.commitsLoading = false;
    }
  }
  onHead(e) {
    this.head = e.target.value;
    this.runCompare();
    this.loadCommits();
  }
  onBase(e) {
    this.base = e.target.value;
    this.runCompare();
  }
  onView(e) {
    this.view = e.currentTarget.dataset.view;
  }
  onFile(e) {
    const p = e.currentTarget.dataset.path;
    this.openFile = this.openFile === p ? null : p;
  }
  onReload() {
    this.load();
  }
}
