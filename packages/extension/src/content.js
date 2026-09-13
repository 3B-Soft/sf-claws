/**
 * Content script on Salesforce hosts: parses location into a page context and reports it to
 * the background service worker on load and on SPA navigation (history wrapping + polling), and
 * relays browser-capture requests to the page recorder when the background has installed one.
 * Bundled as a classic IIFE (see scripts/postbuild.mjs) — no ES imports at runtime.
 *
 * Runs only on the hosts an admin actually works in (Lightning, MyDomain, Setup and Visualforce
 * domains — see manifest.json), not on public Experience Cloud sites.
 */
import { parseSalesforceContext } from './lib/context.js';

(function main() {
  if (window.top !== window && !/builder_platform_interaction|visualEditor/.test(location.pathname)) return; // ignore most iframes
  let lastHref = '';
  let lastTitle = '';
  let timer = null;

  function send() {
    if (!chrome?.runtime?.id) return;
    const ctx = parseSalesforceContext(location.href, document.title);
    lastHref = location.href;
    lastTitle = document.title;
    try {
      chrome.runtime.sendMessage({ type: 'pageContext', context: ctx }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* extension reloaded */
    }
  }

  function scheduleSend() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(send, 150);
  }

  // Lightning is a SPA: wrap history and listen for popstate/hashchange.
  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method];
    if (typeof orig !== 'function') continue;
    history[method] = function (...args) {
      const r = orig.apply(this, args);
      scheduleSend();
      return r;
    };
  }
  window.addEventListener('popstate', scheduleSend, true);
  window.addEventListener('hashchange', scheduleSend, true);

  // Fallback poll (title changes lag the URL in Lightning).
  setInterval(() => {
    if (location.href !== lastHref || document.title !== lastTitle) send();
  }, 2000);

  // Respond to direct requests from the extension (e.g. the panel wants a fresh context).
  chrome.runtime?.onMessage?.addListener?.((msg, _sender, sendResponse) => {
    if (msg?.type === 'getPageContext') {
      sendResponse({ context: parseSalesforceContext(location.href, document.title) });
      return false;
    }
    if (msg?.type === 'getBrowserCapture') {
      askRecorder(msg.kind, msg.nonce).then(sendResponse);
      return true; // async
    }
    return false;
  });

  /**
   * Fetch the page recorder's buffer. The recorder runs in the page's own world, so the only
   * channel between us is postMessage — this is the isolated-world half of that exchange. The
   * nonce comes from the background, which minted it when it injected the recorder; without the
   * right nonce the recorder stays silent.
   *
   * A timeout is not a fallback here, it is the answer: the recorder is missing whenever no
   * session armed it on this tab, or the page loaded before the extension was updated, and
   * telling the agent "no recording" beats leaving its turn hanging.
   */
  function askRecorder(kind, nonce) {
    return new Promise((resolve) => {
      if (!nonce) {
        resolve({ unavailable: 'No page recorder on this tab: recording starts when a session is open on it. Reproduce the problem again.' });
        return;
      }
      const requestId = `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({ unavailable: 'No page recorder on this tab. Ask the user to reload the Salesforce page, then reproduce the problem.' });
      }, 2000);
      function onMessage(e) {
        if (e.source !== window || e.origin !== window.location.origin) return;
        const d = e.data;
        if (d?.channel !== 'sf-claws-recorder' || d.direction !== 'response' || d.nonce !== nonce || d.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve({ console: d.console, network: d.network, dropped: d.dropped || 0 });
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ channel: 'sf-claws-recorder', direction: 'request', nonce, requestId, kind }, window.location.origin);
    });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') send();
  else document.addEventListener('DOMContentLoaded', send, { once: true });
  window.addEventListener('load', scheduleSend, { once: true });
})();
