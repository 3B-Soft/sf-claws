import { LightningElement, api } from 'lwc';
import { fmtDate } from '../../../lib/format.js';
export default class DeploysTab extends LightningElement {
  static renderMode = 'light';
  @api deploys = [];
  get list() {
    return [...(this.deploys || [])]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((d) => ({
        ...d,
        when: fmtDate(d.createdAt),
        kind: d.checkOnly ? (d.scope === 'slice' ? 'Slice compile (not deploy-ready)' : 'Validation (check only)') : 'Deploy',
        panel: { ...d, ok: d.status === 'succeeded' },
      }));
  }
  get hasList() {
    return this.list.length > 0;
  }
}
