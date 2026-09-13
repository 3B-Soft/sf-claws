import { LightningElement, api } from 'lwc';
import { AGENT_INSTRUCTIONS_MAX_CHARS } from '@sf-claws/shared';
import { Api } from '../../../lib/api.js';
import { toast } from '../../../lib/store.js';

/**
 * Standing agent instructions for a client and for each of its orgs — the equivalent of a CLAUDE.md
 * checked into a repository. Every agent on every session reads them, which is what separates them
 * from skills: a skill is role-filtered and expanded from a menu, this is always in the prompt.
 *
 * Client and org are edited on one page because the useful mental model is one document with a
 * general half and a per-org half, not two unrelated settings on two screens.
 */
export default class InstructionsTab extends LightningElement {
  static renderMode = 'light';
  @api clientId;
  loading = true;
  error = null;
  client = null;
  orgs = [];
  /** Edited text keyed by 'client' and by org id. */
  drafts = {};
  savingKey = null;

  connectedCallback() {
    this.load();
  }
  async load() {
    this.loading = true;
    this.error = null;
    try {
      const [client, orgs] = await Promise.all([Api.getClient(this.clientId), Api.listOrgs(this.clientId)]);
      this.client = client;
      this.orgs = orgs || [];
      this.drafts = { client: client.instructions || '', ...Object.fromEntries(this.orgs.map((o) => [o.id, o.instructions || ''])) };
    } catch (e) {
      this.error = e;
    } finally {
      this.loading = false;
    }
  }

  get max() {
    return AGENT_INSTRUCTIONS_MAX_CHARS;
  }
  get clientCard() {
    return this.cardFor('client', this.client?.name || 'this client', this.client?.instructions);
  }
  get orgCards() {
    return this.orgs.map((o) => this.cardFor(o.id, `${o.label} (${o.kind})`, o.instructions));
  }
  cardFor(key, label, saved) {
    const value = this.drafts[key] ?? '';
    const over = value.length > this.max;
    return {
      key,
      label,
      value,
      // The count is the point of the counter: an admin pasting a wiki page should see it fail here.
      count: `${value.length.toLocaleString()} / ${this.max.toLocaleString()} characters`,
      countCls: over ? 'text-xs text-rose-700' : 'text-xs text-content-subtle',
      error: over ? `Too long by ${(value.length - this.max).toLocaleString()} characters.` : '',
      dirty: value !== (saved || ''),
      cannotSave: over || value === (saved || '') || this.savingKey !== null,
      saveLabel: this.savingKey === key ? 'Saving…' : 'Save',
      empty: !saved,
    };
  }

  handleChange(e) {
    this.drafts = { ...this.drafts, [e.currentTarget.dataset.key]: e.detail.value };
  }
  async save(e) {
    const key = e.currentTarget.dataset.key;
    const instructions = (this.drafts[key] || '').trim() || null;
    this.savingKey = key;
    try {
      if (key === 'client') this.client = { ...this.client, ...(await Api.updateClient(this.clientId, { instructions })) };
      else {
        const updated = await Api.updateOrg(key, { instructions });
        this.orgs = this.orgs.map((o) => (o.id === key ? { ...o, ...updated } : o));
      }
      toast.success('Instructions saved', 'New sessions will read them; sessions already running keep the prompt they started with.');
    } catch (err) {
      toast.error('Could not save instructions', err.message);
    } finally {
      this.savingKey = null;
    }
  }
  revert(e) {
    const key = e.currentTarget.dataset.key;
    const saved = key === 'client' ? this.client?.instructions : this.orgs.find((o) => o.id === key)?.instructions;
    this.drafts = { ...this.drafts, [key]: saved || '' };
  }
}
