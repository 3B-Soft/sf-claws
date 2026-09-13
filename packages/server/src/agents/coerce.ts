/**
 * Tool argument coercion.
 *
 * Models routinely emit `"150"` for a number and `"false"` for a boolean, and occasionally a bare
 * string where an array is expected. Left alone these silently corrupt limits (a stringified `"0"`
 * is truthy) or flip a flag the wrong way. We normalise every tool input against the tool's JSON
 * schema before it reaches the implementation, so tools can trust their types.
 */

type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema; enum?: unknown[]; required?: string[] } & Record<
  string,
  unknown
>;

const TRUE = new Set(['true', 'yes', '1', 'on']);
const FALSE = new Set(['false', 'no', '0', 'off', '']);

/** Coerce a single value to the type its schema declares. Unknown/unmatched values pass through. */
export function coerceValue(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema || value === null || value === undefined) return value;
  switch (schema.type) {
    case 'number':
    case 'integer': {
      if (typeof value === 'number') return schema.type === 'integer' ? Math.trunc(value) : value;
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) return schema.type === 'integer' ? Math.trunc(n) : n;
      }
      return value;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (TRUE.has(v)) return true;
        if (FALSE.has(v)) return false;
      }
      return value;
    }
    case 'array': {
      const arr = Array.isArray(value)
        ? value
        : // A single value where a list was expected is a common model slip; wrap rather than reject.
          typeof value === 'string' && value.includes(',')
          ? value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [value];
      return arr.map((v) => coerceValue(v, schema.items));
    }
    case 'object': {
      if (typeof value === 'string') {
        // Some models stringify nested objects. Parse when it is unambiguously JSON.
        const t = value.trim();
        if (t.startsWith('{') && t.endsWith('}')) {
          try {
            return coerceValue(JSON.parse(t), schema);
          } catch {
            return value;
          }
        }
        return value;
      }
      if (typeof value !== 'object' || Array.isArray(value)) return value;
      return coerceObject(value as Record<string, unknown>, schema);
    }
    case 'string':
      return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
    default:
      return value;
  }
}

function coerceObject(input: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const props = schema.properties;
  if (!props) return input;
  const out: Record<string, unknown> = { ...input };
  for (const [key, value] of Object.entries(input)) {
    if (props[key]) out[key] = coerceValue(value, props[key]);
  }
  return out;
}

/** Coerce a tool's input object against its top-level input schema. */
export function coerceArgs(input: unknown, schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        return coerceArgs(JSON.parse(t), schema);
      } catch {
        return {};
      }
    }
    return {};
  }
  if (typeof input !== 'object' || Array.isArray(input)) return {};
  return coerceObject(input as Record<string, unknown>, (schema ?? {}) as JsonSchema);
}

/**
 * Check a coerced input against the schema's `required` list, `enum`s and basic types. Returns a
 * message the model can act on, or null when the input is acceptable. Deliberately shallow: it
 * exists so `describe_sobject({})` fails here with "sobject is required" instead of reaching
 * Salesforce as the string "undefined", not to replace the tool's own validation.
 */
export function validateArgs(input: Record<string, unknown>, schema: Record<string, unknown> | undefined): string | null {
  const s = (schema ?? {}) as JsonSchema;
  const problems: string[] = [];
  for (const key of s.required ?? []) {
    const v = input[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) problems.push(`"${key}" is required`);
  }
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    const mismatch = typeMismatch(v, prop);
    if (mismatch) problems.push(`"${key}" ${mismatch}`);
  }
  if (!problems.length) return null;
  const expected = Object.entries(s.properties ?? {})
    .map(([k, p]) => `${k}${(s.required ?? []).includes(k) ? '' : '?'}: ${p.enum ? p.enum.map(String).join(' | ') : (p.type ?? 'any')}`)
    .join(', ');
  return `${problems.join('; ')}. Expected { ${expected} }.`;
}

function typeMismatch(v: unknown, prop: JsonSchema): string | null {
  if (prop.enum && !prop.enum.includes(v)) return `must be one of ${prop.enum.map(String).join(', ')}`;
  switch (prop.type) {
    case 'string':
      return typeof v === 'string' ? null : 'must be a string';
    case 'number':
    case 'integer':
      return typeof v === 'number' && Number.isFinite(v) ? null : 'must be a number';
    case 'boolean':
      return typeof v === 'boolean' ? null : 'must be true or false';
    case 'array':
      return Array.isArray(v) ? null : 'must be a list';
    case 'object':
      return typeof v === 'object' && !Array.isArray(v) ? null : 'must be an object';
    default:
      return null;
  }
}
