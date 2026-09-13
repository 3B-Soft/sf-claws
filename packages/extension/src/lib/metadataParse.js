/** Client-side visual parsing of Salesforce metadata XML (DOMParser). */

function parse(xml) {
  const doc = new DOMParser().parseFromString(String(xml || ''), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
  return doc.documentElement;
}
const _text = (el, tag) => el?.getElementsByTagName(tag)?.[0]?.textContent?.trim() ?? '';
const children = (el, tag) => (el ? [...el.children].filter((c) => c.localName === tag) : []);
const direct = (el, tag) => children(el, tag)[0];
const directText = (el, tag) => direct(el, tag)?.textContent?.trim() ?? '';

export function detectType(xml) {
  try {
    return parse(xml).localName;
  } catch {
    return null;
  }
}

export function parseMetadata(type, xml) {
  const root = parse(xml);
  const t = type || root.localName;
  switch (t) {
    case 'Flow':
      return { type: 'Flow', ...parseFlow(root) };
    case 'CustomObject':
      return { type: 'CustomObject', ...parseCustomObject(root) };
    case 'Layout':
      return { type: 'Layout', ...parseLayout(root) };
    case 'FlexiPage':
      return { type: 'FlexiPage', ...parseFlexiPage(root) };
    case 'CustomField':
      return { type: 'CustomField', fields: [fieldSummary(root)] };
    case 'ValidationRule':
      return { type: 'ValidationRule', props: generic(root) };
    default:
      return { type: t, props: generic(root) };
  }
}

/** Generic: top-level scalar children as name/value rows + counts of repeated groups. */
export function generic(root) {
  const rows = [];
  const counts = new Map();
  for (const c of root.children) {
    if (c.children.length === 0) rows.push({ name: c.localName, value: c.textContent.trim() });
    else counts.set(c.localName, (counts.get(c.localName) || 0) + 1);
  }
  for (const [name, n] of counts) rows.push({ name, value: `${n} item${n === 1 ? '' : 's'}` });
  return rows;
}

// ---- Flow -----------------------------------------------------------------
const FLOW_ELEMENT_TAGS = {
  screens: 'Screen',
  decisions: 'Decision',
  assignments: 'Assignment',
  recordLookups: 'Get Records',
  recordCreates: 'Create Records',
  recordUpdates: 'Update Records',
  recordDeletes: 'Delete Records',
  loops: 'Loop',
  subflows: 'Subflow',
  actionCalls: 'Action',
  apexPluginCalls: 'Apex Plugin',
  waits: 'Wait',
  collectionProcessors: 'Collection',
  recordRollbacks: 'Rollback',
  steps: 'Step',
  transforms: 'Transform',
  customErrors: 'Custom Error',
  orchestratedStages: 'Stage',
};
const FLOW_TONES = {
  Screen: 'sky',
  Decision: 'amber',
  Assignment: 'violet',
  'Get Records': 'emerald',
  'Create Records': 'emerald',
  'Update Records': 'emerald',
  'Delete Records': 'rose',
  Loop: 'brand',
  Subflow: 'brand',
  Action: 'fuchsia',
  Start: 'slate',
  'Custom Error': 'rose',
};

export function parseFlow(root) {
  const elements = new Map();
  for (const [tag, label] of Object.entries(FLOW_ELEMENT_TAGS)) {
    for (const el of children(root, tag)) {
      const name = directText(el, 'name');
      const connectors = [];
      for (const cTag of ['connector', 'defaultConnector', 'nextValueConnector', 'noMoreValuesConnector', 'faultConnector']) {
        for (const c of children(el, cTag)) {
          const target = directText(c, 'targetReference');
          if (target)
            connectors.push({
              target,
              label:
                cTag === 'faultConnector'
                  ? 'fault'
                  : cTag === 'defaultConnector'
                    ? directText(el, 'defaultConnectorLabel') || 'default'
                    : cTag === 'noMoreValuesConnector'
                      ? 'after last'
                      : '',
            });
        }
      }
      const rules = children(el, 'rules').map((r) => {
        const target = directText(direct(r, 'connector'), 'targetReference');
        if (target) connectors.push({ target, label: directText(r, 'label') || directText(r, 'name') });
        return { name: directText(r, 'name'), label: directText(r, 'label'), conditions: children(r, 'conditions').map(condText) };
      });
      elements.set(name, {
        name,
        label: directText(el, 'label') || name,
        kind: label,
        tone: FLOW_TONES[label] || 'slate',
        detail: flowDetail(tag, el),
        rules,
        connectors,
        assignments: children(el, 'assignmentItems').map(
          (a) =>
            `${directText(direct(a, 'assignToReference'), '') || directText(a, 'assignToReference')} ${opSymbol(directText(a, 'operator'))} ${valueText(direct(a, 'value'))}`,
        ),
        fields: children(el, 'fields').map(
          (f) => `${directText(f, 'fieldText') || directText(f, 'name')}${directText(f, 'fieldType') ? ` (${directText(f, 'fieldType')})` : ''}`,
        ),
        filters: children(el, 'filters').map(condText),
        inputAssignments: children(el, 'inputAssignments').map((a) => `${directText(a, 'field')} = ${valueText(direct(a, 'value'))}`),
        isDecision: label === 'Decision',
      });
    }
  }
  const start = direct(root, 'start');
  let startTarget = '';
  const startInfo = {
    name: 'Start',
    label: 'Start',
    kind: 'Start',
    tone: 'slate',
    detail: '',
    connectors: [],
    rules: [],
    assignments: [],
    fields: [],
    filters: [],
    inputAssignments: [],
  };
  if (start) {
    startTarget = directText(direct(start, 'connector'), 'targetReference');
    const object = directText(start, 'object');
    const trigger = directText(start, 'triggerType');
    const rt = directText(start, 'recordTriggerType');
    const sched = direct(start, 'schedule');
    startInfo.detail = [
      object && `Object: ${object}`,
      rt && `When: ${rt}`,
      trigger && `Trigger: ${trigger}`,
      sched && `Schedule: ${directText(sched, 'frequency')} from ${directText(sched, 'startDate')}`,
    ]
      .filter(Boolean)
      .join(' · ');
    startInfo.filters = children(start, 'filters').map(condText);
    startInfo.connectors = startTarget ? [{ target: startTarget, label: '' }] : [];
    for (const sp of children(start, 'scheduledPaths')) {
      const t = directText(direct(sp, 'connector'), 'targetReference');
      if (t) startInfo.connectors.push({ target: t, label: directText(sp, 'label') || 'scheduled path' });
    }
  } else {
    startTarget = directText(root, 'startElementReference');
    if (startTarget) startInfo.connectors = [{ target: startTarget, label: '' }];
  }
  // Order: BFS from start, then leftovers.
  const ordered = [startInfo];
  const seen = new Set();
  const queue = startInfo.connectors.map((c) => c.target);
  while (queue.length) {
    const n = queue.shift();
    if (!n || seen.has(n) || !elements.has(n)) continue;
    seen.add(n);
    const el = elements.get(n);
    ordered.push(el);
    for (const c of el.connectors) queue.push(c.target);
  }
  for (const [n, el] of elements) if (!seen.has(n)) ordered.push(el);
  const counts = {};
  for (const el of elements.values()) counts[el.kind] = (counts[el.kind] || 0) + 1;
  return {
    label: directText(root, 'label'),
    apiVersion: directText(root, 'apiVersion'),
    processType: directText(root, 'processType'),
    status: directText(root, 'status'),
    description: directText(root, 'description'),
    variables: children(root, 'variables').map((v) => ({
      name: directText(v, 'name'),
      dataType: directText(v, 'dataType'),
      isCollection: directText(v, 'isCollection') === 'true',
      isInput: directText(v, 'isInput') === 'true',
      isOutput: directText(v, 'isOutput') === 'true',
    })),
    formulas: children(root, 'formulas').map((f) => ({ name: directText(f, 'name'), expression: directText(f, 'expression') })),
    elements: ordered.map((e, i) => ({ ...e, index: i, connectorText: e.connectors.map((c) => (c.label ? `${c.label} → ${c.target}` : `→ ${c.target}`)) })),
    counts: Object.entries(counts).map(([kind, n]) => ({ kind, n })),
    elementCount: elements.size,
  };
}
function flowDetail(tag, el) {
  const obj = directText(el, 'object');
  switch (tag) {
    case 'recordLookups':
      return `${obj}${directText(el, 'getFirstRecordOnly') === 'true' ? ' (first record)' : ' (all records)'}`;
    case 'recordCreates':
    case 'recordUpdates':
    case 'recordDeletes':
      return obj || directText(el, 'inputReference');
    case 'actionCalls':
      return `${directText(el, 'actionType')} ${directText(el, 'actionName')}`.trim();
    case 'subflows':
      return directText(el, 'flowName');
    case 'loops':
      return `over ${directText(el, 'collectionReference')} (${directText(el, 'iterationOrder') || 'Asc'})`;
    case 'screens':
      return `${children(el, 'fields').length} component(s)`;
    case 'decisions':
      return `${children(el, 'rules').length} outcome(s)`;
    case 'assignments':
      return `${children(el, 'assignmentItems').length} assignment(s)`;
    default:
      return directText(el, 'description');
  }
}
function condText(c) {
  return `${directText(c, 'leftValueReference') || directText(c, 'field')} ${opSymbol(directText(c, 'operator'))} ${valueText(direct(c, 'rightValue') || direct(c, 'value'))}`.trim();
}
function opSymbol(op) {
  return (
    {
      EqualTo: '=',
      NotEqualTo: '≠',
      GreaterThan: '>',
      LessThan: '<',
      GreaterThanOrEqualTo: '≥',
      LessThanOrEqualTo: '≤',
      Assign: '=',
      Add: '+=',
      Subtract: '-=',
      Contains: 'contains',
      StartsWith: 'starts with',
      EndsWith: 'ends with',
      IsNull: 'is null',
      IsChanged: 'is changed',
      AddItem: 'add item',
      RemoveAll: 'remove all',
      AssignCount: 'count',
    }[op] || op
  );
}
function valueText(v) {
  if (!v) return '';
  for (const c of v.children) {
    if (c.localName === 'elementReference') return `{!${c.textContent.trim()}}`;
    if (c.localName === 'stringValue') return `"${c.textContent.trim()}"`;
    return c.textContent.trim();
  }
  return v.textContent.trim();
}

// ---- CustomObject / CustomField ---------------------------------------------
export function fieldSummary(f) {
  const type = directText(f, 'type');
  const extra = [];
  if (directText(f, 'length')) extra.push(`len ${directText(f, 'length')}`);
  if (directText(f, 'precision')) extra.push(`${directText(f, 'precision')},${directText(f, 'scale')}`);
  if (directText(f, 'referenceTo')) extra.push(`→ ${directText(f, 'referenceTo')}`);
  if (directText(f, 'formula')) extra.push('formula');
  const pv = direct(f, 'valueSet');
  const picklist = pv ? [...pv.getElementsByTagName('value')].map((v) => directText(v, 'label') || directText(v, 'fullName')).filter(Boolean) : [];
  return {
    fullName: directText(f, 'fullName'),
    label: directText(f, 'label') || directText(f, 'fullName'),
    type: type || '—',
    required: directText(f, 'required') === 'true',
    unique: directText(f, 'unique') === 'true',
    externalId: directText(f, 'externalId') === 'true',
    description: directText(f, 'description') || directText(f, 'inlineHelpText'),
    extra: extra.join(' · '),
    picklist,
    isCustom: /__c$/.test(directText(f, 'fullName')),
  };
}
export function parseCustomObject(root) {
  return {
    label: directText(root, 'label'),
    pluralLabel: directText(root, 'pluralLabel'),
    description: directText(root, 'description'),
    sharingModel: directText(root, 'sharingModel'),
    nameFieldType: directText(direct(root, 'nameField'), 'type'),
    fields: children(root, 'fields').map(fieldSummary),
    validationRules: children(root, 'validationRules').map((v) => ({
      fullName: directText(v, 'fullName'),
      active: directText(v, 'active') === 'true',
      formula: directText(v, 'errorConditionFormula'),
      message: directText(v, 'errorMessage'),
    })),
    recordTypes: children(root, 'recordTypes').map((r) => ({
      fullName: directText(r, 'fullName'),
      label: directText(r, 'label'),
      active: directText(r, 'active') === 'true',
    })),
    listViews: children(root, 'listViews').map((l) => ({ fullName: directText(l, 'fullName'), label: directText(l, 'label') })),
  };
}

// ---- Layout -----------------------------------------------------------------
export function parseLayout(root) {
  const sections = children(root, 'layoutSections').map((s, i) => {
    const cols = children(s, 'layoutColumns').map((c) =>
      children(c, 'layoutItems').map((it) => ({
        field:
          directText(it, 'field') || directText(it, 'customLink') || directText(it, 'emptySpace') === 'true'
            ? directText(it, 'field') || '(blank)'
            : directText(it, 'component') || 'item',
        behavior: directText(it, 'behavior'),
        required: directText(it, 'behavior') === 'Required',
        readonly: directText(it, 'behavior') === 'Readonly',
      })),
    );
    return {
      index: i,
      label: directText(s, 'label') || `Section ${i + 1}`,
      style: directText(s, 'style'),
      columns: cols.map((items, ci) => ({ index: ci, items })),
      fieldCount: cols.reduce((n, c) => n + c.length, 0),
    };
  });
  return {
    sections,
    relatedLists: children(root, 'relatedLists').map((r) => ({
      name: directText(r, 'relatedList'),
      fields: children(r, 'fields').map((f) => f.textContent.trim()),
    })),
    quickActions: children(root, 'quickActionList').flatMap((q) => children(q, 'quickActionListItems').map((i) => directText(i, 'quickActionName'))),
  };
}

// ---- FlexiPage ---------------------------------------------------------------
export function parseFlexiPage(root) {
  const regions = children(root, 'flexiPageRegions').map((r, i) => ({
    index: i,
    name: directText(r, 'name'),
    type: directText(r, 'type'),
    mode: directText(r, 'mode'),
    components: children(r, 'itemInstances').map((it) => {
      const comp = direct(it, 'componentInstance');
      const field = direct(it, 'fieldInstance');
      if (field) return { name: directText(field, 'fieldItem'), isField: true, properties: [], visibility: '' };
      const props = children(comp, 'componentInstanceProperties').map((p) => ({
        name: directText(p, 'name'),
        value: directText(p, 'value') || (direct(p, 'valueList') ? '[list]' : ''),
      }));
      const vis = direct(comp, 'visibilityRule');
      return {
        name: directText(comp, 'componentName'),
        isField: false,
        properties: props,
        visibility: vis
          ? children(vis, 'criteria')
              .map((c) => `${directText(c, 'leftValue')} ${directText(c, 'operator')} ${directText(c, 'rightValue')}`)
              .join(' AND ')
          : '',
      };
    }),
  }));
  return {
    label: directText(root, 'masterLabel'),
    type: directText(root, 'type'),
    sobjectType: directText(root, 'sobjectType'),
    template: directText(direct(root, 'template'), 'name'),
    description: directText(root, 'description'),
    regions,
    componentCount: regions.reduce((n, r) => n + r.components.length, 0),
  };
}

/** Mirrors VisualMetadataTypes from @sf-claws/shared (kept local to avoid bundling zod into the panel). */
export const VISUAL_METADATA_TYPES = [
  'CustomObject',
  'CustomField',
  'Layout',
  'FlexiPage',
  'Flow',
  'ValidationRule',
  'RecordType',
  'PermissionSet',
  'CustomTab',
  'ListView',
  'QuickAction',
  'ApexClass',
  'ApexTrigger',
  'LightningComponentBundle',
  'CustomLabel',
  'CustomMetadata',
];
