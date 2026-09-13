import { LightningElement, api } from 'lwc';
import { Api, setToken, getToken } from '../../../lib/api.js';
import { navigate } from '../../../lib/router.js';
import { toast } from '../../../lib/store.js';

/** Login / register / awaiting-approval screen. Emits 'authenticated' { user }. */
export default class LoginPage extends LightningElement {
  static renderMode = 'light';
  @api mode = 'login'; // login | register
  @api health;
  @api pending = false; // token exists but user is pending approval

  email = '';
  password = '';
  displayName = '';
  busy = false;
  error = null;
  pendingLocal = false;
  registeredEmail = '';

  get isRegister() {
    return this.mode === 'register';
  }
  get isPending() {
    return this.pending || this.pendingLocal;
  }
  get setupRequired() {
    return !!this.health?.setupRequired;
  }
  get serverDown() {
    return this.health && this.health.ok === false;
  }
  get serverVersion() {
    return this.health?.version ? `v${this.health.version}` : '';
  }
  get title() {
    return this.isRegister ? 'Create your account' : 'Sign in';
  }
  get subtitle() {
    return this.isRegister
      ? this.setupRequired
        ? 'You are the first user — you will become the super admin.'
        : 'New accounts wait for approval by an administrator.'
      : 'Welcome back to the SF Claws console.';
  }
  get submitLabel() {
    return this.busy ? 'Please wait…' : this.isRegister ? 'Create account' : 'Sign in';
  }
  get switchHref() {
    return this.isRegister ? '#/login' : '#/register';
  }
  get switchLabel() {
    return this.isRegister ? 'Already have an account? Sign in' : 'Need an account? Register';
  }
  get errorMessage() {
    return this.error?.message || '';
  }
  get canSubmit() {
    return !this.busy && this.email && this.password && (!this.isRegister || this.displayName);
  }
  get passwordHint() {
    return this.isRegister ? 'At least 10 characters.' : '';
  }

  handleField(e) {
    this[e.detail.name] = e.detail.value;
    this.error = null;
  }

  async submit(e) {
    e.preventDefault();
    if (!this.canSubmit) return;
    this.busy = true;
    this.error = null;
    try {
      if (this.isRegister) {
        const res = await Api.register({ email: this.email.trim(), password: this.password, displayName: this.displayName.trim() });
        // Server may return AuthResponse (first user / auto-approve) or a bare User (pending).
        const user = res?.user || res;
        if (res?.token && user?.status !== 'pending') {
          setToken(res.token);
          toast.success('Welcome!', 'Your account was created.');
          this.dispatchEvent(new CustomEvent('authenticated', { detail: { user } }));
          return;
        }
        if (res?.token) setToken(res.token);
        this.registeredEmail = this.email;
        this.pendingLocal = true;
        return;
      }
      const res = await Api.login({ email: this.email.trim(), password: this.password });
      if (res?.user?.status === 'pending') {
        if (res.token) setToken(res.token);
        this.registeredEmail = this.email;
        this.pendingLocal = true;
        return;
      }
      setToken(res.token);
      this.dispatchEvent(new CustomEvent('authenticated', { detail: { user: res.user } }));
    } catch (err) {
      if (err.status === 403 && err.code === 'USER_PENDING') {
        this.registeredEmail = this.email;
        this.pendingLocal = true;
        return;
      }
      if (err.status === 403 && err.code === 'USER_DISABLED') {
        this.error = new Error('This account has been disabled. Contact your administrator.');
        return;
      }
      this.error = err;
    } finally {
      this.busy = false;
    }
  }

  async checkAgain() {
    if (!getToken()) {
      this.pendingLocal = false;
      return;
    }
    this.busy = true;
    try {
      const user = await Api.me();
      if (user?.status === 'active') {
        this.dispatchEvent(new CustomEvent('authenticated', { detail: { user } }));
        return;
      }
      toast.info('Still pending', 'Your account has not been approved yet.');
    } catch (err) {
      if (err.status === 401) {
        setToken(null);
        this.pendingLocal = false;
      } else toast.error('Could not check status', err.message);
    } finally {
      this.busy = false;
    }
  }
  backToLogin() {
    setToken(null);
    this.pendingLocal = false;
    this.password = '';
    navigate('/login', { replace: true });
  }
  get hasToken() {
    return !!getToken();
  }
}
