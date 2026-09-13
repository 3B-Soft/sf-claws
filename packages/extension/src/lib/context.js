/**
 * Salesforce page-context parser. Pure functions, no browser APIs, shared by the
 * content script, the background service worker and the side panel.
 */

const SF_HOST_RE = /(^|\.)(salesforce|force|salesforce-setup|visualforce|salesforce-sites|sfdcopens)\.com$/i;
const SF_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/** Well-known key prefixes for classic /<id> URLs and record chips. */
export const KEY_PREFIXES = {
  '001': 'Account',
  '003': 'Contact',
  '005': 'User',
  '006': 'Opportunity',
  '00Q': 'Lead',
  500: 'Case',
  '00D': 'Organization',
  '00e': 'Profile',
  '00G': 'Group',
  '00O': 'Report',
  '01t': 'Product2',
  '01Z': 'Dashboard',
  '0PS': 'PermissionSet',
  '00T': 'Task',
  '00U': 'Event',
  '01I': 'CustomObject',
  '00N': 'CustomField',
  300: 'Flow',
  301: 'FlowDefinition',
  '0M0': 'FlexiPage',
  '00h': 'Layout',
  '01p': 'ApexClass',
  '01q': 'ApexTrigger',
  '066': 'ApexPage',
  '0Ho': 'DeployRequest',
  '02s': 'EmailMessage',
  '00a': 'Note',
  '00P': 'Attachment',
  '068': 'ContentVersion',
  '069': 'ContentDocument',
  701: 'Campaign',
  800: 'Contract',
  801: 'Order',
  '0Q0': 'Quote',
  '0WO': 'WorkOrder',
};

export function isSalesforceHost(host) {
  return !!host && SF_HOST_RE.test(host);
}

export function isSalesforceId(value) {
  return typeof value === 'string' && SF_ID_RE.test(value) && /^[a-zA-Z0-9]{3}/.test(value);
}

/**
 * @param {string} href
 * @param {string} [title]
 * @returns {PageContext}
 */
