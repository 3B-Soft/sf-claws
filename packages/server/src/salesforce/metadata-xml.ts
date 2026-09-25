/**
 * Metadata XML helpers: manifest building, well-formedness checking and a render-friendly
 * projection of a metadata document.
 *
 * Conversion between SFDX source format and Metadata API format used to live here as a
 * hand-written converter. It is now Salesforce's own `source-deploy-retrieve` — see `sdr.ts` and
 * the comment at the top of it for why. What is left here is the part with no edge cases worth
 * delegating: a manifest is a flat list of type and fullName.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'http://soap.sforce.com/2006/04/metadata';

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildPackageXml(types: { name: string; members: string[] }[], apiVersion: string): string {
  const body = types
    .map((t) => `    <types>\n${t.members.map((m) => `        <members>${escapeXml(m)}</members>`).join('\n')}\n        <name>${t.name}</name>\n    </types>`)
    .join('\n');
  return `${XML_HEADER}<Package xmlns="${NS}">\n${body}\n    <version>${apiVersion}</version>\n</Package>\n`;
}

/** The manifest of components to delete. Same shape as package.xml, different filename. */
export function buildDestructiveChangesXml(components: { type: string; fullName: string }[], apiVersion: string): string {
  const byType = new Map<string, string[]>();
  for (const c of components) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type)!.push(c.fullName);
  }
  return buildPackageXml(
    [...byType.entries()].map(([name, members]) => ({ name, members })),
    apiVersion,
  );
}

/** Basic well-formedness check; returns an error message or null. */
export function validateXml(xml: string): string | null {
  if (!xml.trim()) return 'Empty XML document';
  const r = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (r === true) return null;
  return `${r.err.msg} (line ${r.err.line}, col ${r.err.col})`;
}

/**
 * Summarise a metadata XML into a compact JSON object for visual rendering (drops namespaces and
 * attributes). The `isArray` list keeps repeated children as arrays even when a document happens to
 * carry exactly one of them, so a renderer never has to special-case the single-child shape.
 */
export function xmlToJson(xml: string): unknown {
  const p = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: true,
    isArray: (name) =>
      [
        'fields',
        'validationRules',
        'recordTypes',
        'listViews',
        'layoutSections',
        'layoutColumns',
        'layoutItems',
        'flexiPageRegions',
        'itemInstances',
        'componentInstances',
        'assignments',
        'decisions',
        'recordLookups',
        'recordUpdates',
        'recordCreates',
        'recordDeletes',
        'screens',
        'loops',
        'subflows',
        'actionCalls',
        'variables',
        'formulas',
        'rules',
        'values',
        'picklistValues',
        'fieldPermissions',
        'objectPermissions',
        'classAccesses',
        'members',
        'types',
      ].includes(name),
  });
  return p.parse(xml);
}

/** Parse a package.xml into retrieve components. Throws on malformed XML or an empty manifest. */
export function parsePackageXml(xml: string): { type: string; members: string[] }[] {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`package.xml is not well-formed: ${valid.err.msg} (line ${valid.err.line})`);
  const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (n) => n === 'types' || n === 'members' }).parse(xml);
  const out = ((doc?.Package?.types ?? []) as { name?: string; members?: string[] }[])
    .map((t) => ({ type: String(t.name ?? '').trim(), members: (t.members ?? []).map((m) => String(m).trim()).filter(Boolean) }))
    .filter((t) => t.type && t.members.length);
  if (!out.length) throw new Error('package.xml lists no <types> with <members>');
  return out;
}
