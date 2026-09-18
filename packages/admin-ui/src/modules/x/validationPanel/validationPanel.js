import { LightningElement, api } from 'lwc';
/** Deploy validation / deploy run panel. Accepts a `deploy.validation` event or a DeployRun. */
export default class ValidationPanel extends LightningElement {
  static renderMode = 'light';
  @api data;
  @api compact = false;
  get d() {
    return this.data || {};
  }
  get ok() {
    return this.d.ok === true || this.d.status === 'succeeded';
  }
  get pending() {
    return this.d.status === 'pending' || this.d.status === 'in_progress';
  }
  get title() {
    const kind = this.d.checkOnly === false ? 'Deploy' : this.d.scope === 'slice' ? 'Slice compile (not deploy-ready)' : 'Validation';
    return `${kind} attempt #${this.d.attempt ?? 1}`;
  }
  get statusLabel() {
    return this.pending ? 'running' : this.ok ? 'passed' : 'failed';
  }
  get cls() {
    return `rounded-xl border p-4 ${this.pending ? 'border-sky-500/30 bg-sky-500/5' : this.ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5'}`;
  }
  get icon() {
    return this.pending ? 'spinner' : this.ok ? 'check' : 'error';
  }
  get iconCls() {
    return `h-5 w-5 ${this.pending ? 'text-sky-700' : this.ok ? 'text-emerald-700' : 'text-rose-700'}`;
  }
  get componentsOk() {
    return (this.d.componentsTotal || 0) - (this.d.componentsFailed || 0);
  }
  get testsOk() {
    return (this.d.testsTotal || 0) - (this.d.testsFailed || 0);
  }
  get coverage() {
    return this.d.codeCoverage === null || this.d.codeCoverage === undefined ? '—' : `${Number(this.d.codeCoverage).toFixed(0)}%`;
  }
  get coverageCls() {
    const c = this.d.codeCoverage;
    return `text-lg font-semibold ${c === null || c === undefined ? 'text-content-muted' : c >= 75 ? 'text-emerald-700' : 'text-rose-700'}`;
  }
  get failures() {
    return (this.d.failures || []).map((f, i) => ({
      ...f,
      id: i,
      loc: f.lineNumber ? `L${f.lineNumber}${f.columnNumber ? ':' + f.columnNumber : ''}` : '',
      name: f.fullName || f.fileName || '—',
    }));
  }
  get hasFailures() {
    return this.failures.length > 0;
  }
  get compFailedCls() {
    return `text-lg font-semibold ${this.d.componentsFailed ? 'text-rose-700' : 'text-content'}`;
  }
  get testsFailedCls() {
    return `text-lg font-semibold ${this.d.testsFailed ? 'text-rose-700' : 'text-content'}`;
  }
  get sfId() {
    return this.d.sfDeployId || '';
  }
}
