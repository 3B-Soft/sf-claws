import { LightningElement, api } from 'lwc';
import { Api } from '../../../lib/api.js';
/** Landing page after the Salesforce OAuth callback: #/oauth-result?ok=1|0&orgId=&message= */
export default class OauthResultPage extends LightningElement {
  static renderMode = 'light';
  @api query = {};
  org = null;
  _fetched = null;
  renderedCallback() {
    const id = this.query?.orgId;
    if (id && this._fetched !== id) {
      this._fetched = id;
      this.loadOrg(id);
    }
  }
  async loadOrg(id) {
    try {
      this.org = await Api.getOrg(id);
    } catch {
      this.org = null;
    }
  }
  get ok() {
    return String(this.query?.ok) === '1' || this.query?.ok === 'true';
  }
  get message() {
    return this.query?.message || '';
  }
  get orgLabel() {
    return this.org?.label || this.query?.orgId || 'the org';
  }
  get clientHref() {
    return this.org?.clientId ? `#/clients/${this.org.clientId}?tab=orgs` : '';
  }
  get isPopup() {
    return !!window.opener;
  }
  closeWindow() {
    window.close();
  }
}
