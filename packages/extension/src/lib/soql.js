/** SOQL builder helpers for the visual query builder. */
export const OPERATORS = [
  { id: '=', label: 'equals' },
  { id: '!=', label: 'not equals' },
  { id: 'LIKE', label: 'contains' },
  { id: 'STARTS', label: 'starts with' },
  { id: '>', label: 'greater than' },
  { id: '<', label: 'less than' },
  { id: '>=', label: '≥' },
  { id: '<=', label: '≤' },
  { id: 'IN', label: 'in (comma list)' },
  { id: 'NULL', label: 'is empty' },
  { id: 'NOTNULL', label: 'is not empty' },
];
const NUMERIC = new Set(['int', 'double', 'currency', 'percent', 'long']);
const BOOL = new Set(['boolean']);
const DATE = new Set(['date', 'datetime']);
const DATE_LITERAL =
  /^(TODAY|YESTERDAY|TOMORROW|THIS_WEEK|LAST_WEEK|NEXT_WEEK|THIS_MONTH|LAST_MONTH|NEXT_MONTH|THIS_QUARTER|LAST_QUARTER|THIS_YEAR|LAST_YEAR|NEXT_YEAR|LAST_N_DAYS:\d+|NEXT_N_DAYS:\d+|LAST_N_MONTHS:\d+|N_DAYS_AGO:\d+)$/i;

export function literal(value, type) {
  const v = String(value ?? '').trim();
  if (NUMERIC.has(type)) return Number.isFinite(Number(v)) ? v : `'${esc(v)}'`;
  if (BOOL.has(type)) return /^(true|1|yes)$/i.test(v) ? 'TRUE' : 'FALSE';
  if (DATE.has(type)) {
    if (DATE_LITERAL.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v)) return v.toUpperCase().startsWith('LAST_N') || DATE_LITERAL.test(v) ? v.toUpperCase() : v;
    return `'${esc(v)}'`;
  }
  return `'${esc(v)}'`;
}
function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildWhere(filters, fieldTypes = {}) {
  const parts = [];
  for (const f of filters || []) {
    if (!f.field) continue;
    const t = fieldTypes[f.field] || 'string';
    switch (f.op) {
      case 'NULL':
        parts.push(`${f.field} = null`);
        break;
      case 'NOTNULL':
        parts.push(`${f.field} != null`);
        break;
      case 'LIKE':
        if (f.value) parts.push(`${f.field} LIKE '%${esc(String(f.value))}%'`);
        break;
      case 'STARTS':
        if (f.value) parts.push(`${f.field} LIKE '${esc(String(f.value))}%'`);
        break;
      case 'IN':
        if (f.value)
          parts.push(
            `${f.field} IN (${String(f.value)
              .split(',')
              .map((x) => literal(x, t))
              .join(', ')})`,
          );
        break;
      default:
        if (f.value !== '' && f.value != null) parts.push(`${f.field} ${f.op || '='} ${literal(f.value, t)}`);
    }
  }
  return parts.join(' AND ');
}

export function buildSoql({ sobject, fields, filters, fieldTypes, orderBy, orderDir = 'ASC', limit = 50 }) {
  if (!sobject) return '';
  const sel = fields?.length ? fields : ['Id'];
  let soql = `SELECT ${sel.join(', ')}\nFROM ${sobject}`;
  const where = buildWhere(filters, fieldTypes);
  if (where) soql += `\nWHERE ${where}`;
  if (orderBy) soql += `\nORDER BY ${orderBy} ${orderDir}`;
  if (limit) soql += `\nLIMIT ${Math.min(2000, Math.max(1, Number(limit) || 50))}`;
  return soql;
}

/** Flatten a record for table display (relationship objects -> dotted keys). */
export function flattenRecord(rec, prefix = '') {
  if (typeof prefix !== 'string') prefix = ''; // callers pass this straight to .map(), whose second argument is the index
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === 'attributes') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && !('records' in v)) Object.assign(out, flattenRecord(v, prefix + k + '.'));
    else if (v && typeof v === 'object' && 'records' in v) out[prefix + k] = `${v.totalSize ?? v.records?.length ?? 0} records`;
    else out[prefix + k] = v;
  }
  return out;
}
