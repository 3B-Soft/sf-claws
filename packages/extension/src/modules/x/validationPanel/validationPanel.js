import { api as http } from '../../../lib/state.js';
import { LightningElement, api } from 'lwc';
import { fmtDate, statusClass, statusLabel } from '../../../lib/format.js';

/** Renders either a deploy.validation event or a DeployRun. */
export default class ValidationPanel extends LightningElement {
  static renderMode = 'light';
  @api run;
  @api compact = false;
  showAll = false;

  get isRun() {
    return !!this.run && 'status' in this.run && !('kind' in this.run && this.run.kind === 'validation');
  }
  get ok() {
    return this.isRun ? this.run.status === 'succeeded' : !!this.run?.ok;
  }
  get pending() {
    return this.isRun && (this.run.status === 'pending' || this.run.status === 'in_progress');
  }
  get checkOnly() {
    return this.isRun ? !!this.run.checkOnly : true;
  }
  get title() {
    const what = this.checkOnly ? (this.run?.scope === 'slice' ? 'Slice compile (not deploy-ready)' : 'Validation') : 'Deployment';
    if (this.pending) return `${what} in progress…`;
    return `${what} ${this.ok ? 'passed' : 'failed'}`;
  }
  get attempt() {
    return this.run?.attempt ? `attempt #${this.run.attempt}` : '';
  }
  get cardCls() {
    return `rounded-xl border p-3 ${this.pending ? 'border-brand-500/40 bg-brand-500/5' : this.ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-rose-500/40 bg-rose-500/5'}`;
  }
  get titleCls() {
    return `text-[12px] font-semibold ${this.pending ? 'text-brand-700' : this.ok ? 'text-emerald-700' : 'text-rose-700'}`;
  }
  get componentsOk() {
    return Math.max(0, (this.run?.componentsTotal || 0) - (this.run?.componentsFailed || 0));
  }
  get componentsFailed() {
    return this.run?.componentsFailed || 0;
  }
  get componentsTotal() {
    return this.run?.componentsTotal || 0;
  }
  get testsOk() {
    return Math.max(0, (this.run?.testsTotal || 0) - (this.run?.testsFailed || 0));
  }
  get testsFailed() {
    return this.run?.testsFailed || 0;
  }
  get hasTests() {
    return (this.run?.testsTotal || 0) > 0;
  }
  get coverage() {
    return this.run?.codeCoverage == null ? '' : `${Math.round(this.run.codeCoverage)}%`;
  }
  get coverageCls() {
    const c = this.run?.codeCoverage;
    return `font-semibold ${c == null ? '' : c >= 75 ? 'text-emerald-700' : 'text-rose-700'}`;
  }
  get failures() {
    const list = this.run?.failures || [];
    return (this.showAll ? list : list.slice(0, 5)).map((f, i) => ({
      key: i,
      type: f.componentType || '',
      name: f.fullName || f.fileName || '',
      problem: f.problem,
      where: f.lineNumber ? `line ${f.lineNumber}${f.columnNumber ? `:${f.columnNumber}` : ''}` : '',
      problemType: f.problemType || '',
    }));
  }
  get failureCount() {
    return (this.run?.failures || []).length;
  }
  get hasFailures() {
    return this.failureCount > 0;
  }
  get moreCount() {
    return this.failureCount - 5;
  }
  get showMore() {
    return !this.showAll && this.failureCount > 5;
  }
  get when() {
    return fmtDate(this.run?.completedAt || this.run?.createdAt || this.run?.at);
  }
  get testLevel() {
    return this.run?.testLevel || '';
  }
  get statusCls() {
    return statusClass(this.run?.status);
  }
  get statusText() {
    return statusLabel(this.run?.status);
  }
  get compBarOk() {
    return `width:${this.componentsTotal ? (this.componentsOk / this.componentsTotal) * 100 : 0}%`;
  }

  downloading = false;
  downloadError = '';
  get canDownload() {
    return !!this.run?.sessionId && !!(this.run?.id || this.run?.deployId);
  }
  async download() {
    this.downloading = true;
    this.downloadError = '';
    try {
      const id = this.run.id || this.run.deployId;
      const data = await http.exportValidation(this.run.sessionId, id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `validation-${id}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      this.downloadError = err.message;
    } finally {
      this.downloading = false;
    }
  }
  onMore() {
    this.showAll = true;
  }
}
