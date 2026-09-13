/** Markdown -> sanitized HTML via marked. */
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Strip scripts, event handlers, javascript: URLs, and dangerous elements. */
export function sanitizeHtml(html) {
  if (!html) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const forbidden = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'LINK', 'META', 'BASE', 'FORM']);
  const walk = (node) => {
    [...node.children].forEach((el) => {
      if (forbidden.has(el.tagName)) {
        el.remove();
        return;
      }
      [...el.attributes].forEach((a) => {
        const n = a.name.toLowerCase();
        const v = a.value.trim().toLowerCase();
        if (n.startsWith('on') || ((n === 'href' || n === 'src' || n === 'xlink:href') && (v.startsWith('javascript:') || v.startsWith('data:text/html'))))
          el.removeAttribute(a.name);
      });
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      walk(el);
    });
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

export function renderMarkdown(md) {
  if (!md) return '';
  try {
    return sanitizeHtml(marked.parse(String(md)));
  } catch (_e) {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
}

export { escapeHtml };
