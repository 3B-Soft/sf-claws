import { LightningElement, api } from 'lwc';
/**
 * Labelled form control. type: text|password|email|number|url|textarea|select|checkbox|toggle.
 * options: [{ value, label }] for select. Emits 'change' { name, value }.
 */
export default class FormField extends LightningElement {
  static renderMode = 'light';
  @api label = '';
  @api name = '';
  @api type = 'text';
  @api value = '';
  @api placeholder = '';
  @api hint = '';
  @api options = [];
  @api required = false;
  @api disabled = false;
  @api readonly = false;
  @api rows = 4;
  @api mono = false;
  @api min;
  @api max;
  @api step;
  @api error = '';
  @api compact = false;

  get isSelect() {
    return this.type === 'select';
  }
  get isTextarea() {
    return this.type === 'textarea';
  }
  get isCheckbox() {
    return this.type === 'checkbox';
  }
  get isToggle() {
    return this.type === 'toggle';
  }
  get isInput() {
    return !this.isSelect && !this.isTextarea && !this.isCheckbox && !this.isToggle;
  }
  get checked() {
    return this.value === true || this.value === 'true';
  }
  get inputCls() {
    return `input ${this.mono ? 'font-mono text-[13px]' : ''} ${this.error ? 'border-rose-500/60' : ''}`;
  }
  get textareaCls() {
    return `textarea ${this.mono ? '' : 'font-sans text-sm'} ${this.error ? 'border-rose-500/60' : ''}`;
  }
  get wrapCls() {
    return this.compact ? '' : 'mb-4';
  }
  get selectOptions() {
    return (this.options || [])
      .map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
      .map((o) => ({ ...o, selected: String(o.value) === String(this.value ?? '') }));
  }
  get toggleCls() {
    return `relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${this.checked ? 'bg-brand-500' : 'bg-line-strong'} ${this.disabled ? 'opacity-50' : ''}`;
  }
  get knobCls() {
    return `inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${this.checked ? 'translate-x-6' : 'translate-x-1'}`;
  }
  get inputId() {
    return `f-${this.name || Math.random().toString(36).slice(2)}`;
  }
  get displayValue() {
    return this.value ?? '';
  }
  /* `value` is not a valid attribute on <textarea> in LWC templates; sync it as a property instead. */
  renderedCallback() {
    if (!this.isTextarea) return;
    const ta = this.querySelector('[data-field-textarea]');
    if (ta && ta.value !== String(this.displayValue)) ta.value = String(this.displayValue);
  }

  emit(value) {
    this.value = value;
    this.dispatchEvent(new CustomEvent('change', { detail: { name: this.name, value } }));
  }
  /** Native input/change events from the inner control must not reach the host's onchange (light DOM bubbles). */
  swallow(e) {
    e.stopPropagation();
  }
  handleInput(e) {
    e.stopPropagation();
    const t = e.target;
    if (this.type === 'number') {
      const v = t.value === '' ? '' : Number(t.value);
      this.emit(v);
      return;
    }
    this.emit(t.value);
  }
  handleCheck(e) {
    e.stopPropagation();
    this.emit(!!e.target.checked);
  }
  toggle() {
    if (!this.disabled) this.emit(!this.checked);
  }
}
