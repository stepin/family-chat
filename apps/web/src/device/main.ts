import '../styles/base.css';
import { formatDeviceReport, runDeviceChecks, type DeviceCheck } from './checks.ts';
import { registerServiceWorker } from '../pwa.ts';

registerServiceWorker();

const button = document.getElementById('run') as HTMLButtonElement;
const list = document.getElementById('list') as HTMLUListElement;
const copyBtn = document.getElementById('copy') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLSpanElement;
const out = document.getElementById('report') as HTMLTextAreaElement;
let text = '';

function render(items: DeviceCheck[]): void {
  list.replaceChildren(
    ...items.map((c) => {
      const li = document.createElement('li');
      li.className = c.ok === true ? 'ok' : c.ok === false ? 'fail' : 'info';
      li.dataset['check'] = c.id;
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = c.ok === true ? '✓' : c.ok === false ? '✕' : 'i';
      const body = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = `${c.title}. `;
      body.append(strong, c.detail);
      li.append(mark, body);
      return li;
    }),
  );
}

button.addEventListener('click', async () => {
  button.disabled = true;
  const items = await runDeviceChecks(render);
  text = formatDeviceReport(items);
  out.value = text;
  copyBtn.hidden = false;
  button.disabled = false;
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'Отчёт скопирован.';
  } catch {
    status.textContent = 'Не удалось скопировать: выделите текст ниже.';
    out.closest('details')?.setAttribute('open', '');
  }
});
