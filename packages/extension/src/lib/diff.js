/** Line diffs for visual file comparisons (jsdiff) + unified patch parsing for GitHub compare. */
import { diffLines } from 'diff';

/**
 * @returns {{ rows: Array<{type:'ctx'|'add'|'del', left?:string, right?:string, ln?:number, rn?:number}>, additions:number, deletions:number }}
 */
export function lineDiff(original = '', modified = '') {
  const parts = diffLines(original ?? '', modified ?? '');
  const rows = [];
  let ln = 1,
    rn = 1,
    additions = 0,
    deletions = 0;
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, '').split('\n');
    if (p.value === '') continue;
    for (const line of lines) {
      if (p.added) {
        rows.push({ type: 'add', right: line, rn: rn++ });
        additions++;
      } else if (p.removed) {
        rows.push({ type: 'del', left: line, ln: ln++ });
        deletions++;
      } else rows.push({ type: 'ctx', left: line, right: line, ln: ln++, rn: rn++ });
    }
  }
  return { rows, additions, deletions };
}

/** Pair deletions with additions into side-by-side rows. */
export function sideBySide(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.type === 'ctx') {
      out.push({ l: r.left, r: r.right, ln: r.ln, rn: r.rn, lt: 'ctx', rt: 'ctx' });
      i++;
      continue;
    }
    const dels = [],
      adds = [];
    while (i < rows.length && rows[i].type === 'del') dels.push(rows[i++]);
    while (i < rows.length && rows[i].type === 'add') adds.push(rows[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const d = dels[k],
        a = adds[k];
      out.push({ l: d?.left ?? '', r: a?.right ?? '', ln: d?.ln, rn: a?.rn, lt: d ? 'del' : 'empty', rt: a ? 'add' : 'empty' });
    }
  }
  return out;
}

/** Collapse long unchanged runs, keeping `context` lines around changes. */
export function collapseContext(rows, context = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type !== 'ctx') for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  if (!rows.some((r) => r.type !== 'ctx')) return rows.slice(0, 200);
  const out = [];
  let hidden = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (hidden) {
        out.push({ type: 'gap', count: hidden });
        hidden = 0;
      }
      out.push(r);
    } else hidden++;
  });
  if (hidden) out.push({ type: 'gap', count: hidden });
  return out;
}

/** Parse a unified diff patch (GitHub `patch`) into rows compatible with lineDiff(). */
export function parsePatch(patch = '') {
  const rows = [];
  let ln = 0,
    rn = 0;
  for (const line of String(patch || '').split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      ln = Number(h[1]);
      rn = Number(h[2]);
      rows.push({ type: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) rows.push({ type: 'add', right: line.slice(1), rn: rn++ });
    else if (line.startsWith('-')) rows.push({ type: 'del', left: line.slice(1), ln: ln++ });
    else if (line.startsWith('\\')) continue;
    else rows.push({ type: 'ctx', left: line.slice(1), right: line.slice(1), ln: ln++, rn: rn++ });
  }
  return rows;
}
