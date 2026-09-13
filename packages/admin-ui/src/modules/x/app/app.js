import { LightningElement } from 'lwc';
import { Api, getToken, setToken, setUnauthorizedHandler } from '../../../lib/api.js';
import { authStore, toast } from '../../../lib/store.js';
import { routeStore, navigate } from '../../../lib/router.js';
import { canAccess } from '../../../lib/rbac.js';

/** Root component: boots auth, owns routing decisions, renders auth screens or the shell + page. */
export default class App extends LightningElement {
  static renderMode = 'light';
  auth = authStore.get();
  route = routeStore.get();
  returnTo = null;
  _unsubs = [];

  connectedCallback() {
    this._unsubs.push(
      authStore.subscribe((a) => {
        this.auth = a;
      }),
    );
    this._unsubs.push(
      routeStore.subscribe((r) => {
        this.route = r;
        this.onRoute(r);
      }),
    );
    setUnauthorizedHandler(() => {
      if (authStore.get().status === 'authed') {
        setToken(null);
        authStore.set({ ...authStore.get(), status: 'anon', user: null });
        toast.warning('Session expired', 'Please sign in again.');
      }
    });
    this.boot();
  }
  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  async boot() {
    let health = null;
    try {
      health = await Api.health();
    } catch (e) {
      health = { ok: false, error: e };
    }
    const token = getToken();
    if (!token) {
      authStore.set({ status: 'anon', user: null, health, error: null });
      return;
    }
    try {
      const user = await Api.me();
      authStore.set({ status: user?.status === 'pending' ? 'pending' : 'authed', user, health, error: null });
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        if (e.code === 'USER_PENDING') {
          authStore.set({ status: 'pending', user: null, health, error: null });
          return;
        }
        setToken(null);
        authStore.set({ status: 'anon', user: null, health, error: null });
      } else {
        // network error: keep token, show offline state with retry
        authStore.set({ status: 'offline', user: null, health, error: e });
      }
    }
  }

  onRoute(r) {
    if (this.auth.status === 'authed' && (r.name === 'login' || r.name === 'register')) navigate(this.returnTo || '/', { replace: true });
  }

  // ---- derived state -----------------------------------------------------
  get isBooting() {
    return this.auth.status === 'booting';
  }
  get isOffline() {
    return this.auth.status === 'offline';
  }
  get isPending() {
    return this.auth.status === 'pending';
  }
  get isAuthed() {
    return this.auth.status === 'authed' && !!this.auth.user;
  }
  get showLogin() {
    if (this.isAuthed || this.isBooting || this.isOffline) return false;
    return true;
  }
  get loginMode() {
    return this.route.name === 'register' ? 'register' : 'login';
  }
  get user() {
    return this.auth.user;
  }
  get routeName() {
    return this.route.name;
  }
  get params() {
    return this.route.params;
  }
  get query() {
    return this.route.query;
  }
  get allowed() {
    return canAccess(this.user, this.route.name);
  }
  get pageKey() {
    return `${this.route.name}:${JSON.stringify(this.route.params)}`;
  }

  get isDashboard() {
    return this.allowed && this.routeName === 'dashboard';
  }
  get isUsers() {
    return this.allowed && this.routeName === 'users';
  }
  get isAi() {
    return this.allowed && this.routeName === 'ai';
  }
  get isClients() {
    return this.allowed && this.routeName === 'clients';
  }
  get isClient() {
    return this.allowed && this.routeName === 'client';
  }
  get isKnowledge() {
    return this.allowed && this.routeName === 'knowledge';
  }
  get isSkills() {
    return this.allowed && this.routeName === 'skills';
  }
  get isSkill() {
    return this.allowed && this.routeName === 'skill';
  }
  get isSessions() {
    return this.allowed && this.routeName === 'sessions';
  }
  get isSession() {
    return this.allowed && this.routeName === 'session';
  }
  get isUsage() {
    return this.allowed && this.routeName === 'usage';
  }
  get isAudit() {
    return this.allowed && this.routeName === 'audit';
  }
  get isSettings() {
    return this.allowed && this.routeName === 'settings';
  }
  get isPair() {
    return this.allowed && this.routeName === 'pair';
  }
  get isOauthResult() {
    return this.allowed && this.routeName === 'oauthResult';
  }
  get isPolicy() {
    return this.allowed && this.routeName === 'policy';
  }
  get isForbidden() {
    return !this.allowed && this.routeName !== 'notFound' && this.routeName !== 'login' && this.routeName !== 'register';
  }
  get isNotFound() {
    return this.routeName === 'notFound';
  }
  get isAuthRouteWhileAuthed() {
    return this.isAuthed && (this.routeName === 'login' || this.routeName === 'register');
  }
  get healthError() {
    return this.auth.health?.error || this.auth.error;
  }

  // ---- handlers ------------------------------------------------------------
  handleAuthenticated(e) {
    const { user } = e.detail;
    authStore.set({ ...authStore.get(), status: user.status === 'pending' ? 'pending' : 'authed', user, error: null });
    const target = this.returnTo || (this.route.name === 'login' || this.route.name === 'register' ? '/' : this.route.hash);
    this.returnTo = null;
    navigate(target, { replace: true });
  }
  async handleLogout() {
    try {
      await Api.logout();
    } catch {
      /* token may already be invalid */
    }
    setToken(null);
    authStore.set({ ...authStore.get(), status: 'anon', user: null });
    navigate('/login', { replace: true });
    toast.info('Signed out');
  }
  retryBoot() {
    authStore.set({ ...authStore.get(), status: 'booting' });
    this.boot();
  }
  handleUserUpdated(e) {
    authStore.set({ ...authStore.get(), user: e.detail.user });
  }
  /** Password change revoked every token (including ours): drop to the login screen without calling /logout. */
  handleSignedOut() {
    setToken(null);
    authStore.set({ ...authStore.get(), status: 'anon', user: null });
    navigate('/login', { replace: true });
  }

  renderedCallback() {
    // remember where an anonymous user wanted to go (e.g. #/pair?code=...) so we can return after login
    if (this.showLogin && this.route.name !== 'login' && this.route.name !== 'register' && this.route.name !== 'notFound') this.returnTo = this.route.hash;
  }
}
