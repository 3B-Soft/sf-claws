/**
 * MV3 service worker: tracks the active tab's Salesforce context, badges SF tabs, relays
 * context changes to the side panel, serves `getContext` / `openAdminPage` /
 * `requestHostPermission` messages, arms the page recorder on the one tab a session is open on,
 * and tells the user when an approval card is waiting (badge count + notification).
 */
import { parseSalesforceContext, isSalesforceHost } from './lib/context.js';
import { installRecorder } from './recorder.js';

/** @type {Map<number, object>} tabId -> context (URL-derived, merged with content-script data) */
const contexts = new Map();
/** @type {Map<number, string>} tabId -> nonce of the recorder injected into that tab's frames */
const recorders = new Map();
/**
 * Approval cards waiting on the session the panel currently shows, as last reported by the panel:
 * { count, sessionId, title, panelVisible }. Drives the badge and the notification.
 */
let awaiting = { count: 0, sessionId: null, title: '', panelVisible: false };
const NOTIFICATIONS_KEY = 'notifications';

chrome.runtime.onInstalled.addListener(() => {
  setup();
});
chrome.runtime.onStartup.addListener(() => {
  setup();
});
setup();

function setup() {
  try {
    chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } catch {
    /* ignore */
  }
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs || []) if (t.id != null && t.url) updateFromUrl(t.id, t.url, t.title, false);
  });
}

function updateFromUrl(tabId, url, title, notify = true) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  if (!isSalesforceHost(host)) {
    const had = contexts.delete(tabId);
    setBadge(tabId, false);
    if (had && notify) broadcast(tabId, null);
    return;
  }
  const prev = contexts.get(tabId);
  const ctx = parseSalesforceContext(url, title || prev?.title || '');
  // Keep richer data from the content script if it refers to the same URL.
  const merged = prev && prev.url === ctx.url ? { ...ctx, ...prev, ...ctx, title: prev.title || ctx.title, label: ctx.label } : ctx;
  contexts.set(tabId, merged);
  setBadge(tabId, true);
  if (notify) broadcast(tabId, merged);
}

/**
 * Badge: the number of approval cards waiting when there are any (amber), otherwise "SF" on
 * Salesforce tabs. The count is global, not per tab: the card belongs to the session the panel
 * shows, and the user needs to see it from whichever tab they wandered off to.
 */
function setBadge(tabId, isSf) {
  try {
    if (awaiting.count > 0) {
      chrome.action.setBadgeText({ tabId, text: String(awaiting.count) }).catch?.(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#b45309' }).catch?.(() => {});
      return;
    }
    chrome.action.setBadgeText({ tabId, text: isSf ? 'SF' : '' }).catch?.(() => {});
    if (isSf) chrome.action.setBadgeBackgroundColor({ tabId, color: '#0176d3' }).catch?.(() => {});
  } catch {
    /* tab may be gone */
  }
}
function refreshAllBadges() {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs || []) if (t.id != null) setBadge(t.id, contexts.has(t.id));
  });
}

async function notificationsEnabled() {
  try {
    const r = await chrome.storage.sync.get(NOTIFICATIONS_KEY);
    return r[NOTIFICATIONS_KEY] !== false; // default on
  } catch {
    return true;
  }
}

/**
 * The panel reports how many cards await on its session. A rising count while the panel is not
 * visible (another window has focus, or the panel document is hidden) becomes a system
 * notification; clicking it opens the side panel on the reporting tab. The panel is the only
 * thing holding the event stream, so a closed panel cannot notify: that would need server-side
 * push, which is noted in docs/USER-GUIDE.md rather than pretended here.
 */
