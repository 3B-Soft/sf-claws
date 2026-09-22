import { LightningElement, api } from 'lwc';
import { renderMarkdown } from '../../../lib/markdown.js';
export default class Markdown extends LightningElement {
  static renderMode = 'light';
  @api compact = false;
  _source = '';
  _last = null;

  @api
  get source() {
    return this._source;
  }
  set source(value) {
    this._source = value || '';
    this.paint();
  }
  get cls() {
    return `prose-x ${this.compact ? '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0' : ''}`;
  }
  renderedCallback() {
    this.paint();
  }
  paint() {
    const el = this.querySelector('div');
    if (!el || this._source === this._last) return;
    this._last = this._source;
    el.innerHTML = renderMarkdown(this._source);
  }
}
