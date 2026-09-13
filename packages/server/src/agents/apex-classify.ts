/**
 * Anonymous Apex classification, failing closed.
 *
 * `execute_anonymous_apex(read-only)` is a permission rule an admin can grant more freely than the
 * mutating form, so the classification decides which rule applies and whether the data-change
 * policy is consulted at all. A DML regex is not enough: `Database.executeBatch`, `System.schedule`,
 * `Messaging.sendEmail`, `EventBus.publish`, a callout or any call into a service class changes the
 * org without ever saying `insert`. So the rule is inverted: a script is read-only only when
 * everything it does is provably inert — SOQL, local variables, collections, `System.debug`,
 * assertions and a short list of pure built-ins. Anything else, including a method call on a class
 * this list does not know, counts as mutating.
 */

export type ApexEffect = 'read-only' | 'mutating';

/** DML statements, as keywords at statement position. */
const DML = /(^|[;{}\s])(insert|update|delete|upsert|undelete|merge)\s+[\w[(]/i;

/** Static or instance calls that never change org state. Matched against `Receiver.method`. */
const PURE_CALLS = new Set(
  [
    'System.debug',
    'System.assert',
    'System.assertEquals',
    'System.assertNotEquals',
    'System.now',
    'System.today',
    'System.currentTimeMillis',
    'Database.query',
    'Database.countQuery',
    'Database.getQueryLocator',
    'String.valueOf',
    'String.join',
    'String.isBlank',
    'String.isNotBlank',
    'String.isEmpty',
    'String.format',
    'Integer.valueOf',
    'Decimal.valueOf',
    'Long.valueOf',
    'Double.valueOf',
    'Boolean.valueOf',
    'Id.valueOf',
    'Date.today',
    'Date.newInstance',
    'Datetime.now',
    'Datetime.newInstance',
    'JSON.serialize',
    'JSON.serializePretty',
    'JSON.deserialize',
    'JSON.deserializeUntyped',
    'Math.abs',
    'Math.max',
    'Math.min',
    'Math.round',
    'Math.floor',
    'Math.ceil',
    'Schema.getGlobalDescribe',
    'Schema.describeSObjects',
    'UserInfo.getUserId',
    'UserInfo.getUserName',
    'UserInfo.getProfileId',
    'UserInfo.getOrganizationId',
    'Limits.getQueries',
    'Limits.getLimitQueries',
    'Limits.getDmlStatements',
    'Limits.getCpuTime',
    'Limits.getHeapSize',
  ].map((s) => s.toLowerCase()),
);

/** Instance methods on collections, strings and sObjects that only read. */
const PURE_INSTANCE_METHODS = new Set(
  [
    'size',
    'isEmpty',
    'get',
    'contains',
    'containsKey',
    'keySet',
    'values',
    'indexOf',
    'toLowerCase',
    'toUpperCase',
    'trim',
    'split',
    'substring',
    'startsWith',
    'endsWith',
    'equals',
    'equalsIgnoreCase',
    'length',
    'format',
    'getSObjectType',
    'getDescribe',
    'getName',
    'getLabel',
    'getFields',
    'getMap',
    'getPicklistValues',
    'getValue',
    'isCustom',
    'isAccessible',
    'isCreateable',
    'isUpdateable',
    'getSObjectField',
    'getPopulatedFieldsAsMap',
    'clone',
    'deepClone',
    'add',
    'addAll',
    'put',
    'putAll',
    'sort',
    'getTime',
    'addDays',
    'daysBetween',
    'year',
    'month',
    'day',
    'abbreviate',
    'left',
    'right',
    'replace',
    'replaceAll',
    'toString',
    'hashCode',
  ].map((s) => s.toLowerCase()),
);

/** Types whose constructors are inert. */
const PURE_CONSTRUCTORS = /^(list|set|map|string|integer|decimal|long|double|boolean|date|datetime|time|blob)\b/i;

/** Strip string literals and comments so their contents cannot fool (or hide from) the scan. */
export function stripApexLiterals(apex: string): string {
  return apex
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/** SOQL and SOSL brackets are inert; remove them so their field names are not mistaken for calls. */
function stripQueries(apex: string): string {
  return apex.replace(/\[\s*(select|find)\b[^\]]*\]/gi, '[]');
}

/**
 * Classify an anonymous Apex script. Returns the reason when it is mutating so the confirmation
 * card can say what tipped the decision.
 */
export function classifyAnonymousApex(apex: string): { effect: ApexEffect; reason: string | null } {
  const code = stripQueries(stripApexLiterals(apex));
  const dml = DML.exec(code);
  if (dml) return { effect: 'mutating', reason: `DML statement "${dml[2]}"` };

  // Constructors: `new Foo(...)` for anything but a collection or primitive may run arbitrary code.
  for (const m of code.matchAll(/\bnew\s+([A-Za-z_][\w.]*)\s*(<[^>]*>)?\s*[({]/g)) {
    if (!PURE_CONSTRUCTORS.test(m[1])) return { effect: 'mutating', reason: `constructs ${m[1]}` };
  }

  // Method calls: `Receiver.method(` (static or instance) and bare `method(`.
  for (const m of code.matchAll(/([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g)) {
    const chain = m[1].replace(/\s+/g, '');
    const parts = chain.split('.');
    const method = parts[parts.length - 1];
    // `foo().bar(`: the receiver is an expression, so this is an instance call on its result.
    const chained = /\.\s*$/.test(code.slice(Math.max(0, m.index - 4), m.index));
    if (parts.length === 1) {
      if (chained) {
        if (PURE_INSTANCE_METHODS.has(method.toLowerCase())) continue;
        return { effect: 'mutating', reason: `calls .${method}()` };
      }
      // A bare call is a method on the anonymous block itself or a keyword like `if (`.
      if (/^(if|for|while|switch|catch|return)$/i.test(method)) continue;
      return { effect: 'mutating', reason: `calls ${method}()` };
    }
    const qualified = `${parts[parts.length - 2]}.${method}`.toLowerCase();
    if (PURE_CALLS.has(qualified)) continue;
    // Static class names start with an upper-case letter; a call on one we do not know is a call
    // into custom or platform code that may change anything.
    const receiver = parts[parts.length - 2];
    if (/^[A-Z]/.test(receiver) && parts.length === 2) return { effect: 'mutating', reason: `calls ${receiver}.${method}()` };
    if (!PURE_INSTANCE_METHODS.has(method.toLowerCase())) return { effect: 'mutating', reason: `calls .${method}() on ${receiver}` };
  }
  return { effect: 'read-only', reason: null };
}
