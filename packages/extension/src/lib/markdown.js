import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** Render markdown to sanitized HTML (no scripts / event handlers / javascript: urls). */
export function renderMarkdown(md) {
  let html;
  try {
    html = marked.parse(String(md ?? ''));
  } catch {
    html = escapeHtml(md);
  }
  return sanitize(html);
}

export function sanitize(html) {
  if (typeof DOMParser === 'undefined') return String(html).replace(/<script[\s\S]*?<\/script>/gi, '');
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const banned = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'BASE']);
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (banned.has(el.tagName)) {
        el.remove();
        continue;
      }
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase();
        const v = attr.value.trim().toLowerCase();
        if (
          n.startsWith('on') ||
          (['href', 'src', 'xlink:href'].includes(n) && (v.startsWith('javascript:') || v.startsWith('data:text/html') || v.startsWith('vbscript:')))
        )
          el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      walk(el);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
