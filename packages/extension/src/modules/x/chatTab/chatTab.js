import { LightningElement } from 'lwc';
import { appStore, selectSession } from '../../../lib/state.js';
import { sessionStore, createSession } from '../../../lib/sessionController.js';

export default class ChatTab extends LightningElement {
  static renderMode = 'light';
  state = appStore.get();
  session = sessionStore.get();
  showList = false;
  creating = false;
  error = '';
  _unsubs = [];
  connectedCallback() {
    this._unsubs.push(
      appStore.subscribe((s) => {
        this.state = s;
      }),
    );
    this._unsubs.push(
      sessionStore.subscribe((s) => {
        this.session = s;
      }),
    );
  }
  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  get hasSession() {
    return !!this.state.sessionId && !this.showList;
  }
  get listVisible() {
    return !this.hasSession;
  }
  get hasBack() {
    return !!this.state.sessionId && this.showList;
  }
  get creatingLabel() {
    return this.creating ? 'Creating…' : 'New session';
  }

  onShowList() {
    this.showList = true;
  }
  onBack() {
    this.showList = false;
  }
  async onSelect(e) {
    await selectSession(e.detail.id);
    this.showList = false;
  }
  async onNew() {
    this.creating = true;
    this.error = '';
    try {
      const s = await createSession();
      await selectSession(s.id);
      this.showList = false;
    } catch (e) {
      this.error = e.message;
    } finally {
      this.creating = false;
    }
  }
}
