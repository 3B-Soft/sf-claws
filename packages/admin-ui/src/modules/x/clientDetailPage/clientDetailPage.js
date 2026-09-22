import { LightningElement, api } from 'lwc';
import { Api } from '../../../lib/api.js';
import { toast, confirm } from '../../../lib/store.js';
import { navigate, setQuery } from '../../../lib/router.js';

export default class ClientDetailPage extends LightningElement {
  static renderMode = 'light';
  @api clientId;
  @api query = {};
  client = null;
  loading = true;
  error = null;
  editOpen = false;
  form = {};
  busy = false;
  _loadedId = null;

  connectedCallback() {
    this.load();
  }
  renderedCallback() {
    if (this._loadedId !== this.clientId) this.load();
  }
  async load() {
    this._loadedId = this.clientId;
    this.loading = true;
    this.error = null;
    try {
      this.client = await Api.getClient(this.clientId);
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }
  get tab() {
    return this.query?.tab || 'orgs';
  }
  get tabs() {
    return [
      { id: 'orgs', label: 'Salesforce orgs' },
      { id: 'members', label: 'Members' },
      { id: 'github', label: 'GitHub' },
      { id: 'skills', label: 'Skills' },
      { id: 'instructions', label: 'Instructions' },
      { id: 'policy', label: 'Policy' },
      { id: 'projects', label: 'Projects & tasks' },
    ];
  }
  get isOrgs() {
    return this.tab === 'orgs';
  }
  get isMembers() {
    return this.tab === 'members';
  }
  get isGithub() {
    return this.tab === 'github';
  }
  get isSkills() {
    return this.tab === 'skills';
  }
  get isInstructions() {
    return this.tab === 'instructions';
  }
  get isPolicy() {
    return this.tab === 'policy';
  }
  get isProjects() {
    return this.tab === 'projects';
  }
  get title() {
    return this.client?.name || 'Client';
  }
  get subtitle() {
    return this.client ? `${this.client.slug}${this.client.description ? ' · ' + this.client.description : ''}` : '';
  }
  get sessionsHref() {
    return `#/sessions?clientId=${this.clientId}`;
  }
  get browserSessionMode() {
    return !!this.form.useBrowserSession;
  }
  selectTab(e) {
    setQuery({ tab: e.detail.id });
  }

  openEdit() {
    this.form = {
      name: this.client.name,
      description: this.client.description || '',
      useBrowserSession: this.client.salesforceAuthMode === 'browser_session',
    };
    this.editOpen = true;
  }
  closeEdit() {
    this.editOpen = false;
  }
  handleField(e) {
    this.form = { ...this.form, [e.detail.name]: e.detail.value };
  }
  async saveEdit() {
    this.busy = true;
    try {
      this.client = {
        ...this.client,
        ...(await Api.updateClient(this.clientId, {
          name: this.form.name,
          description: this.form.description,
          salesforceAuthMode: this.form.useBrowserSession ? 'browser_session' : 'external_app',
        })),
      };
      toast.success('Client updated');
      this.editOpen = false;
    } catch (err) {
      toast.error('Could not update client', err.message);
    } finally {
      this.busy = false;
    }
  }
  async remove() {
    if (
      !(await confirm({
        title: `Delete ${this.client.name}?`,
        message: 'Orgs, GitHub settings, skills and policies for this client will be removed. Sessions history is kept.',
        confirmLabel: 'Delete client',
        danger: true,
      }))
    )
      return;
    try {
      await Api.deleteClient(this.clientId);
      toast.success('Client deleted');
      navigate('/clients');
    } catch (err) {
      toast.error('Could not delete client', err.message);
    }
  }
}
