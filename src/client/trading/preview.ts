import { h, openModal, type Modal } from '../ui/dom';
import { trading } from './feed';
import type { Screen } from './screens';

let current: Modal | null = null;

/** Show the actual canvas feeding an office screen, so its next repaint is visible here too. */
export function openScreenPreview(opts: { title: string; place: string; screen: Screen; detail: string; onDetails: () => void }) {
  current?.close();
  const { title, place, screen, detail, onDetails } = opts;
  const status = h('span.screen-preview-status');
  const updated = h('span.screen-preview-updated');
  const updateStatus = () => {
    const snap = trading.snap;
    status.textContent = snap?.ready ? '● LIVE FEED' : '○ WAITING FOR DATA';
    status.classList.toggle('waiting', !snap?.ready);
    updated.textContent = snap?.ready ? `Updated ${new Date(snap.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Connecting to the market';
  };
  updateStatus();
  const unsubscribe = trading.on(updateStatus);
  const canvas = screen.element;
  canvas.classList.add('screen-preview-canvas');
  const details = h('button.btn.primary', { type: 'button', onclick: () => { current?.close(); onDetails(); } }, 'Open full details ↗');
  const el = h('div.modal.screen-preview', { role: 'dialog', 'aria-label': `${title} live preview` },
    h('header', {}, h('div.screen-preview-heading', {}, h('span.screen-preview-kicker', {}, place), h('h2', {}, title)), status),
    h('div.screen-preview-body', {},
      h('div.screen-preview-display', {}, h('div.screen-preview-bezel', {}, canvas), h('div.screen-preview-foot', {}, h('span', {}, 'THE SAME LIVE SCREEN AS IN THE OFFICE'), updated)),
      h('aside.screen-preview-side', {}, h('span.screen-preview-index', {}, place), h('h3', {}, title), h('p', {}, detail), h('div.screen-preview-live', {}, h('span.screen-preview-pulse'), 'Updates with the office feed'), details),
    ),
  );
  const modal = openModal(el, { doing: `looking at ${title}`, onClose: () => { unsubscribe(); canvas.remove(); if (current === modal) current = null; } });
  current = modal;
}
