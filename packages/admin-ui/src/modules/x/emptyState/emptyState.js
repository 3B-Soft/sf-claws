import { LightningElement, api } from 'lwc';
export default class EmptyState extends LightningElement {
  static renderMode = 'light';
  @api icon = 'inbox';
  @api title = 'Nothing here yet';
  @api description = '';
  @api actionLabel;
  handleAction() {
    this.dispatchEvent(new CustomEvent('action'));
  }
}
