import './styles.css';
import { createElement } from 'lwc';
import OptionsApp from 'x/optionsApp';

const root = document.getElementById('app') || document.body;
root.appendChild(createElement('x-options-app', { is: OptionsApp }));
