import { mountResearchWorkbench } from './trading/research-workbench';
import './style.css';
void fetch('/api/trading/research', { credentials: 'same-origin' }).then(res => {
  if (res.status === 401 || res.status === 403) { location.replace('/login?next=%2Fresearch'); return; }
  mountResearchWorkbench(document.getElementById('research')!);
}).catch(() => { document.getElementById('research')!.textContent = 'The office is not answering. Start the preview server and reload.'; });
