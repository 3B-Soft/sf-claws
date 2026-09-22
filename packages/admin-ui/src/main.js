import './styles.css';
import { createElement } from 'lwc';
import App from 'x/app';

// `/pair?code=XXXX` (path form used by the Chrome extension) -> hash route.
if (window.location.pathname.replace(/\/+$/, '') === '/pair' && !window.location.hash) {
  const search = window.location.search || '';
  window.history.replaceState(null, '', `/#/pair${search}`);
  // The router parsed the (empty) hash at import time; tell it about the rewrite.
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

const root = document.getElementById('app');
root.appendChild(createElement('x-app', { is: App }));
