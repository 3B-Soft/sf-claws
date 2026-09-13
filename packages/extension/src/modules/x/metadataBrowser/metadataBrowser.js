import { LightningElement } from 'lwc';
import { appStore, api as http } from '../../../lib/state.js';
import { asList } from '../../../lib/api.js';
import { VISUAL_METADATA_TYPES as VisualMetadataTypes } from '../../../lib/metadataParse.js';

const cache = { orgId: null, types: null, lists: new Map() };
const PREFERRED = ['Flow', 'CustomObject', 'Layout', 'FlexiPage', 'ValidationRule', 'PermissionSet', 'ApexClass', 'ApexTrigger', 'CustomTab', 'QuickAction'];

export default class MetadataBrowser extends LightningElement {
  static renderMode = 'light';
  state = appStore.get();
  types = [];
  type = '';
  items = [];
  itemFilter = '';
  fullName = '';
  xml = '';
  files = []; // [{path, content, json}] from metadata/read
  filePath = ''; // selected file (pro mode / bundles)
  loadingTypes = false;
  loadingItems = false;
  loadingItem = false;
  error = '';
  _unsub = null;
  _n = 0;

  connectedCallback() {
    this._unsub = appStore.subscribe((s) => {
      const changed = this.state.org?.id !== s.org?.id;
      this.state = s;
      if (changed) this.reset();
    });
    this.loadTypes();
  }
  disconnectedCallback() {
    this._unsub?.();
  }
  reset() {
    this.types = [];
    this.type = '';
    this.items = [];
    this.fullName = '';
    this.xml = '';
    this.files = [];
    this.filePath = '';
    this.loadTypes();
  }

  get orgId() {
    return this.state.org?.id;
  }
  get isPro() {
    return this.state.uiMode === 'pro';
  }

  async loadTypes() {
    if (!this.orgId) return;
    if (cache.orgId === this.orgId && cache.types) {
      this.types = cache.types;
      this.autoPick();
      return;
    }
    this.loadingTypes = true;
    this.error = '';
    try {
      const res = await http.metadataTypes(this.orgId);
      const names = asList(res, 'metadataObjects')
        .map((t) => (typeof t === 'string' ? t : t.xmlName || t.name || t.type))
        .filter(Boolean);
      const uniq = [...new Set(names)];
      uniq.sort((a, b) => {
        const pa = PREFERRED.indexOf(a),
          pb = PREFERRED.indexOf(b);
        if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
        return a.localeCompare(b);
      });
      cache.orgId = this.orgId;
      cache.types = uniq;
      cache.lists.clear();
      this.types = uniq;
      this.autoPick();
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loadingTypes = false;
    }
  }
  autoPick() {
    if (this.type) return;
    const k = this.state.context?.kind;
    const want = k === 'flow' ? 'Flow' : k === 'flexipage' ? 'FlexiPage' : this.state.context?.objectApiName ? 'CustomObject' : '';
    if (want && this.types.includes(want)) this.pickType(want, this.state.context?.objectApiName);
  }
  async pickType(type, preselect) {
    this.type = type;
    this.items = [];
    this.fullName = '';
    this.xml = '';
    this.itemFilter = '';
    if (!type) return;
    const n = ++this._n;
    this.loadingItems = true;
    this.error = '';
    try {
      let list = cache.lists.get(type);
      if (!list) {
        const res = await http.metadataList(this.orgId, type);
        list = asList(res)
          .map((m) => (typeof m === 'string' ? { fullName: m } : m))
          .map((m) => ({
            fullName: m.fullName,
            lastModifiedDate: m.lastModifiedDate || '',
            lastModifiedByName: m.lastModifiedByName || '',
            namespacePrefix: m.namespacePrefix || '',
          }))
          .sort((a, b) => a.fullName.localeCompare(b.fullName));
        cache.lists.set(type, list);
      }
      if (n !== this._n) return;
      this.items = list;
      if (preselect && list.some((i) => i.fullName === preselect)) this.pickItem(preselect);
    } catch (e) {
      if (n === this._n) this.error = e.message;
    } finally {
      if (n === this._n) this.loadingItems = false;
    }
  }
  async pickItem(fullName) {
    this.fullName = fullName;
    this.xml = '';
    this.files = [];
    this.filePath = '';
    const n = ++this._n;
    this.loadingItem = true;
    this.error = '';
    try {
      const res = await http.metadataRead(this.orgId, this.type, fullName);
      if (n !== this._n) return;
      // Contract: { files: [{ path, content, json }] }. Tolerate older shapes ({xml}|{source}|string).
      let files = Array.isArray(res?.files) ? res.files : [];
      if (!files.length) {
        const single = typeof res === 'string' ? res : res?.xml || res?.source || res?.content || '';
        if (single) files = [{ path: `${fullName}.${this.type}-meta.xml`, content: single, json: null }];
        else if (res && typeof res === 'object') files = [{ path: `${fullName}.json`, content: JSON.stringify(res, null, 2), json: res }];
      }
      this.files = files.map((f) => ({ path: f.path || '', content: f.content ?? '', json: f.json ?? null }));
      // Prefer the metadata XML (…-meta.xml or any .xml) for the visual renderer.
      const main = this.files.find((f) => /-meta\.xml$/.test(f.path)) || this.files.find((f) => /\.xml$/.test(f.path)) || this.files[0];
      this.filePath = main?.path || '';
      this.xml = main?.content || '';
    } catch (e) {
      if (n === this._n) this.error = e.message;
    } finally {
      if (n === this._n) this.loadingItem = false;
    }
  }

