import { LightningElement, api } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { isAdmin, isSuperadmin } from '../../../lib/rbac.js';
import { fmtUsd, fmtRelative } from '../../../lib/format.js';
import { navigate } from '../../../lib/router.js';

/** Dashboard: GET /admin/stats tiles (admins) + recent sessions + quick links. Users see their own sessions only. */
export default class DashboardPage extends LightningElement {
  static renderMode = 'light';
  @api user;
  loading = true;
  error = null;
  stats = null;
  sessions = [];
  partialErrors = [];

  connectedCallback() {
    this.load();
  }

  get admin() {
    return isAdmin(this.user);
  }
  get superadmin() {
    return isSuperadmin(this.user);
  }
  get greeting() {
    const h = new Date().getHours();
    const g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    return `${g}, ${this.firstName}`;
  }
  get firstName() {
    return (this.user?.displayName || '').split(' ')[0] || this.user?.email || '';
  }
  get ready() {
    return true;
  }
  get tilesCls() {
    return `grid gap-4 sm:grid-cols-2 ${this.admin ? 'lg:grid-cols-5' : 'lg:grid-cols-3'}`;
  }

  // tiles
  get pendingValue() {
    return Number(this.stats?.usersPending) || 0;
  }
  get pendingCount() {
    return String(this.pendingValue);
  }
  get pendingHint() {
    return this.pendingValue ? 'Awaiting your approval' : `All caught up · ${this.stats?.usersTotal ?? 0} users`;
  }
  get pendingTone() {
    return this.pendingValue ? 'amber' : 'emerald';
  }
  get sessions24h() {
    return this.stats ? String(this.stats.sessions24h ?? 0) : String(this.sessionsSince24h.length);
  }
  get sessionsSince24h() {
    const cutoff = Date.now() - 86400_000;
    return this.sessions.filter((s) => new Date(s.createdAt).getTime() >= cutoff);
  }
  get runningCount() {
    return this.sessions.filter((s) => s.status === 'running' || s.status === 'awaiting_confirmation').length;
  }
  get runningHint() {
    return this.runningCount ? `${this.runningCount} active right now` : 'None running';
  }
  get cost24h() {
    return fmtUsd(this.stats ? this.stats.cost24h : this.sessionsSince24h.reduce((a, s) => a + (Number(s.costUsd) || 0), 0));
  }
  get costHint() {
    return this.admin ? 'From usage records' : 'Your sessions';
  }
  get clientsCount() {
    return String(this.stats?.clients ?? 0);
  }
  get orgsCount() {
    return String(this.stats?.orgs ?? 0);
  }
  get orgsHint() {
    return `${this.stats?.orgs ?? 0} connected org${this.stats?.orgs === 1 ? '' : 's'}`;
  }
  get totalSessions() {
    return String(this.sessions.length);
  }
  get sessionsHref() {
    return '#/sessions';
  }
  get usageHref() {
    return this.admin ? '#/usage' : '#/sessions';
  }
  get clientsHref() {
    return this.superadmin ? '#/clients' : '#/sessions';
  }

  get recentSessions() {
    return [...this.sessions]
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
      .slice(0, 8)
      .map((s) => ({
        ...s,
        href: `#/sessions/${s.id}`,
        when: fmtRelative(s.updatedAt || s.createdAt),
        cost: fmtUsd(s.costUsd),
        helpfulIcon: s.helpful === true ? 'thumbUp' : s.helpful === false ? 'thumbDown' : null,
        helpfulCls: s.helpful ? 'h-4 w-4 text-emerald-700' : 'h-4 w-4 text-rose-700',
      }));
  }
  get hasRecent() {
    return this.recentSessions.length > 0;
  }
  get hasPartialErrors() {
    return this.partialErrors.length > 0;
  }
  get partialErrorText() {
    return this.partialErrors.join(' · ');
  }
  get quickLinks() {
    const all = [
      { id: 'users', label: 'Approve users', desc: 'Review pending registrations', icon: 'users', href: '#/users', roles: ['superadmin', 'admin'] },
      { id: 'clients', label: 'Clients & orgs', desc: 'Connect Salesforce orgs and GitHub repos', icon: 'clients', href: '#/clients', roles: ['superadmin'] },
      { id: 'ai', label: 'AI models', desc: 'Providers, models and role bindings', icon: 'ai', href: '#/ai', roles: ['superadmin'] },
      { id: 'skills', label: 'Skills', desc: 'Knowledge, policies and playbooks', icon: 'skills', href: '#/skills', roles: ['superadmin'] },
      { id: 'policy', label: 'Global policy', desc: 'Allow list, approvals and guardrails', icon: 'shield', href: '#/policy', roles: ['superadmin'] },
      { id: 'usage', label: 'Usage & cost', desc: 'Tokens and spend per user, client, model', icon: 'usage', href: '#/usage', roles: ['superadmin', 'admin'] },
      { id: 'audit', label: 'Audit log', desc: 'Security-relevant actions', icon: 'audit', href: '#/audit', roles: ['superadmin', 'admin'] },
      { id: 'pair', label: 'Pair extension', desc: 'Sign the Chrome side panel in', icon: 'pair', href: '#/pair', roles: ['superadmin', 'admin', 'user'] },
    ];
    return all.filter((l) => l.roles.includes(this.user?.role));
  }

  async load() {
    this.loading = true;
    this.error = null;
    this.partialErrors = [];
    const tasks = [];
    if (this.admin) {
      tasks.push(
        Api.stats()
          .then((r) => {
            this.stats = r;
          })
          .catch((e) => {
            this.stats = null;
            this.partialErrors.push(`Stats: ${e.message}`);
          }),
      );
      tasks.push(
        Api.adminSessions({ limit: 50 })
          .then((r) => {
            this.sessions = asList(r, 'sessions');
          })
          .catch((e) => this.partialErrors.push(`Sessions: ${e.message}`)),
      );
    } else {
      tasks.push(
        Api.listSessions({ mine: 1 })
          .then((r) => {
            this.sessions = asList(r, 'sessions');
          })
          .catch((e) => this.partialErrors.push(`Sessions: ${e.message}`)),
      );
    }
    await Promise.all(tasks);
    if (this.partialErrors.length && !this.sessions.length && !this.stats) {
      this.error = new Error(this.partialErrors.join('; '));
      this.partialErrors = [];
    }
    this.loading = false;
  }
  openSession(e) {
    navigate(`/sessions/${e.currentTarget.dataset.id}`);
  }
}
