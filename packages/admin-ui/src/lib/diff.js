/**
 * Line diff helpers on top of jsdiff. Produces flat row lists the diff viewer can render:
 * { id, type: 'add'|'del'|'ctx'|'hunk', oldNo, newNo, text }
 */
import { diffLines, parsePatch } from 'diff';

export function lineDiff(oldText = '', newText = '', { context = 3, collapse = true } = {}) {
  const parts = diffLines(oldText ?? '', newText ?? '');
  const rows = [];
  let oldNo = 1;
  let newNo = 1;
  let id = 0;
  for (const part of parts) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    if (part.value === '') continue;
    for (const text of lines) {
      if (part.added) rows.push({ id: id++, type: 'add', oldNo: null, newNo: newNo++, text });
      else if (part.removed) rows.push({ id: id++, type: 'del', oldNo: oldNo++, newNo: null, text });
      else rows.push({ id: id++, type: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  const stats = {
    additions: rows.filter((r) => r.type === 'add').length,
    deletions: rows.filter((r) => r.type === 'del').length,
  };
  return { rows: collapse ? collapseContext(rows, context) : rows, stats };
}

/** Keep only `context` lines around changes; replace gaps with hunk separators. */
export function collapseContext(rows, context = 3) {
  if (!rows.some((r) => r.type !== 'ctx')) return rows.slice(0, 200);
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type === 'ctx') return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  const out = [];
  let gap = 0;
  let id = 100000;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (gap > 0) out.push({ id: id++, type: 'hunk', oldNo: null, newNo: null, text: `⋯ ${gap} unchanged line${gap === 1 ? '' : 's'}` });
      gap = 0;
      out.push(r);
    } else gap++;
  });
  if (gap > 0) out.push({ id: id++, type: 'hunk', oldNo: null, newNo: null, text: `⋯ ${gap} unchanged line${gap === 1 ? '' : 's'}` });
  return out;
}

/** Turn a unified `patch` string (GitHub compare API) into rows. */
export function patchToRows(patch) {
  if (!patch) return [];
  const rows = [];
  let id = 0;
  let files;
  try {
    files = parsePatch(patch.startsWith('@@') ? `--- a\n+++ b\n${patch}` : patch);
  } catch {
    files = [];
  }
  for (const f of files) {
    for (const h of f.hunks) {
      rows.push({ id: id++, type: 'hunk', oldNo: null, newNo: null, text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
      let o = h.oldStart;
      let n = h.newStart;
      for (const line of h.lines) {
        const c = line[0];
        const text = line.slice(1);
        if (c === '+') rows.push({ id: id++, type: 'add', oldNo: null, newNo: n++, text });
        else if (c === '-') rows.push({ id: id++, type: 'del', oldNo: o++, newNo: null, text });
        else if (c === '\\') continue;
        else rows.push({ id: id++, type: 'ctx', oldNo: o++, newNo: n++, text });
      }
    }
  }
  return rows;
}
