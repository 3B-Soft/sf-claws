import { LightningElement, api } from 'lwc';
import { COLOR_CLASSES, statusColor } from '../../../lib/constants.js';
import { titleCase } from '../../../lib/format.js';

/** Small status chip. `value` decides color unless `color` is given. `label` overrides text. */
export default class Badge extends LightningElement {
  static renderMode = 'light';
  @api value;
  @api label;
  @api color;
  @api dot = false;
  @api raw = false;
  get text() {
    return this.label ?? (this.raw ? this.value : titleCase(this.value ?? ''));
  }
  get colorKey() {
    return this.color || statusColor(this.value);
  }
  get cls() {
    return `chip ${COLOR_CLASSES[this.colorKey] || COLOR_CLASSES.slate}`;
  }
  get dotCls() {
    return `h-1.5 w-1.5 rounded-full bg-current${this.value === 'running' || this.value === 'pending' ? ' animate-pulse' : ''}`;
  }
}
