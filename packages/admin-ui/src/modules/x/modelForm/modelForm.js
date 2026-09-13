import { LightningElement, api } from 'lwc';
import { MODEL_PRESETS, AI_PROVIDERS, PROVIDER_META } from '../../../lib/constants.js';

/** Create/edit AiModel form (used inside a modal). `model` = existing model or null. Emits 'submit' {body}, 'cancel'. */
/** '' / null / undefined all mean "unset" for an optional numeric field. */
const optionalNumber = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

export default class ModelForm extends LightningElement {
  static renderMode = 'light';
  @api model;
  @api busy = false;
  form = null;
  _initKey = null;

  renderedCallback() {
    const key = this.model?.id || 'new';
    if (this._initKey !== key) {
      this._initKey = key;
      this.form = this.model
        ? { ...this.model }
        : {
            provider: 'anthropic',
            modelId: '',
            label: '',
            enabled: true,
            inputCostPerM: 0,
            outputCostPerM: 0,
            cachedInputCostPerM: null,
            maxOutputTokens: 16000,
            contextWindow: 200000,
            supportsThinking: false,
          };
    }
  }
  get f() {
    return this.form || {};
  }
  get isEdit() {
    return !!this.model;
  }
  get providerOptions() {
    return AI_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_META[p]?.label ?? p }));
  }
  get presets() {
    return MODEL_PRESETS.filter((p) => p.provider === this.f.provider).map((p) => ({
      ...p,
      id: p.modelId,
      cls: 'btn-secondary btn-xs',
      title: p.placeholderPrices ? 'Prices are placeholders — verify' : '',
    }));
  }
  get showPresets() {
    return !this.isEdit;
  }
  get placeholderNote() {
    return this.f.provider === 'anthropic'
      ? ''
      : `${PROVIDER_META[this.f.provider]?.label ?? this.f.provider} prices are editable placeholders — verify against the provider price list.`;
  }
  get cannotSubmit() {
    return this.busy || !this.f.modelId || !this.f.label;
  }
  get cached() {
    return this.f.cachedInputCostPerM ?? '';
  }
  get temperature() {
    return this.f.temperature ?? '';
  }
  get topP() {
    return this.f.topP ?? '';
  }
  /** A thinking model sets its own sampling: Anthropic refuses these alongside extended thinking and the OpenAI reasoning models only accept the default. */
  get dialsDisabled() {
    return !!this.f.supportsThinking;
  }
  get samplingHint() {
    return this.dialsDisabled
      ? 'Not available on a thinking model — the provider rejects these alongside extended reasoning. Control effort per agent role instead.'
      : 'Leave blank to use the provider default, which is what most deployments want.';
  }

  applyPreset(e) {
    const p = MODEL_PRESETS.find((x) => x.modelId === e.currentTarget.dataset.id);
    if (p) {
      const { placeholderPrices, ...rest } = p;
      this.form = { ...this.form, ...rest, enabled: true };
    }
  }
  handle(e) {
    this.form = { ...this.form, [e.detail.name]: e.detail.value };
  }
  submit() {
    const f = this.form;
    const body = {
      provider: f.provider,
      modelId: String(f.modelId).trim(),
      label: String(f.label).trim(),
      enabled: !!f.enabled,
      inputCostPerM: Number(f.inputCostPerM) || 0,
      outputCostPerM: Number(f.outputCostPerM) || 0,
      cachedInputCostPerM:
        f.cachedInputCostPerM === '' || f.cachedInputCostPerM === null || f.cachedInputCostPerM === undefined ? null : Number(f.cachedInputCostPerM),
      maxOutputTokens: Number(f.maxOutputTokens) || 16000,
      contextWindow: Number(f.contextWindow) || 200000,
      supportsThinking: !!f.supportsThinking,
      // Blank means "say nothing to the provider", and a thinking model never carries a dial at all.
      temperature: f.supportsThinking ? null : optionalNumber(f.temperature),
      topP: f.supportsThinking ? null : optionalNumber(f.topP),
    };
    this.dispatchEvent(new CustomEvent('submit', { detail: { body } }));
  }
  cancel() {
    this.dispatchEvent(new CustomEvent('cancel'));
  }
}
