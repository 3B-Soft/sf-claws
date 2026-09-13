import { LightningElement, api } from 'lwc';
import { renderMarkdown } from '../../../lib/markdown.js';

/** Markdown -> sanitized HTML, written into a manually managed div (no LWC sanitize hook needed). */
export default class MarkdownView extends LightningElement {
  static renderMode = 'light';
  @api text = '';
  @api compact = false;
  _last = null;
  get cls() {
    return this.compact ? 'md text-[12px]' : 'md';
  }
  renderedCallback() {
    const el = this.querySelector('div');
    if (!el) return;
    const src = this.text || '';
    if (src === this._last) return;
    this._last = src;
    el.innerHTML = renderMarkdown(src);
  }
}
