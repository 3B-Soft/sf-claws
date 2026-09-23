export function fmtDate(iso, opts = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...opts });
}
export function fmtRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return fmtDate(iso, { hour: undefined, minute: undefined });
}
export function fmtTokens(n) {
  n = Number(n || 0);
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
export function fmtUsd(n) {
  n = Number(n || 0);
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
export function fmtDuration(ms) {
  ms = Number(ms || 0);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
export function truncate(s, n = 80) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
export function fileName(path) {
  return String(path || '')
    .split('/')
    .pop();
}
export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export function jsonPretty(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
export function toCsv(columns, rows) {
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}
/** Highlight XML into safe HTML (spans with classes .t .a .v .c). */
export function highlightXml(xml) {
  const src = escapeHtml(xml);
  return src.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="c">$1</span>').replace(/(&lt;\/?)([\w:.-]+)([^&]*?)(\/?&gt;)/g, (_, o, tag, attrs, c) => {
    const a = attrs.replace(/([\w:.-]+)=(&quot;.*?&quot;)/g, '<span class="a">$1</span>=<span class="v">$2</span>');
    return `${o}<span class="t">${tag}</span>${a}${c}`;
  });
}
export const ROLE_COLORS = {
  general: 'bg-violet-500/15 text-violet-700 border-violet-500/30',
  explore: 'bg-sky-500/15 text-sky-700 border-sky-500/30',
  plan: 'bg-brand-500/15 text-brand-700 border-brand-500/30',
  verify: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  orchestrator: 'bg-brand-500/15 text-brand-700 border-brand-500/30',
  analyst: 'bg-sky-500/15 text-sky-700 border-sky-500/30',
  metadata_builder: 'bg-violet-500/15 text-violet-700 border-violet-500/30',
  flow_builder: 'bg-fuchsia-500/15 text-fuchsia-700 border-fuchsia-500/30',
  apex_builder: 'bg-orange-500/15 text-orange-700 border-orange-500/30',
  reviewer: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  doc_writer: 'bg-teal-500/15 text-teal-700 border-teal-500/30',
  summarizer: 'bg-surface-sunken text-content-muted border-line-strong',
};
export function roleClass(role) {
  return ROLE_COLORS[role] || ROLE_COLORS.summarizer;
}
export function roleLabel(role) {
  return String(role || '').replace(/_/g, ' ');
}
export const STATUS_CLASSES = {
  idle: 'bg-surface-sunken text-content-muted border-line-strong',
  running: 'bg-brand-500/15 text-brand-700 border-brand-500/30',
  awaiting_confirmation: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  completed: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  failed: 'bg-rose-500/15 text-rose-700 border-rose-500/30',
  cancelled: 'bg-surface-sunken text-content-subtle border-line-strong',
  connected: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  disconnected: 'bg-surface-sunken text-content-muted border-line-strong',
  expired: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  error: 'bg-rose-500/15 text-rose-700 border-rose-500/30',
  succeeded: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  in_progress: 'bg-brand-500/15 text-brand-700 border-brand-500/30',
  pending: 'bg-surface-sunken text-content-muted border-line-strong',
};
export function statusClass(s) {
  return `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASSES[s] || STATUS_CLASSES.idle}`;
}
export function statusLabel(s) {
  return String(s || '').replace(/_/g, ' ');
}
export const KIND_CLASSES = {
  production: 'bg-rose-500/15 text-rose-700 border-rose-500/40',
  sandbox: 'bg-sky-500/15 text-sky-700 border-sky-500/40',
  scratch: 'bg-amber-500/15 text-amber-700 border-amber-500/40',
  developer: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40',
};
export function kindClass(k) {
  return `inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${KIND_CLASSES[k] || KIND_CLASSES.developer}`;
}
