import { LightningElement, api } from 'lwc';
import { ICONS } from '../../../lib/constants.js';

export default class Icon extends LightningElement {
  static renderMode = 'light';
  @api name = 'info';
  @api cls = 'h-4 w-4';
  get path() {
    return ICONS[this.name] || ICONS.info;
  }
  get svgClass() {
    return `${this.cls} shrink-0${this.name === 'spinner' ? ' animate-spin' : ''}`;
  }
}
