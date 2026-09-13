import { LightningElement, api } from 'lwc';
export default class PageHeader extends LightningElement {
  static renderMode = 'light';
  @api title = '';
  @api subtitle = '';
  @api backHref;
  @api backLabel = 'Back';
}
