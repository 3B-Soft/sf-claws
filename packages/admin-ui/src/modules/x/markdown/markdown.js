import { LightningElement, api } from 'lwc';
import { renderMarkdown } from '../../../lib/markdown.js';
export default class Markdown extends LightningElement {
  static renderMode = 'light';
  @api source = '';
  @api compact = false;
  get html() {
    return renderMarkdown(this.source || '');
  }
  get cls() {
    return `prose-x ${this.compact ? '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0' : ''}`;
  }
}
