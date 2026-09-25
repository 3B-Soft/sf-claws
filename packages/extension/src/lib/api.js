/**
 * Fetch wrapper for the SF Claws control plane. Base URL + token are provided by the caller
 * (configured in storage). JSON errors are thrown as Error with .code/.status/.details.
 */
import { createEmitter } from './store.js';

export const API_PREFIX = '/api/v1';
/** Floor for deploy/validate requests: long enough that a slow org is never mistaken for a failure. */
export const DEPLOY_REQUEST_FLOOR_MS = 15 * 60 * 1000;
export const apiEvents = createEmitter(); // 'unauthorized' | 'network' | 'online'

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get isNetwork() {
    return this.status === 0;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  get isNotFound() {
    return this.status === 404;
  }
  /** The client stopped waiting; the server may well still be working (deploys run for minutes). */
  get isTimeout() {
    return this.code === 'timeout';
  }
}

export function createApi({ getBaseUrl, getToken }) {
  const base = () => `${(getBaseUrl() || '').replace(/\/+$/, '')}${API_PREFIX}`;

  async function request(method, path, { body, query, headers = {}, raw = false, signal, timeoutMs = 30000, auth = true } = {}) {
    const url = new URL(base() + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const h = { Accept: 'application/json', ...headers };
    const token = auth ? getToken() : null;
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    let res;
    try {
      res = await fetch(url.toString(), { method, headers: h, body: payload, signal: ctrl.signal });
    } catch (err) {
      clearTimeout(t);
      const timedOut = err?.name === 'AbortError' && !signal?.aborted;
      const e = new ApiError(timedOut ? 'Request timed out' : `Cannot reach server (${err?.message || 'network error'})`, {
        status: 0,
        code: timedOut ? 'timeout' : 'network',
      });
      // A timeout says nothing about the server being reachable; only a real transport failure does.
      if (!timedOut) apiEvents.emit('network', e);
      throw e;
    }
    clearTimeout(t);
    apiEvents.emit('online');
    if (raw) return res;
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const err = json?.error || {};
      const e = new ApiError(err.message || `${res.status} ${res.statusText}`, {
        status: res.status,
        code: err.code || `http_${res.status}`,
        details: err.details,
      });
      if (res.status === 401 && auth && token) apiEvents.emit('unauthorized', e);
      throw e;
    }
    return { status: res.status, data: json ?? text };
  }

  const j = (method) => async (path, opts) => (await request(method, path, opts)).data;
  /** Start a deploy/validation run; normalizes 202-accepted and 200-with-result into one shape. */
  async function startRun(path) {
    const { status, data } = await request('POST', path, { timeoutMs: DEPLOY_REQUEST_FLOOR_MS });
    const run = data && typeof data === 'object' ? data : {};
    const terminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
    return status === 202 || !terminal ? { ...run, status: run.status || 'in_progress', running: true } : run;
  }
  const api = {
    request,
    get: j('GET'),
    post: j('POST'),
    put: j('PUT'),
    patch: j('PATCH'),
    delete: j('DELETE'),
    baseUrl: () => getBaseUrl(),
    eventsUrl(sessionId, after) {
      const u = new URL(`${base()}/sessions/${encodeURIComponent(sessionId)}/events`);
      u.searchParams.set('after', String(after ?? 0));
      const token = getToken();
      if (token) u.searchParams.set('token', token);
      return u.toString();
    },

    // ---- auth
    health: () => api.get('/health', { auth: false, timeoutMs: 8000 }),
    login: (email, password) => api.post('/auth/login', { body: { email, password }, auth: false }),
    me: () => api.get('/auth/me'),
    logout: () => api.post('/auth/logout').catch(() => null),
    deviceStart: () => api.post('/auth/device/start', { body: {}, auth: false }),
    /** Returns AuthResponse on 200, null while pending (202). */
    async devicePoll(code) {
      const r = await request('GET', '/auth/device/poll', { query: { code }, auth: false, timeoutMs: 10000 });
      return r.status === 200 && r.data && typeof r.data === 'object' && r.data.token ? r.data : null;
    },

    // ---- orgs
    resolveOrg: (host) => api.get('/orgs/resolve', { query: { host } }),
    attachBrowserSession: (orgId, accessToken, instanceUrl) => api.post(`/orgs/${orgId}/browser-session`, { body: { accessToken, instanceUrl } }),
    orgStatus: (orgId) => api.get(`/orgs/${orgId}/status`),
    query: (orgId, soql, { tooling = false, limit = 200 } = {}) => api.post(`/orgs/${orgId}/query`, { body: { soql, tooling, limit }, timeoutMs: 60000 }),
    describeGlobal: (orgId) => api.get(`/orgs/${orgId}/describe/global`, { timeoutMs: 60000 }),
    describeSobject: (orgId, name) => api.get(`/orgs/${orgId}/describe/${encodeURIComponent(name)}`, { timeoutMs: 60000 }),
    metadataTypes: (orgId) => api.get(`/orgs/${orgId}/metadata/types`, { timeoutMs: 60000 }),
    metadataList: (orgId, type) => api.get(`/orgs/${orgId}/metadata/list`, { query: { type }, timeoutMs: 60000 }),
    metadataRead: (orgId, type, fullName) => api.get(`/orgs/${orgId}/metadata/read`, { query: { type, fullName }, timeoutMs: 60000 }),

    // ---- sessions
    updateSession: (id, body) => api.patch(`/sessions/${id}`, { body }),
    listSessions: (q) => api.get('/sessions', { query: q }),
    createSession: (body) => api.post('/sessions', { body }),
    session: (id) => api.get(`/sessions/${id}`),
    history: (id, after = 0) => api.get(`/sessions/${id}/history`, { query: { after } }),
    sendMessage: (id, text, attachments, pageContext) =>
      api.post(`/sessions/${id}/messages`, {
        body: {
          text,
          ...(attachments?.length ? { attachments } : {}),
          ...(pageContext && Object.keys(pageContext).length ? { pageContext } : {}),
        },
      }),
    confirm: (id, confirmationId, optionId, answerText) => api.post(`/sessions/${id}/confirm`, { body: { confirmationId, optionId, answerText } }),
    cancel: (id) => api.post(`/sessions/${id}/cancel`),
    complete: (id) => api.post(`/sessions/${id}/complete`),
    browserCapture: (id, body) => api.post(`/sessions/${id}/browser-capture`, { body }),
    feedback: (id, helpful, note) => api.post(`/sessions/${id}/feedback`, { body: note ? { helpful, note } : { helpful } }),
    exportValidation: (id, deployId) => api.get(`/sessions/${encodeURIComponent(id)}/deploys/${encodeURIComponent(deployId)}/export`),
    exportWorkspace: async (id) => {
      const response = await request('GET', `/sessions/${encodeURIComponent(id)}/workspace/export`, { raw: true, timeoutMs: 120000 });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new ApiError(body?.error?.message || 'Workspace export failed', { status: response.status });
      }
      return response.blob();
    },
    workspace: (id) => api.get(`/sessions/${id}/workspace`),
    saveWorkspaceFile: (id, path, content) => api.put(`/sessions/${id}/workspace/file`, { body: { path, content } }),
    deploys: (id) => api.get(`/sessions/${id}/deploys`),
    /**
     * Validate/deploy are long jobs on a big or slow org. The HTTP call is only how the run is
     * started: the outcome arrives as a `deploy.validation` / `deploy.result` event, so the request
     * gets a generous floor rather than a deadline that turns a healthy deploy into a failure.
     * A server that answers 202 (or 200 with no terminal status) is reported as still running.
     */
    validate: (id) => startRun(`/sessions/${id}/validate`),
    deploy: (id) => startRun(`/sessions/${id}/deploy`),
    compact: (id) => api.post(`/sessions/${id}/compact`, { timeoutMs: 120000 }),
    docs: (id) => api.get(`/sessions/${id}/docs`),
    commit: (id, message, createPullRequest) =>
      api.post(`/sessions/${id}/commit`, { body: { message: message || undefined, createPullRequest }, timeoutMs: 120000 }),
    snapshot: (id) => api.get(`/sessions/${id}/snapshot`, { timeoutMs: 60000 }),
    todos: (id) => api.get(`/sessions/${id}/todos`),
    notes: (id) => api.get(`/sessions/${id}/notes`),
    resume: (id) => api.post(`/sessions/${id}/resume`),
    permissions: (id) => api.get(`/sessions/${id}/permissions`),
    revokePermission: (id, command) => api.delete(`/sessions/${id}/permissions/${encodeURIComponent(command)}`),
    orgLimits: (orgId, force = false) => api.get(`/orgs/${orgId}/limits`, { query: force ? { force: '1' } : undefined, timeoutMs: 20000 }),
    orgDocs: (orgId) => api.get(`/orgs/${orgId}/docs`),

    // ---- github
    github: (clientId) => api.get(`/clients/${clientId}/github`),
    githubBranches: (clientId) => api.get(`/clients/${clientId}/github/branches`, { timeoutMs: 60000 }),
    githubCompare: (clientId, base, head) => api.get(`/clients/${clientId}/github/compare`, { query: { base, head }, timeoutMs: 60000 }),
    githubCommits: (clientId, branch) => api.get(`/clients/${clientId}/github/commits`, { query: { branch }, timeoutMs: 60000 }),
    githubFile: (clientId, path, ref) => api.get(`/clients/${clientId}/github/file`, { query: { path, ref }, timeoutMs: 60000 }),
  };
  return api;
}

/** Normalize list-ish payloads: [] | {items:[]} | {records:[]} | {data:[]} | {<key>:[]}. */
export function asList(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const k of [...keys, 'items', 'records', 'data', 'results', 'sobjects', 'types', 'files', 'branches', 'commits', 'sessions', 'docs']) {
      if (Array.isArray(payload[k])) return payload[k];
    }
  }
  return [];
}
