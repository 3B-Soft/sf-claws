import './styles.css';
import { createElement } from 'lwc';
import App from 'x/app';

const root = document.getElementById('app') || document.body;
root.appendChild(createElement('x-app', { is: App }));
