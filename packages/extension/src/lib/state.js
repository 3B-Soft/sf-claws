/** App-wide state + API singleton shared by all side-panel components. */
import { createStore } from './store.js';
import { createApi, apiEvents } from './api.js';
import { storage, KEYS, normalizeServerUrl } from './storage.js';
import { getContext, onMessage, hasHostPermission, hasChrome, armRecorder, getSalesforceSession } from './bridge.js';
import { toApiPageContext } from './context.js';

export const TABS = [
  { id: 'chat', label: 'Chat' },
  { id: 'changes', label: 'Changes' },
  { id: 'explore', label: 'Explore' },
  { id: 'notes', label: 'Notes' },
  { id: 'github', label: 'GitHub' },
];

export const appStore = createStore({
  booted: false,
  screen: 'loading', // loading | setup | login | pending | main
  serverUrl: '',
  hostPermission: true,
  health: null,
  token: null,
  user: null,
  uiMode: 'visual',
  tab: 'chat',
  networkError: null, // string | null
  reloadTick: 0,
  // page context
  tabId: null,
  context: null,
  // org resolution
  orgState: 'none', // none | resolving | resolved | unregistered | error
  org: null,
  client: null,
  orgError: null,
  orgIdentity: null,
  orgLimits: null, // OrgLimits (GET /orgs/:id/limits or org.limits event)
  orgLimitsError: null,
  // current session
  sessionId: null,
});

export const api = createApi({
  getBaseUrl: () => appStore.get().serverUrl,
  getToken: () => appStore.get().token,
});

export const isPro = () => appStore.get().uiMode === 'pro';

let bootPromise = null;
export function boot() {
  if (!bootPromise)
    bootPromise = doBoot().finally(() => {
      bootPromise = null;
    });
  return bootPromise;
}

async function doBoot() {
  const [serverUrl, uiMode, token, cachedUser] = await Promise.all([
    storage.sync.get(KEYS.serverUrl, ''),
    storage.sync.get(KEYS.uiMode, 'visual'),
    storage.local.get(KEYS.token, null),
    storage.local.get(KEYS.user, null),
  ]);
  appStore.set({ serverUrl: normalizeServerUrl(serverUrl), uiMode: uiMode === 'pro' ? 'pro' : 'visual', token, user: cachedUser, booted: true });
  if (!appStore.get().serverUrl) {
    appStore.set({ screen: 'setup' });
    return;
  }
  appStore.set({ hostPermission: await hasHostPermission(appStore.get().serverUrl) });
  if (!appStore.get().hostPermission) {
    appStore.set({ screen: 'setup' });
    return;
  }
  if (!token) {
    appStore.set({ screen: 'login' });
    return;
  }
  try {
    const user = await api.me();
    await setUser(user);
  } catch (e) {
    if (e.isUnauthorized) {
      await clearAuth();
      appStore.set({ screen: 'login' });
      return;
    }
    if (e.isNetwork) {
      appStore.set({ networkError: e.message, screen: cachedUser ? (cachedUser.status === 'pending' ? 'pending' : 'main') : 'login' });
      return;
    }
    appStore.set({ screen: 'login', networkError: null });
  }
}

export async function setUser(user) {
  await storage.local.set(KEYS.user, user);
  appStore.set({ user, screen: user?.status === 'pending' ? 'pending' : user?.status === 'disabled' ? 'login' : 'main', networkError: null });
  if (appStore.get().screen === 'main') refreshOrg();
}

export async function setAuth(authResponse) {
  await storage.local.set(KEYS.token, authResponse.token);
  await storage.local.set(KEYS.tokenExpiresAt, authResponse.expiresAt || null);
  appStore.set({ token: authResponse.token });
  await setUser(authResponse.user);
}

export async function clearAuth() {
  await storage.local.remove(KEYS.token);
  await storage.local.remove(KEYS.user);
  appStore.set({ token: null, user: null, sessionId: null, org: null, client: null, orgState: 'none' });
}

export async function logout() {
  try {
    await api.logout();
  } catch {
    /* ignore */
  }
  await clearAuth();
  appStore.set({ screen: 'login' });
}

export async function saveServerUrl(url) {
  const normalized = normalizeServerUrl(url);
  await storage.sync.set(KEYS.serverUrl, normalized);
  appStore.set({ serverUrl: normalized, health: null });
  return normalized;
}

export async function setUiMode(mode) {
  const uiMode = mode === 'pro' ? 'pro' : 'visual';
  await storage.sync.set(KEYS.uiMode, uiMode);
  appStore.set({ uiMode });
}

export function setTab(tab) {
  appStore.set({ tab: tab === 'docs' ? 'notes' : tab });
}
export function retry() {
  appStore.set((s) => ({ networkError: null, reloadTick: s.reloadTick + 1 }));
  if (appStore.get().screen !== 'main') boot();
  else refreshOrg();
}

// ---- auth / network events ------------------------------------------------
apiEvents.on('unauthorized', async () => {
  await clearAuth();
  appStore.set({ screen: 'login', networkError: null });
});
apiEvents.on('network', (e) => {
  appStore.set({ networkError: e.message });
});
apiEvents.on('online', () => {
  if (appStore.get().networkError) appStore.set({ networkError: null });
});