async function onAwaitingCards(next, sender) {
  const rose = next.count > awaiting.count;
  awaiting = { count: next.count || 0, sessionId: next.sessionId || null, title: next.title || '', panelVisible: !!next.panelVisible };
  refreshAllBadges();
  if (!rose || awaiting.panelVisible || !chrome.notifications) return;
  if (!(await notificationsEnabled())) return;
  const id = `sf-claws-await-${awaiting.sessionId || 'session'}`;
  const n = awaiting.count;
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: n === 1 ? 'SF Claws needs your approval' : `SF Claws: ${n} approvals waiting`,
      message: awaiting.title ? `${awaiting.title}. Open the side panel to review it.` : 'Open the side panel to review it.',
      priority: 1,
    });
    notificationTabs.set(id, next.tabId ?? sender?.tab?.id ?? null);
  } catch {
    /* notifications unavailable */
  }
}
/** @type {Map<string, number|null>} notification id -> tab to open the panel on */
const notificationTabs = new Map();
chrome.notifications?.onClicked?.addListener((id) => {
  const tabId = notificationTabs.get(id);
  notificationTabs.delete(id);
  chrome.notifications.clear(id);
  const open = (tab) => {
    if (!tab || !chrome.sidePanel?.open) return;
    chrome.windows?.update?.(tab.windowId, { focused: true });
    chrome.tabs.update(tab.id, { active: true });
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  };
  if (tabId != null) chrome.tabs.get(tabId, (tab) => open(chrome.runtime.lastError ? null : tab));
  else activeTab().then(open);
});

/** Re-paint every badge after the pending count changed (including the default, tab-less one). */
function refreshBadges() {
  try {
    chrome.action.setBadgeText({ text: pendingCount > 0 ? String(pendingCount) : '' }).catch?.(() => {});
    chrome.action.setBadgeBackgroundColor({ color: badgeColor() }).catch?.(() => {});
  } catch {
    /* ignore */
  }
  for (const tabId of contexts.keys()) setBadge(tabId, true);
}

function clearNotifications() {
  for (const id of raised) chrome.notifications?.clear(id, () => void chrome.runtime.lastError);
  raised.clear();
}

/** Raise a click-through notification for a card the user cannot see. */
function notifyConfirmation(notify) {
  if (!notify || !chrome.notifications?.create) return;
  const id = `${NOTIFICATION_PREFIX}${notify.id}`;
  if (raised.has(id)) return;
  raised.add(id);
  chrome.notifications.create(
    id,
    {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: notify.title || 'SF Claws needs your approval',
      message: String(notify.body || 'A confirmation is waiting in the side panel.').slice(0, 240),
      priority: 2,
      requireInteraction: true,
    },
    () => void chrome.runtime.lastError,
  );
}

chrome.notifications?.onClicked?.addListener((id) => {
  if (!id.startsWith(NOTIFICATION_PREFIX)) return;
  chrome.notifications.clear(id, () => void chrome.runtime.lastError);
  raised.delete(id);
  activeTab().then((tab) => {
    if (tab?.id != null && chrome.sidePanel?.open) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  });
});

function broadcast(tabId, context) {
  try {
    chrome.runtime.sendMessage({ type: 'contextChanged', tabId, context }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* no listeners */
  }
}

/**
 * Inject the page recorder into every frame of one tab with a fresh nonce. Only called for the
 * tab a session is open on; a navigation (`status: 'loading'`) drops the nonce so the next
 * capture on that tab says "no recording" until the panel arms it again.
 */
async function armRecorder(tabId) {
  const ctx = contexts.get(tabId);
  if (!ctx?.isSalesforce || !chrome.scripting?.executeScript) return { armed: false };
  if (recorders.has(tabId)) return { armed: true };
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', injectImmediately: true, func: installRecorder, args: [nonce] });
    recorders.set(tabId, nonce);
    return { armed: true };
  } catch (e) {
    return { armed: false, error: e?.message || 'inject failed' };
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading') recorders.delete(tabId);
  if (info.url || info.status === 'complete' || info.title) updateFromUrl(tabId, tab.url || info.url || '', tab.title);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    if (tab.url) updateFromUrl(tabId, tab.url, tab.title, false);
    broadcast(tabId, contexts.get(tabId) || null);
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  contexts.delete(tabId);
  recorders.delete(tabId);
});
chrome.windows?.onFocusChanged?.addListener(() => {
  activeTab().then((tab) => {
    if (tab) broadcast(tab.id, contexts.get(tab.id) || null);
  });
});

function activeTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (tabs?.length) return resolve(tabs[0]);
      chrome.tabs.query({ active: true }, (all) => resolve((all || [])[0] || null));
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  switch (msg.type) {
    case 'pageContext': {
      const tabId = sender.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false });
        return false;
      }
      const url = msg.context?.url || sender.tab?.url || sender.url || '';
      const ctx = parseSalesforceContext(url, msg.context?.title || sender.tab?.title || '');
      const merged = { ...ctx, ...(msg.context || {}), label: ctx.label, isSalesforce: ctx.isSalesforce, host: ctx.host, kind: ctx.kind };
      contexts.set(tabId, merged);
      setBadge(tabId, true);
      broadcast(tabId, merged);
      sendResponse({ ok: true });
      return false;
    }
    case 'getContext': {
      const tabIdArg = msg.tabId;
      (async () => {
        const tab = tabIdArg != null ? await new Promise((r) => chrome.tabs.get(tabIdArg, (t) => r(chrome.runtime.lastError ? null : t))) : await activeTab();
        if (!tab) return sendResponse({ tabId: null, context: null });
        if (!contexts.has(tab.id) && tab.url) updateFromUrl(tab.id, tab.url, tab.title, false);
        sendResponse({ tabId: tab.id, tabUrl: tab.url, context: contexts.get(tab.id) || null });
      })();
      return true;
    }
    case 'armRecorder': {
      // The panel opened a session on this tab: start recording there, and only there.
      (async () => {
        const tab = msg.tabId != null ? await new Promise((r) => chrome.tabs.get(msg.tabId, (t) => r(chrome.runtime.lastError ? null : t))) : await activeTab();
        if (!tab) return sendResponse({ armed: false, error: 'no tab' });
        if (!contexts.has(tab.id) && tab.url) updateFromUrl(tab.id, tab.url, tab.title, false);
        sendResponse(await armRecorder(tab.id));
      })();
      return true;
    }
    case 'getBrowserCapture': {
      // The panel cannot talk to a content script directly; the service worker is the relay. The
      // capture always targets the tab the panel is attached to, never an arbitrary one, and the
      // nonce it carries is the one that tab's recorder was injected with.
      (async () => {
        const tab = msg.tabId != null ? await new Promise((r) => chrome.tabs.get(msg.tabId, (t) => r(chrome.runtime.lastError ? null : t))) : await activeTab();
        if (!tab) return sendResponse({ unavailable: 'No active tab.' });
        const ctx = contexts.get(tab.id);
        if (ctx && !ctx.isSalesforce) return sendResponse({ unavailable: 'The active tab is not a Salesforce page.' });
        const nonce = recorders.get(tab.id) || null;
        chrome.tabs.sendMessage(tab.id, { type: 'getBrowserCapture', kind: msg.kind, nonce }, (res) => {
          if (chrome.runtime.lastError || !res)
            return sendResponse({ unavailable: 'No SF Claws content script on that tab. Ask the user to reload the Salesforce page.' });
          sendResponse(res);
        });
      })();
      return true;
    }
    case 'awaitingCards': {
      onAwaitingCards(msg, sender).then(() => sendResponse({ ok: true }));
      return true;
    }
    case 'openAdminPage': {
      if (typeof msg.url === 'string' && /^https?:\/\//.test(msg.url))
        chrome.tabs.create({ url: msg.url }, () => sendResponse({ ok: !chrome.runtime.lastError }));
      else sendResponse({ ok: false, error: 'invalid url' });
      return true;
    }
    case 'requestHostPermission': {
      // Note: permission prompts require a user gesture; the side panel calls chrome.permissions
      // directly from its click handler and only falls back to this relay.
      let origin;
      try {
        origin = new URL(msg.url).origin + '/*';
      } catch {
        sendResponse({ granted: false, error: 'invalid url' });
        return false;
      }
      chrome.permissions.contains({ origins: [origin] }, (has) => {
        if (has) return sendResponse({ granted: true });
        chrome.permissions.request({ origins: [origin] }, (granted) => sendResponse({ granted: !!granted, error: chrome.runtime.lastError?.message }));
      });
      return true;
    }
    case 'pendingConfirmations': {
      const next = Math.max(0, Number(msg.count) || 0);
      const changed = next !== pendingCount;
      pendingCount = next;
      if (changed) refreshBadges();
      if (pendingCount === 0) clearNotifications();
      else notifyConfirmation(msg.notify);
      sendResponse({ ok: true });
      return false;
    }
    case 'openSidePanel': {
      const tabId = sender.tab?.id ?? msg.tabId;
      if (tabId != null && chrome.sidePanel?.open)
        chrome.sidePanel.open({ tabId }).then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false }),
        );
      else sendResponse({ ok: false });
      return true;
    }
    default:
      return false;
  }
});
