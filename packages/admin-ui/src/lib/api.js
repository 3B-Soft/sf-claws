/**
 * Fetch wrapper for the SF Claws control plane REST API (see packages/shared/src/api.ts).
 * Base URL: window.SF_CLAWS_API_BASE || localStorage['sfclaws.apiBase'] || same origin. Prefix /api/v1.
 * Errors are thrown as ApiError { status, code, message, details }.
 *
 * The JWT lives in sessionStorage, not localStorage: it is gone when the tab closes, is not shared
 * with other tabs, and is not readable by anything that later gets a handle on the origin's
 * persistent storage. The trade-off is a sign-in per tab; for an admin console that holds the keys
 * to every client's org that is the right side to err on. A token left behind by an older build in
 * localStorage is moved across once and removed.
 */
export const API_PREFIX = '/api/v1';
const TOKEN_KEY = 'sfclaws.token';
const BASE_KEY = 'sfclaws.apiBase';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get isNetwork() {
    return this.status === 0;
  }
  get isAuth() {
    return this.status === 401;
  }
}

export function getApiBase() {
  const w = typeof window !== 'undefined' ? window : {};
  let base = w.SF_CLAWS_API_BASE;
  if (!base) {
    try {
      base = localStorage.getItem(BASE_KEY) || '';
    } catch {
      base = '';
    }
  }
  return String(base || '').replace(/\/+$/, '');
}
export function setApiBase(url) {
  try {
    url ? localStorage.setItem(BASE_KEY, url) : localStorage.removeItem(BASE_KEY);
  } catch {
    /* ignore */
  }
}
export function apiUrl(path) {
  return `${getApiBase()}${API_PREFIX}${path.startsWith('/') ? path : '/' + path}`;
}

