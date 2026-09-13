/** Chrome runtime bridge with graceful no-op fallbacks when running as a plain web page. */
import { parseSalesforceContext, emptyContext } from './context.js';

export const hasChrome = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

export function sendMessage(msg) {
  if (!hasChrome) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

export function onMessage(fn) {
  if (!hasChrome) return () => {};
  const handler = (msg, sender) => {
    try {
      fn(msg, sender);
    } catch {
      /* ignore */
    }
  };
  chrome.runtime.onMessage.addListener(handler);
  return () => chrome.runtime.onMessage.removeListener(handler);
}

/** Current tab context. In web mode, allow `?sfUrl=` for manual testing. */
export async function getContext() {
  if (hasChrome) {
    const res = await sendMessage({ type: 'getContext' });
    if (res?.context) return res;
  }
  if (typeof location !== 'undefined') {
    const u = new URL(location.href).searchParams.get('sfUrl');
    if (u) return { tabId: null, context: parseSalesforceContext(u, '') };
  }
  return { tabId: null, context: emptyContext() };
}

/**
 * Ask the page recorder on the current tab for its console or network buffer. Outside Chrome (the
 * panel also runs as a plain page for development) there is nothing to record, and saying so is
 * the honest answer.
 */
export async function getBrowserCapture(kind, tabId) {
  if (!hasChrome) return { unavailable: 'Browser capture needs the Chrome extension; this panel is running as a web page.' };
  const res = await sendMessage({ type: 'getBrowserCapture', kind, tabId });
  return res ?? { unavailable: 'The extension did not respond.' };
}

/**
 * Start recording console and network on the tab a session is open on. Nothing is recorded on
 * any tab until this is called for it, and a navigation disarms it until the next call.
 */
export async function armRecorder(tabId) {
  if (!hasChrome) return { armed: false };
  return (await sendMessage({ type: 'armRecorder', tabId })) ?? { armed: false };
}

/** Tell the background how many approval cards await, so it can badge the icon and notify. */
export function reportAwaitingCards(payload) {
  if (!hasChrome) return;
  void sendMessage({ type: 'awaitingCards', ...payload });
}

export async function openTab(url) {
  if (hasChrome) {
    await sendMessage({ type: 'openAdminPage', url });
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/** Ask for host permission for the server origin. Returns true when granted (or not needed). */
export async function ensureHostPermission(serverUrl) {
  if (!hasChrome || !chrome.permissions) return true;
  let origin;
  try {
    origin = new URL(serverUrl).origin + '/*';
  } catch {
    return false;
  }
  const has = await new Promise((r) => chrome.permissions.contains({ origins: [origin] }, (ok) => r(!!ok)));
  if (has) return true;
  return new Promise((r) => {
    try {
      chrome.permissions.request({ origins: [origin] }, (ok) => {
        void chrome.runtime.lastError;
        r(!!ok);
      });
    } catch {
      r(false);
    }
  });
}

export async function hasHostPermission(serverUrl) {
  if (!hasChrome || !chrome.permissions) return true;
  try {
    const origin = new URL(serverUrl).origin + '/*';
    return await new Promise((r) => chrome.permissions.contains({ origins: [origin] }, (ok) => r(!!ok)));
  } catch {
    return false;
  }
}

export function openOptions() {
  if (hasChrome && chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open('./options.html', '_blank');
}
