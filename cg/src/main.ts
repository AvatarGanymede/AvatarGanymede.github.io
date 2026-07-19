import './style.css';
import { App } from './App';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');

const app = new App(root);
app.init().catch((err) => {
  console.error(err);
  root.innerHTML = `<div class="loading"><div class="loading-card"><h2>加载失败</h2><p>${String(err)}</p></div></div>`;
});
