import { LightningElement, api } from 'lwc';
import { analyzeSessionTiming } from '@sf-claws/shared';
import { Api } from '../../../lib/api.js';
import { toast } from '../../../lib/store.js';
import { fmtTokens } from '../../../lib/format.js';

const duration = (ms) => `${(ms / 60000).toFixed(1)} min`;
export default class SessionTiming extends LightningElement {
  static renderMode = 'light';
  _events = [];
  _timing = analyzeSessionTiming([]);
  @api get events() {
    return this._events;
  }
  set events(value) {
    this._events = value ?? [];
    this._timing = analyzeSessionTiming(this._events);
  }
  @api sessionId;
  exporting = false;

  get timing() {
    return this._timing;
  }
  get summary() {
    const t = this.timing;
    const model = t.modelTimingAvailable ? duration(t.modelOnlyMs) : 'Unknown';
    const overlap = t.modelTimingAvailable ? duration(t.modelAndToolMs) : 'Unknown';
    return `Active ${duration(t.activeMs)} · Waiting for you ${duration(t.userWaitMs)} · Model only ${model} · Tools ${duration(t.toolOnlyMs)} · Model/tool overlap ${overlap} · Unattributed ${duration(t.unattributedActiveMs)}`;
  }
  get missingTelemetry() {
    return !this.timing.modelTimingAvailable;
  }
  get incomplete() {
    return this.timing.incompleteSpans > 0;
  }
  get rows() {
    const t = this.timing,
      width = Math.max(1, t.end - t.start);
    return t.agents.map((a) => ({
      ...a,
      label: `${a.role} (${a.agentId})`,
      modelTime: a.modelCalls ? duration(a.modelOnlyMs + a.modelAndToolMs) : 'Unknown',
      toolTime: duration(a.toolOnlyMs + a.modelAndToolMs),
      output: a.usage ? fmtTokens(a.usage.outputTokens) : 'Unknown',
      barStyle: `margin-left:${Math.max(0, Math.min(100, ((a.start - t.start) / width) * 100))}%;width:${Math.max(0.2, Math.min(100, ((a.end - a.start) / width) * 100))}%`,
    }));
  }
  get phases() {
    return this.timing.phaseUsage.map((r, i) => ({
      ...r,
      id: String(i),
      input: fmtTokens(r.usage.inputTokens),
      output: fmtTokens(r.usage.outputTokens),
      cached: fmtTokens(r.usage.cachedInputTokens),
    }));
  }
  async download() {
    this.exporting = true;
    try {
      const blob = await Api.exportSession(this.sessionId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `session-${this.sessionId}.ndjson`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error('Could not export session', e.message);
    } finally {
      this.exporting = false;
    }
  }
}
