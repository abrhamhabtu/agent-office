import { h } from '../ui/dom';

/** OAuth tokens stay on the server. Provider responses are rendered as text, never HTML. */
export function tradingViewMcpCard(): HTMLElement {
  const state = h('p', {}, 'Essential or higher, excluding trials. Sign in once, then test a research request.');
  const output = h('pre', { style: 'white-space:pre-wrap;max-height:320px;overflow:auto;font-size:12px', 'aria-live': 'polite' });
  const symbol = h('input', { value: 'CME_MINI:MNQ1!', 'aria-label': 'TradingView research symbol', maxlength: '80' }) as HTMLInputElement;
  const tool = h('select', { 'aria-label': 'TradingView research tool' },
    ...[['search_symbols', 'Find a futures symbol'], ['get_ohlcv', 'Last 100 minute bars'], ['get_technicals_rating', 'Technical readings'], ['get_economic_calendar', 'High-impact US calendar']].map(([id, text]) => h('option', { value: id }, text!))) as HTMLSelectElement;
  let busy = false;
  const call = async (action: string, body?: object) => {
    const res = await fetch(`/api/trading/tv-mcp/${action}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Connection request failed');
    return data;
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (err) { state.textContent = err instanceof Error ? err.message : 'Connection failed'; }
    finally { busy = false; }
  };
  const check = () => run(async () => {
    const data = await call('status');
    state.textContent = data.configured ? 'Credentials saved. Run a research request to verify access and returned market timestamps.' : 'Not connected yet. Connect opens TradingView’s official authorization page.';
  });
  const connect = h('button.btn', { type: 'button', onclick: () => run(async () => {
    state.textContent = 'Preparing TradingView sign-in…';
    const data = await call('connect', {});
    if (data.url) {
      const link = h('a.btn', { href: data.url, target: '_blank', rel: 'noopener noreferrer' }, 'Continue to TradingView sign-in ↗');
      state.replaceChildren('Sign-in is ready. ', link);
    } else state.textContent = 'Authorization is saved. Check a research request below.';
  }) }, 'Connect TradingView');
  return h('section', { style: 'background:rgba(0,0,0,.05);border-radius:12px;padding:14px;display:grid;gap:10px' },
    h('h3', { style: 'margin:0' }, 'TradingView · official MCP research'), state,
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, connect,
      h('button.btn', { type: 'button', onclick: check }, 'Check connection'),
      h('button.btn', { type: 'button', onclick: () => run(async () => { await call('disconnect', {}); state.textContent = 'Local credentials removed. Revoke the app in TradingView too if needed.'; output.textContent = ''; }) }, 'Disconnect')),
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, symbol, tool,
      h('button.btn', { type: 'button', onclick: () => run(async () => {
        state.textContent = 'Requesting research…';
        const data = await call('research', { tool: tool.value, symbol: symbol.value.trim().toUpperCase() });
        output.textContent = JSON.stringify(data, null, 2).slice(0, 40000);
        state.textContent = 'Provider response received. Check its timestamps and delay status; this does not replace the office’s execution feed.';
      }) }, 'Run research request')), output,
    h('p', {}, 'Read-only research on this local office. MCP does not run your Pine Strategy Tester or place orders. Set indicator webhooks in TradingView itself. Your CME entitlement still needs a freshness check on the returned data.'),
    h('a', { href: 'https://www.tradingview.com/mcp/docs', target: '_blank', rel: 'noreferrer' }, 'Official connection documentation ↗'));
}