export function parseSalesforceContext(href, title = '') {
  let url;
  try {
    url = new URL(href);
  } catch {
    return emptyContext(href, title);
  }
  const host = url.hostname;
  const ctx = { ...emptyContext(href, title), host, isSalesforce: isSalesforceHost(host) };
  if (!ctx.isSalesforce) return ctx;

  let p = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;

  // /lightning/app/<app>/... prefix
  const app = p.match(/^\/lightning\/app\/([^/]+)(\/.*)?$/);
  if (app) {
    ctx.appName = safeDecode(app[1]);
    p = app[2] || '/lightning/page/home';
  }

  let m;
  if ((m = p.match(/^\/lightning\/r\/([^/]+)\/([a-zA-Z0-9]{15,18})\/([^/]+)/))) {
    ctx.kind = 'record';
    ctx.objectApiName = safeDecode(m[1]);
    ctx.recordId = m[2];
    ctx.view = m[3];
  } else if ((m = p.match(/^\/lightning\/r\/([a-zA-Z0-9]{15,18})\/([^/]+)/))) {
    ctx.kind = 'record';
    ctx.recordId = m[1];
    ctx.view = m[2];
    ctx.objectApiName = objectFromId(m[1]);
  } else if ((m = p.match(/^\/lightning\/o\/([^/]+)\/(list|home|new)/))) {
    ctx.kind = m[2] === 'new' ? 'new' : 'list';
    ctx.objectApiName = safeDecode(m[1]);
    ctx.listViewId = q.get('filterName') || undefined;
  } else if ((m = p.match(/^\/lightning\/setup\/ObjectManager\/([^/]+)(?:\/([^/]+))?/))) {
    ctx.kind = 'setup';
    ctx.objectApiName = safeDecode(m[1]);
    ctx.setupArea = m[2] && m[2] !== 'view' ? safeDecode(m[2]) : 'Details';
    ctx.setupPage = `ObjectManager/${ctx.objectApiName}/${ctx.setupArea}`;
  } else if ((m = p.match(/^\/lightning\/setup\/([^/]+)(?:\/(.*))?/))) {
    ctx.kind = 'setup';
    ctx.setupArea = safeDecode(m[1]);
    ctx.setupPage = m[2] && m[2] !== 'home' ? `${ctx.setupArea}/${safeDecode(m[2])}` : ctx.setupArea;
    if (ctx.setupArea === 'Flows' || ctx.setupArea === 'InteractionProcesses') ctx.kind = 'setup';
  } else if (/\/builder_platform_interaction\/flowBuilder\.app$/.test(p)) {
    ctx.kind = 'flow';
    ctx.flowId = q.get('flowId') || undefined;
    ctx.flowDefId = q.get('flowDefId') || undefined;
  } else if (/\/visualEditor\/appBuilder\.app$/.test(p)) {
    ctx.kind = 'flexipage';
    ctx.flexipageId = q.get('id') || q.get('flexipageId') || q.get('pageId') || undefined;
    ctx.objectApiName = q.get('objectApiName') || q.get('entityName') || undefined;
    ctx.pageType = q.get('pageType') || q.get('type') || undefined;
  } else if (/^\/lightning\/page\/home/.test(p) || p === '/lightning' || p === '/lightning/page') {
    ctx.kind = 'home';
  } else if ((m = p.match(/^\/lightning\/n\/([^/]+)/))) {
    ctx.kind = 'tab';
    ctx.tabName = safeDecode(m[1]);
  } else if ((m = p.match(/^\/([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)(?:\/[a-z])?$/)) && isSalesforceId(m[1])) {
    ctx.kind = 'record';
    ctx.recordId = m[1];
    ctx.objectApiName = objectFromId(m[1]);
    ctx.classic = true;
  } else if (/^\/apex\//.test(p) || /\.apexp$/.test(p)) {
    ctx.kind = 'visualforce';
    ctx.pageName = p.split('/').pop();
  } else if (q.get('id') && isSalesforceId(q.get('id'))) {
    ctx.kind = 'record';
    ctx.recordId = q.get('id');
    ctx.objectApiName = objectFromId(q.get('id'));
  } else {
    ctx.kind = 'other';
  }

  if (title)
    ctx.title = String(title)
      .replace(/\s*\|\s*Salesforce\s*$/i, '')
      .trim();
  ctx.label = contextLabel(ctx);
  return ctx;
}

export function objectFromId(id) {
  if (!id) return undefined;
  return KEY_PREFIXES[id.slice(0, 3)];
}

export function shortId(id) {
  if (!id) return '';
  return id.length > 8 ? `${id.slice(0, 6)}…${id.slice(-3)}` : id;
}

/** Human-friendly label for the context chip. */
export function contextLabel(ctx) {
  if (!ctx?.isSalesforce) return '';
  const obj = ctx.objectApiName;
  switch (ctx.kind) {
    case 'record':
      return `${obj || 'Record'} record ${shortId(ctx.recordId)}`;
    case 'list':
      return `${obj || 'Object'} list view`;
    case 'new':
      return `New ${obj || 'record'}`;
    case 'setup':
      if (obj) return `Object Manager: ${obj} › ${prettyArea(ctx.setupArea)}`;
      return `Setup: ${prettyArea(ctx.setupArea)}`;
    case 'flow':
      return ctx.title && ctx.title !== 'Flow Builder' ? `Flow Builder: ${ctx.title}` : 'Flow Builder';
    case 'flexipage':
      return obj ? `Lightning App Builder: ${obj} page` : 'Lightning App Builder';
    case 'home':
      return ctx.appName ? `${prettyArea(ctx.appName)} home` : 'Home';
    case 'tab':
      return `Tab: ${prettyArea(ctx.tabName)}`;
    case 'visualforce':
      return `Visualforce: ${ctx.pageName}`;
    default:
      return ctx.title || 'Salesforce';
  }
}

/** Quick-action chips generated from context (label + prompt). */
export function quickActionsFor(ctx) {
  const out = [];
  const obj = ctx?.objectApiName;
  if (!ctx?.isSalesforce) {
    return [
      {
        id: 'errors',
        label: 'Show recent errors',
        text: 'Show me the most recent errors and failed jobs in this org (Apex exceptions, flow errors, failed deployments).',
      },
      { id: 'summary', label: 'Summarize this org', text: 'Give me a short overview of this org: custom objects, automations and recent changes.' },
    ];
  }
  if (ctx.kind === 'record' && ctx.recordId) {
    out.push({
      id: 'explain',
      label: 'Explain this record',
      text: `Explain the ${obj || ''} record ${ctx.recordId}: key field values, related records, and which automations (flows, validation rules, triggers) touch it.`,
    });
    out.push({
      id: 'field-vis',
      label: 'Why is this field not visible?',
      text: `On the ${obj || 'current'} record page (${ctx.recordId}) a field I expect is not visible. Help me figure out why: check field-level security, page layout / Lightning record page assignment, record type and my profile/permission sets.`,
    });
  }
  if (obj && (ctx.kind === 'record' || ctx.kind === 'list' || ctx.kind === 'setup' || ctx.kind === 'new')) {
    out.push({
      id: 'add-field',
      label: `Add a field to ${obj}`,
      text: `I want to add a new custom field to ${obj}. Ask me for the label, type and where it should appear, then create it, add it to the layouts and validate the deployment.`,
    });
  }
  if (ctx.kind === 'setup' && obj) {
    out.push({
      id: 'describe-obj',
      label: `Describe ${obj}`,
      text: `Describe the ${obj} object: fields, record types, validation rules, page layouts and automations.`,
    });
  }
  if (ctx.kind === 'flow') {
    out.push({
      id: 'debug-flow',
      label: 'Debug this flow',
      text: `Debug the flow currently open in Flow Builder${ctx.flowId ? ` (flow version id ${ctx.flowId})` : ''}: read its metadata, explain each element, and point out likely errors or bad practices.`,
    });
    out.push({
      id: 'explain-flow',
      label: 'Explain this flow',
      text: `Explain what this flow does step by step in plain business language${ctx.flowId ? ` (flow version id ${ctx.flowId})` : ''}.`,
    });
  }
  if (ctx.kind === 'flexipage') {
    out.push({
      id: 'explain-page',
      label: 'Explain this page layout',
      text: `Explain the Lightning record page open in App Builder${obj ? ` for ${obj}` : ''}: regions, components and visibility rules.`,
    });
  }
  out.push({
    id: 'errors',
    label: 'Show recent errors',
    text: 'Show me the most recent errors in this org (Apex exceptions, flow errors, failed deployments) from the last 7 days.',
  });
  return out.slice(0, 5);
}

function prettyArea(s) {
  if (!s) return '';
  return String(s)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function emptyContext(url = '', title = '') {
  return { url, title, host: '', isSalesforce: false, kind: 'none', label: '' };
}

/**
 * Subset of the tab context the API accepts as pageContext.
 *
 * Only Salesforce tabs are reported. The content script is already scoped to Salesforce hosts, and
 * a panel left open on an unrelated tab must not send that page's URL to the server.
 */
export function toApiPageContext(ctx) {
  if (!ctx?.isSalesforce) return undefined;
  const out = {};
  if (ctx.url) out.url = ctx.url;
  if (ctx.title) out.title = String(ctx.title).slice(0, 500);
  if (ctx.recordId) out.recordId = ctx.recordId;
  if (ctx.objectApiName) out.objectApiName = ctx.objectApiName;
  if (ctx.flowId) out.flowId = ctx.flowId;
  if (ctx.setupPage) out.setupPage = ctx.setupPage;
  return out;
}