export function getToken() {
  try {
    const current = sessionStorage.getItem(TOKEN_KEY);
    if (current) return current;
    // One-time migration from the localStorage slot older builds used.
    const legacy = localStorage.getItem(TOKEN_KEY);
    if (legacy) {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.setItem(TOKEN_KEY, legacy);
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}
export function setToken(token) {
  try {
    token ? sessionStorage.setItem(TOKEN_KEY, token) : sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

let onUnauthorized = null;
/** Register a callback fired when the server answers 401 (used to drop the session). */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/** Build a query string from an object, skipping empty values. */
export function qs(params = {}) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    sp.set(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function request(method, path, body, opts = {}) {
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token && !opts.noAuth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(apiUrl(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError('Cannot reach the SF Claws server. Check that it is running and the API base URL is correct.', { status: 0, code: 'NETWORK' });
  }
  if (res.ok && opts.blob) return res.blob();
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const err = data?.error || {};
    const apiErr = new ApiError(err.message || res.statusText || `HTTP ${res.status}`, {
      status: res.status,
      code: err.code || `HTTP_${res.status}`,
      details: err.details,
    });
    if (res.status === 401 && !opts.noAuth && onUnauthorized) onUnauthorized(apiErr);
    throw apiErr;
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body ?? {}, opts),
  put: (path, body, opts) => request('PUT', path, body ?? {}, opts),
  patch: (path, body, opts) => request('PATCH', path, body ?? {}, opts),
  del: (path, opts) => request('DELETE', path, undefined, opts),
};

// ---------------------------------------------------------------------------
// Typed helpers, one per contract route (method + path exactly as documented).
// ---------------------------------------------------------------------------
export const Api = {
  health: () => api.get('/health', { noAuth: true }),
  // auth
  register: (body) => api.post('/auth/register', body, { noAuth: true }),
  login: (body) => api.post('/auth/login', body, { noAuth: true }),
  me: () => api.get('/auth/me'),
  patchMe: (body) => api.patch('/auth/me', body),
  changePassword: (body) => api.post('/auth/change-password', body),
  logout: () => api.post('/auth/logout'),
  deviceApprove: (code) => api.post('/auth/device/approve', { code }),
  // admin: users
  listUsers: () => api.get('/admin/users'),
  approveUser: (id, role) => api.post(`/admin/users/${enc(id)}/approve`, { role }),
  disableUser: (id) => api.post(`/admin/users/${enc(id)}/disable`),
  updateUser: (id, body) => api.patch(`/admin/users/${enc(id)}`, body),
  // client membership (who may see which client); mutations are super admin only
  listMemberships: () => api.get('/admin/memberships'),
  listClientMembers: (clientId) => api.get(`/clients/${enc(clientId)}/members`),
  setClientMember: (clientId, userId, role) => api.put(`/clients/${enc(clientId)}/members/${enc(userId)}`, { role }),
  removeClientMember: (clientId, userId) => api.del(`/clients/${enc(clientId)}/members/${enc(userId)}`),
  // admin: providers & models
  listProviders: () => api.get('/admin/providers'),
  setProvider: (provider, body) => api.put(`/admin/providers/${enc(provider)}`, body),
  testProvider: (provider) => api.post(`/admin/providers/${enc(provider)}/test`),
  deleteProvider: (provider) => api.del(`/admin/providers/${enc(provider)}`),
  stats: () => api.get('/admin/stats'),
  listModels: () => api.get('/admin/models'),
  createModel: (body) => api.post('/admin/models', body),
  updateModel: (id, body) => api.patch(`/admin/models/${enc(id)}`, body),
  deleteModel: (id) => api.del(`/admin/models/${enc(id)}`),
  getRoleBindings: () => api.get('/admin/role-bindings'),
  setRoleBindings: (bindings) => api.put('/admin/role-bindings', bindings),
  // clients, orgs, github
  // Knowledge sources: product documentation and product source repositories the agents may read.
  listKnowledge: () => api.get('/admin/knowledge'),
  createKnowledge: (body) => api.post('/admin/knowledge', body),
  updateKnowledge: (id, body) => api.patch(`/admin/knowledge/${enc(id)}`, body),
  deleteKnowledge: (id) => api.del(`/admin/knowledge/${enc(id)}`),
  testKnowledge: (id) => api.post(`/admin/knowledge/${enc(id)}/test`),

  // Admin-defined specialists layered on the built-in agent roles.
  listCustomAgents: () => api.get('/admin/agents'),
  createCustomAgent: (body) => api.post('/admin/agents', body),
  updateCustomAgent: (id, body) => api.patch(`/admin/agents/${enc(id)}`, body),
  deleteCustomAgent: (id) => api.del(`/admin/agents/${enc(id)}`),

  // Observability.
  toolSummary: (query) => api.get('/admin/tools/summary', { query }),
  budget: () => api.get('/admin/budget'),

  listClients: () => api.get('/clients'),
  createClient: (body) => api.post('/clients', body),
  getClient: (id) => api.get(`/clients/${enc(id)}`),
  updateClient: (id, body) => api.patch(`/clients/${enc(id)}`, body),
  deleteClient: (id) => api.del(`/clients/${enc(id)}`),
  listOrgs: (clientId) => api.get(`/clients/${enc(clientId)}/orgs`),
  createOrg: (clientId, body) => api.post(`/clients/${enc(clientId)}/orgs`, body),
  getOrg: (orgId) => api.get(`/orgs/${enc(orgId)}`),
  updateOrg: (orgId, body) => api.patch(`/orgs/${enc(orgId)}`, body),
  deleteOrg: (orgId) => api.del(`/orgs/${enc(orgId)}`),
  orgLimits: (orgId, force) => api.get(`/orgs/${enc(orgId)}/limits${qs({ force: force ? '1' : '' })}`),
  orgConnectStart: (orgId) => api.get(`/orgs/${enc(orgId)}/connect/start`),
  orgDisconnect: (orgId) => api.post(`/orgs/${enc(orgId)}/disconnect`),
  orgStatus: (orgId) => api.get(`/orgs/${enc(orgId)}/status`),
  orgQuery: (orgId, body) => api.post(`/orgs/${enc(orgId)}/query`, body),
  getGithub: (clientId) => api.get(`/clients/${enc(clientId)}/github`),
  setGithub: (clientId, body) => api.put(`/clients/${enc(clientId)}/github`, body),
  githubTest: (clientId) => api.post(`/clients/${enc(clientId)}/github/test`),
  deleteGithub: (clientId) => api.del(`/clients/${enc(clientId)}/github`),
  githubBranches: (clientId) => api.get(`/clients/${enc(clientId)}/github/branches`),
  githubCompare: (clientId, base, head) => api.get(`/clients/${enc(clientId)}/github/compare${qs({ base, head })}`),
  githubCommits: (clientId, branch) => api.get(`/clients/${enc(clientId)}/github/commits${qs({ branch })}`),
  githubOrgDiff: (clientId, body) => api.post(`/clients/${enc(clientId)}/github/org-diff`, body),
  githubOrgPull: (clientId, body) => api.post(`/clients/${enc(clientId)}/github/org-pull`, body),
  githubFile: (clientId, path, ref) => api.get(`/clients/${enc(clientId)}/github/file${qs({ path, ref })}`),
  // skills & policy
  listSkills: (params) => api.get(`/skills${qs(params)}`),
  getSkill: (id) => api.get(`/skills/${enc(id)}`),
  createSkill: (body) => api.post('/skills', body),
  updateSkill: (id, body) => api.patch(`/skills/${enc(id)}`, body),
  deleteSkill: (id) => api.del(`/skills/${enc(id)}`),
  getPolicy: (clientId) => api.get(`/admin/policy${qs({ clientId })}`),
  setPolicy: (clientId, body) => api.put(`/admin/policy${qs({ clientId })}`, body),
  // projects & tasks
  listProjects: (clientId) => api.get(`/projects${qs({ clientId })}`),
  createProject: (body) => api.post('/projects', body),
  updateProject: (id, body) => api.patch(`/projects/${enc(id)}`, body),
  listTasks: (params) => api.get(`/tasks${qs(params)}`),
  createTask: (body) => api.post('/tasks', body),
  updateTask: (id, body) => api.patch(`/tasks/${enc(id)}`, body),
  deleteTask: (id) => api.del(`/tasks/${enc(id)}`),
  // sessions
  listSessions: (params) => api.get(`/sessions${qs(params)}`),
  adminSessions: (params) => api.get(`/admin/sessions${qs(params)}`),
  updateSession: (id, body) => api.patch(`/sessions/${enc(id)}`, body),
  getSession: (id) => api.get(`/sessions/${enc(id)}`),
  sessionHistory: async (id, after = 0, through) => {
    const events = [];
    while (true) {
      const page = await api.get(`/sessions/${enc(id)}/history${qs({ after, through })}`);
      events.push(...page);
      if (page.length < 5000) return events;
      const next = page[page.length - 1].seq;
      if (next <= after) return events;
      after = next;
    }
  },
  exportValidation: (id, deployId) => api.get(`/sessions/${enc(id)}/deploys/${enc(deployId)}/export`, { blob: true }),
  exportWorkspace: (id) => api.get(`/sessions/${enc(id)}/workspace/export`, { blob: true }),
  exportAudit: (id) => api.get(`/sessions/${enc(id)}/audit/export`, { blob: true }),
  exportSession: (id) => api.get(`/sessions/${enc(id)}/export`, { blob: true }),
  sessionWorkspace: (id) => api.get(`/sessions/${enc(id)}/workspace`),
  putWorkspaceFile: (id, body) => api.put(`/sessions/${enc(id)}/workspace/file`, body),
  sessionDeploys: (id) => api.get(`/sessions/${enc(id)}/deploys`),
  sessionDocs: (id) => api.get(`/sessions/${enc(id)}/docs`),
  sendMessage: (id, body) => api.post(`/sessions/${enc(id)}/messages`, body),
  confirmSession: (id, body) => api.post(`/sessions/${enc(id)}/confirm`, body),
  cancelSession: (id) => api.post(`/sessions/${enc(id)}/cancel`),
  feedback: (id, body) => api.post(`/sessions/${enc(id)}/feedback`, body),
  validateSession: (id) => api.post(`/sessions/${enc(id)}/validate`),
  deploySession: (id) => api.post(`/sessions/${enc(id)}/deploy`),
  commitSession: (id, body) => api.post(`/sessions/${enc(id)}/commit`, body),
  completeSession: (id) => api.post(`/sessions/${enc(id)}/complete`),
  resumeSession: (id) => api.post(`/sessions/${enc(id)}/resume`),
  sessionTodos: (id) => api.get(`/sessions/${enc(id)}/todos`),
  sessionNotes: (id) => api.get(`/sessions/${enc(id)}/notes`),
  sessionSnapshot: (id) => api.get(`/sessions/${enc(id)}/snapshot`),
  sessionPermissions: (id) => api.get(`/sessions/${enc(id)}/permissions`),
  revokePermission: (id, command) => api.del(`/sessions/${enc(id)}/permissions/${enc(command)}`),
  deleteWorkspaceFile: (id, path) => api.del(`/sessions/${enc(id)}/workspace/file${qs({ path })}`),
  getDoc: (docId) => api.get(`/docs/${enc(docId)}`),
  // observability
  usageSummary: (params) => api.get(`/admin/usage/summary${qs(params)}`),
  usageRecords: (params) => api.get(`/admin/usage/records${qs(params)}`),
  audit: (limit) => api.get(`/admin/audit${qs({ limit })}`),
};

function enc(v) {
  return encodeURIComponent(String(v));
}

/** SSE URL for a session (token in query, as allowed by the contract). */
export function sseUrl(sessionId, after = 0) {
  return apiUrl(`/sessions/${enc(sessionId)}/events${qs({ after, token: getToken() })}`);
}

/** Normalize list responses: accept `[]` or `{ items: [] }` / `{ data: [] }`. */
export function asList(res, key) {
  if (Array.isArray(res)) return res;
  if (res && key && Array.isArray(res[key])) return res[key];
  if (res && Array.isArray(res.items)) return res.items;
  if (res && Array.isArray(res.data)) return res.data;
  return [];
}
