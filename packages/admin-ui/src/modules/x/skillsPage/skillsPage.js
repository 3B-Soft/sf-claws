import { LightningElement, api } from 'lwc';
import { navigate } from '../../../lib/router.js';
export default class SkillsPage extends LightningElement {
  static renderMode = 'light';
  @api skillId; // from #/skills/:id ('new' or an id)
  handleClosed() {
    if (this.skillId) navigate('/skills', { replace: true });
  }
}