// ---- page context -----------------------------------------------------------
let contextInit = false;
export function initContextTracking() {
  if (contextInit) return;
  contextInit = true;
  getContext().then(({ tabId, context }) => applyContext(tabId, context));
  onMessage((msg) => {
    if (msg?.type === 'contextChanged') {
      // Only follow the active tab: ask the background which tab is active when unsure.
      getContext().then(({ tabId, context }) => {
        if (msg.tabId == null || tabId == null || msg.tabId === tabId) applyContext(tabId, context ?? msg.context);
      });
    }
  });
  if (hasChrome && chrome.tabs?.onActivated) {
    chrome.tabs.onActivated.addListener(() => getContext().then(({ tabId, context }) => applyContext(tabId, context)));
  }
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) getContext().then(({ tabId, context }) => applyContext(tabId, context));
    });
}

function applyContext(tabId, context) {
  const prev = appStore.get().context;
  const prevHost = prev?.isSalesforce ? prev.host : null;
  const nextHost = context?.isSalesforce ? context.host : null;
  appStore.set({ tabId, context: context || null });
  // The recorder follows the session: arm it on whichever Salesforce tab the panel is attached to.
  if (appStore.get().sessionId && tabId != null && context?.isSalesforce) void armRecorder(tabId);
  if (prevHost !== nextHost || appStore.get().orgState === 'none') refreshOrg();
}

let orgReq = 0;
export async function refreshOrg() {
  const s = appStore.get();
  if (s.screen !== 'main' || !s.token) return;
  const host = s.context?.isSalesforce ? s.context.host : null;
  if (!host) {
    appStore.set({ orgState: 'none', org: null, client: null, orgError: null });
    return;
  }
  const id = ++orgReq;
  appStore.set({ orgState: 'resolving', orgError: null });
  const applyResolved = async (org, client) => {
    appStore.set({ orgState: 'resolved', org, client, orgError: null, orgLimits: appStore.get().org?.id === org.id ? appStore.get().orgLimits : null });
    refreshLimits();
    // Session continuity per org
    const map = await storage.local.get(KEYS.lastSessionByOrg, {});
    const prevSession = appStore.get().sessionId;
    if (!prevSession || appStore.get().org?.id !== org.id) appStore.set({ sessionId: map?.[org.id] || null });
  };
  try {
    const res = await api.resolveOrg(host);
    if (id !== orgReq) return;
    const org = res?.org || (res?.id ? res : null);
    const client = res?.client || (org?.client ?? null);
    if (!org) {
      appStore.set({ orgState: 'unregistered', org: null, client: null });
      return;
    }
    if (client?.salesforceAuthMode === 'browser_session') {
      const browserSession = await getSalesforceSession(host, org.sfOrgId);
      if (browserSession.error) throw new Error(browserSession.error);
      await api.attachBrowserSession(org.id, browserSession.accessToken, browserSession.instanceUrl);
      org.status = 'connected';
    }
    const byHost = (await storage.local.get(KEYS.orgByHost, {})) || {};
    byHost[host] = { org, client, at: new Date().toISOString() };
    storage.local.set(KEYS.orgByHost, byHost);
    await applyResolved(org, client);
  } catch (e) {
    if (id !== orgReq) return;
    if (e.isNotFound) {
      appStore.set({ orgState: 'unregistered', org: null, client: null, orgError: null });
      return;
    }
    if (e.isNetwork) {
      // Offline: fall back to the last resolution for this host so cached sessions stay reachable.
      const cached = (await storage.local.get(KEYS.orgByHost, {}))?.[host];
      if (cached?.org) {
        await applyResolved(cached.org, cached.client || null);
        return;
      }
    }
    appStore.set({ orgState: 'error', orgError: e.message });
  }
}

export async function selectSession(sessionId) {
  appStore.set({ sessionId });
  const org = appStore.get().org;
  if (org) {
    const map = (await storage.local.get(KEYS.lastSessionByOrg, {})) || {};
    if (sessionId) map[org.id] = sessionId;
    else delete map[org.id];
    await storage.local.set(KEYS.lastSessionByOrg, map);
  }
}

export function currentPageContextForApi() {
  return toApiPageContext(appStore.get().context);
}

// ---- org API limits ---------------------------------------------------------
let limitsTimer = null;
export function setOrgLimits(limits) {
  if (!limits || !Array.isArray(limits.limits)) return;
  const { org, orgLimits } = appStore.get();
  if (org && limits.orgId && limits.orgId !== org.id) return;
  // Keep the freshest snapshot (event vs. polled GET can arrive in any order).
  if (orgLimits?.fetchedAt && limits.fetchedAt && Date.parse(limits.fetchedAt) < Date.parse(orgLimits.fetchedAt)) return;
  appStore.set({ orgLimits: limits, orgLimitsError: null });
}
export async function refreshLimits(force = false) {
  const org = appStore.get().org;
  if (!org) return;
  try {
    setOrgLimits(await api.orgLimits(org.id, force));
  } catch (e) {
    if (appStore.get().org?.id === org.id) appStore.set({ orgLimitsError: e.message });
  }
  if (limitsTimer) clearInterval(limitsTimer);
  limitsTimer = setInterval(
    () => {
      if (typeof document === 'undefined' || !document.hidden) refreshLimits();
    },
    5 * 60 * 1000,
  );
}