  get typeOptions() {
    return this.types.map((t) => ({ value: t, label: t, selected: t === this.type, visual: VisualMetadataTypes.includes(t) }));
  }
  get hasTypes() {
    return this.types.length > 0;
  }
  get filteredItems() {
    const q = this.itemFilter.trim().toLowerCase();
    return (q ? this.items.filter((i) => i.fullName.toLowerCase().includes(q)) : this.items).slice(0, 500).map((i) => ({
      ...i,
      selected: i.fullName === this.fullName,
      cls: `flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] ${i.fullName === this.fullName ? 'bg-brand-50 font-medium text-brand-700' : 'text-content hover:bg-surface-sunken'}`,
    }));
  }
  get itemCount() {
    return this.items.length;
  }
  get hasItems() {
    return this.items.length > 0;
  }
  get showList() {
    return !!this.type && !this.fullName;
  }
  get showItem() {
    return !!this.fullName;
  }
  get typeIsVisual() {
    return VisualMetadataTypes.includes(this.type);
  }
  get itemTitle() {
    return this.fullName;
  }
  get noTypeHint() {
    return !this.type && !this.loadingTypes;
  }
  get hasXml() {
    return !!this.xml;
  }
  get selectedFile() {
    return this.files.find((f) => f.path === this.filePath) || null;
  }
  get selectedContent() {
    return this.selectedFile?.content || '';
  }
  get selectedIsXml() {
    return /\.xml$/i.test(this.filePath);
  }
  get fileTabs() {
    return this.files.map((f) => ({
      path: f.path,
      name: f.path.split('/').pop(),
      cls: `rounded-md px-2 py-0.5 font-mono text-[10px] ${f.path === this.filePath ? 'bg-brand-50 text-brand-700' : 'text-content-muted hover:bg-surface-sunken hover:text-content'}`,
    }));
  }
  get hasMultipleFiles() {
    return this.files.length > 1;
  }
  get mainXml() {
    const main = this.files.find((f) => /-meta\.xml$/.test(f.path)) || this.files.find((f) => /\.xml$/.test(f.path));
    return main?.content || '';
  }
  get hasVisual() {
    return !!this.mainXml;
  }
  get codeFile() {
    return this.files.find((f) => /\.(cls|trigger|js|html|css|page|component)$/i.test(f.path));
  }
  get hasCode() {
    return !!this.codeFile;
  }
  get codeContent() {
    return this.codeFile?.content || '';
  }
  get codeName() {
    return this.codeFile?.path.split('/').pop() || '';
  }
  get fileCount() {
    return `${this.files.length} file(s)`;
  }

  onType(e) {
    this.pickType(e.target.value);
  }
  onItemFilter(e) {
    this.itemFilter = e.target.value;
  }
  onPickItem(e) {
    this.pickItem(e.currentTarget.dataset.name);
  }
  onBack() {
    this.fullName = '';
    this.xml = '';
    this.files = [];
    this.filePath = '';
  }
  onPickFile(e) {
    this.filePath = e.currentTarget.dataset.path;
  }
  onReload() {
    cache.types = null;
    cache.lists.clear();
    this.reset();
  }
}
