/** Formatting helpers: dates, tokens, USD, durations, bytes. */

export function fmtDate(iso, { time = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const opts = time
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return d.toLocaleString(undefined, opts);
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtRelative(iso) {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return String(iso);
  const diff = Date.now() - d;
  const abs = Math.abs(diff);
  const s = Math.round(abs / 1000);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ${suffix}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ${suffix}`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ${suffix}`;
  return fmtDate(iso, { time: false });
}

export function fmtTokens(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  n = Number(n);
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtInt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}

export function fmtUsd(n, { precise = false } = {}) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  n = Number(n);
  if (precise || (n > 0 && n < 0.01)) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function fmtPercent(n, digits = 0) {
  if (n === null || n === undefined) return '—';
  return `${Number(n).toFixed(digits)}%`;
}

export function truncate(str, n = 80) {
  if (!str) return '';
  str = String(str);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}

export function initials(name) {
  if (!name) return '?';
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
export function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function titleCase(s) {
  return String(s || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function safeJson(v, indent = 2) {
  try {
    return JSON.stringify(v, null, indent);
  } catch {
    return String(v);
  }
}
