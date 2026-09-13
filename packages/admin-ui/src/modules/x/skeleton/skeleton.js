import { LightningElement, api } from 'lwc';
export default class Skeleton extends LightningElement {
  static renderMode = 'light';
  @api rows = 4;
  @api variant = 'table'; // table | cards | text
  get items() {
    return Array.from({ length: Number(this.rows) || 3 }, (_, i) => ({ id: i, w: ['w-full', 'w-11/12', 'w-4/5', 'w-2/3'][i % 4] }));
  }
  get isTable() {
    return this.variant === 'table';
  }
  get isCards() {
    return this.variant === 'cards';
  }
  get isText() {
    return this.variant === 'text';
  }
}
