import { LightningElement, api } from 'lwc';
import { highlightXml, jsonPretty } from '../../../lib/format.js';

/** Raw XML / JSON viewer with light syntax highlighting (pro mode). Escapes everything before highlighting. */
export default class XmlView extends LightningElement {
  static renderMode = 'light';
  @api xml = '';
  @api json;
  @api maxHeight = '360px';
  _last = null;
  get style() {
    return `max-height:${this.maxHeight}`;
  }
  get source() {
    return this.json !== undefined ? jsonPretty(this.json) : String(this.xml || '');
  }
  renderedCallback() {
    const el = this.querySelector('pre');
    if (!el) return;
    const src = this.source;
    if (src === this._last) return;
    this._last = src;
    el.innerHTML = highlightXml(src);
  }
}
