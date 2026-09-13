import { LightningElement, api } from 'lwc';
/** Ordered transcript blocks + swarm panel. Re-dispatches nothing; child events bubble in light DOM. */
export default class Transcript extends LightningElement {
  static renderMode = 'light';
  @api blocks = [];
  @api agents = [];
  @api proMode = false;
  @api readonly = false;
  @api busy = false;
  @api live = false;
  @api todos = [];
  get hasTodos() {
    return (this.todos || []).length > 0;
  }
  get hasAgents() {
    return (this.agents || []).length > 0;
  }
  get hasBlocks() {
    return (this.blocks || []).length > 0;
  }
  get items() {
    return (this.blocks || []).filter((b) => this.proMode || b.kind !== 'raw');
  }
}
