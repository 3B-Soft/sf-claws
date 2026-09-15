import { LightningElement, api } from 'lwc';
import { renderMarkdown } from '../../../lib/markdown.js';

/** Markdown -> sanitized HTML, written into a manually managed div (no LWC sanitize hook needed). */
export default class MarkdownView extends LightningElement {
  static renderMode = 'light';
  @api compact = false;
  _text = '';
  _last = null;
  // A setter, not a plain @api field: the template never reads `text`, so LWC does not re-render
  // (or call renderedCallback) when it changes. A streaming reply froze on its first delta ("I").
  @api
  get text() {
    return this._text;
  }
  set text(v) {
    this._text = v || '';
    this.paint();
  }
  get cls() {
    return this.compact ? 'md text-[12px]' : 'md';
  }
  renderedCallback() {
    this.paint();
  }
  paint() {
    const el = this.querySelector('div');
    if (!el || this._text === this._last) return;
    this._last = this._text;
    el.innerHTML = renderMarkdown(this._text);
  }
}
