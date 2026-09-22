import { LightningElement } from 'lwc';
import { Api, asList } from '../../../lib/api.js';
import { toast } from '../../../lib/store.js';
import { navigate } from '../../../lib/router.js';
import { fmtRelative } from '../../../lib/format.js';

export default class ClientsPage extends LightningElement {
  static renderMode = 'light';
  clients = [];
  loading = true;
  error = null;
  search = '';
  modalOpen = false;
  form = { name: '', slug: '', description: '', useBrowserSession: false };
  slugTouched = false;
  busy = false;

  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      this.clients = asList(await Api.listClients(), 'clients');
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  get rows() {
    const q = this.search.trim().toLowerCase();
    return this.clients
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.slug.includes(q))
      .map((c) => ({ ...c, href: `#/clients/${c.id}`, when: fmtRelative(c.createdAt), initials: c.name.slice(0, 2).toUpperCase() }));
  }
  get hasRows() {
    return this.rows.length > 0;
  }
  get isEmpty() {
    return !this.loading && !this.error && this.clients.length === 0;
  }
  get slugError() {
    return this.form.slug && !/^[a-z0-9-]+$/.test(this.form.slug) ? 'Lowercase letters, digits and dashes only.' : '';
  }
  get cannotCreate() {
    return this.busy || !this.form.name.trim() || !this.form.slug || !!this.slugError;
  }
  get browserSessionMode() {
    return !!this.form.useBrowserSession;
  }

  handleSearch(e) {
    this.search = e.detail.value;
  }
  openCreate() {
    this.modalOpen = true;
    this.form = { name: '', slug: '', description: '', useBrowserSession: false };
    this.slugTouched = false;
  }
  closeCreate() {
    this.modalOpen = false;
  }
  handleField(e) {
    const { name, value } = e.detail;
    const next = { ...this.form, [name]: value };
    if (name === 'slug') this.slugTouched = true;
    if (name === 'name' && !this.slugTouched) next.slug = slugify(value);
    this.form = next;
  }
  async create() {
    this.busy = true;
    try {
      const body = {
        name: this.form.name.trim(),
        slug: this.form.slug,
        salesforceAuthMode: this.form.useBrowserSession ? 'browser_session' : 'external_app',
      };
      if (this.form.description.trim()) body.description = this.form.description.trim();
      const created = await Api.createClient(body);
      toast.success('Client created');
      this.modalOpen = false;
      if (created?.id) navigate(`/clients/${created.id}`);
      else this.load();
    } catch (err) {
      toast.error('Could not create client', err.message);
    } finally {
      this.busy = false;
    }
  }
  open(e) {
    navigate(`/clients/${e.currentTarget.dataset.id}`);
  }
}
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
