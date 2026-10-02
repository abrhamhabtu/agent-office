import type { TradingSnapshot } from '../../shared/trading';
import type { PropFarmView } from '../../shared/propfarm';
import { h } from '../ui/dom';
import { trading } from './feed';
import { badge } from './labkit';
import { openTrading } from './panel';

// Connections: what the office is hearing from right now, in one place. The question it answers first is
// the one that matters for a forward run: is the data real-time, or running behind the exchange? Then each
// connection, whether it is up, what it is for, and where to set it up.

export type DataState = 'offline' | 'live' | 'mixed' | 'delayed' | 'quiet' | 'closed';

/** The state of the futures data the farm trades on, in a word. */
export function dataState(v: PropFarmView | null): DataState {
  if (trading.offline) return 'offline';
  const feeds = v?.ops.feeds ?? [];
  // No fresh bars: outside the session that is the market being closed, not a fault.
  const session = trading.snap?.session;
  if (!feeds.length || feeds.every((f) => f.stale)) return session && (session.weekend || session.phase === 'closed') ? 'closed' : 'quiet';
  const live = feeds.filter((f) => !f.delayed && !f.stale).length;
  return live === feeds.length ? 'live' : live ? 'mixed' : 'delayed';
}

export const DATA_WORD: Record<DataState, { chip: string; head: string; kind: string }> = {
  offline: { chip: 'Office not answering', head: 'The office isn’t answering', kind: 'bad' },
  live: { chip: 'Real-time data', head: 'Real-time', kind: 'ok' },
  mixed: { chip: 'Partly real-time', head: 'Partly real-time', kind: 'warn' },
  delayed: { chip: 'Delayed data', head: 'Delayed', kind: 'warn' },
  quiet: { chip: 'Feeds quiet', head: 'Nothing is arriving', kind: 'bad' },
  closed: { chip: 'Market closed', head: 'The market is closed', kind: 'dim' },
};

const age = (sec: number | null) => (sec == null ? 'no bars yet' : sec < 90 ? `${sec}s old` : sec < 5400 ? `${Math.round(sec / 60)}m old` : `${Math.round(sec / 3600)}h old`);
const ago = (ts: number | null) => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172_800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
};

/** A note as a sentence. */
const dot = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

interface Row {
  name: string;
  /** What it gives the office, in a few words. */
  gives: string;
  state: 'on' | 'off' | 'optional' | 'locked';
  word: string;
  detail: string;
}

function rows(s: TradingSnapshot, v: PropFarmView | null, research: { configured: boolean } | null | 'unknown'): Row[] {
  const feed = (id: string) => s.feeds.find((f) => f.id === id);
  const yahoo = feed('yahoo');
  const tv = feed('tradingview');
  const px = s.journal;
  const pxLive = (v?.ops.feeds ?? []).some((f) => /topstep|projectx/i.test(f.source) && !f.stale);
  const notices = (v?.runs ?? []).filter((r) => r.discord && r.status !== 'stopped').length;
  const lastAlert = s.alerts[0]?.at ?? null;
  const out: Row[] = [
    { name: 'Yahoo · CME futures', gives: 'Delayed one-minute bars and a month of history', state: yahoo?.ok ? 'on' : 'off', word: yahoo?.ok ? 'CONNECTED' : 'DOWN', detail: yahoo ? `${dot(yahoo.note)} Updated ${ago(yahoo.lastAt)}.` : 'Not started yet.' },
    { name: 'TradingView · real-time candles', gives: 'Real-time bars from your own charts, by alert webhook', state: tv?.ok ? 'on' : 'optional', word: tv?.ok ? 'RECEIVING' : 'NOT SET UP', detail: tv?.ok ? `${dot(tv.note)} Last candle ${ago(tv.lastAt)}.` : tv?.lastAt ? `Went quiet ${ago(tv.lastAt)}: the office is back on delayed bars. Check the alert is still active in TradingView.` : 'One Pine indicator and one alert per market sends each closed candle here. Needs a TradingView plan with webhooks and your CME data subscription.' },
    { name: 'TopstepX · real-time futures', gives: 'Real-time bars through the ProjectX market connection', state: pxLive ? 'on' : 'optional', word: pxLive ? 'RECEIVING' : s.projectXMarketEnabled ? 'ENABLED, NOTHING YET' : 'OFF', detail: pxLive ? 'Real-time NQ, ES and GC bars are arriving.' : s.projectXMarketEnabled ? 'Switched on, but no bars have come through: check the API access in your TopstepX dashboard.' : px.connected ? 'ProjectX is connected: real-time futures can be switched on in the connection settings.' : 'Needs a ProjectX connection first, and API access activated in TopstepX.' },
    { name: 'ProjectX · your accounts', gives: 'Balances and fills of your real accounts, read-only', state: px.connected ? 'on' : 'optional', word: px.connected ? 'CONNECTED' : px.error ? 'ERROR' : 'NOT CONNECTED', detail: px.connected ? `${px.userName ?? ''}: ${px.accounts.length} account${px.accounts.length === 1 ? '' : 's'}, synced ${ago(px.syncedAt)}.` : px.error ?? 'Without it, an account you track here is kept by hand.' },
    { name: 'TradingView · alerts', gives: 'Your indicator’s alerts ring the matching desk', state: lastAlert ? 'on' : 'optional', word: lastAlert ? 'RECEIVING' : 'NONE YET', detail: lastAlert ? `Last alert ${ago(lastAlert)}.` : 'No alert has arrived. The webhook address is in the connection settings.' },
    { name: 'TradingView · research (MCP)', gives: 'Read-only lookups: symbols, bars, technicals, the calendar', state: research === 'unknown' || !research ? 'optional' : research.configured ? 'on' : 'optional', word: research === 'unknown' ? 'CHECKING…' : !research ? 'UNAVAILABLE' : research.configured ? 'SIGNED IN' : 'NOT SIGNED IN', detail: research && research !== 'unknown' && research.configured ? 'Credentials are saved. Run a request in the connection settings to confirm your CME entitlement: saved credentials alone don’t prove it.' : 'Sign in once with your TradingView account. It is research only: it never replaces the trading feed and cannot place an order.' },
    { name: 'Discord · notices', gives: 'Every fill, pass and payout of a forward run, on your phone', state: notices ? 'on' : 'optional', word: notices ? `${notices} RUN${notices === 1 ? '' : 'S'}` : 'OFF', detail: notices ? 'Set per run, on the Forward view.' : 'Paste a webhook address on a run in the Forward view.' },
    { name: 'Broker · orders', gives: 'Nothing: there is no order route', state: 'locked', word: 'LOCKED', detail: 'The office never connects to a broker to place an order. Forward runs fill on paper.' },
  ];
  for (const f of s.feeds) if (!['yahoo', 'tradingview', 'projectx-market'].includes(f.id)) out.splice(3, 0, { name: f.name, gives: /coinbase/i.test(f.name) ? 'Real-time Bitcoin prices and candles' : /calendar/i.test(f.name) ? 'The week’s scheduled releases, for the news guard' : /headline/i.test(f.name) ? 'Market news, for the news board' : 'A market or news feed', state: f.ok ? 'on' : 'off', word: f.ok ? 'CONNECTED' : 'DOWN', detail: `${dot(f.note)}${f.lastAt ? ` Updated ${ago(f.lastAt)}.` : ''}` });
  return out;
}

/** The Connections sheet. `back` closes it. */
export function connectionsSheet(v: PropFarmView | null, back: () => void): HTMLElement {
  const s = trading.snap;
  const state = dataState(v);
  const word = DATA_WORD[state];
  const feeds = v?.ops.feeds ?? [];
  const body = h('div.cx-rows');
  let research: { configured: boolean } | null | 'unknown' = 'unknown';
  const draw = () => {
    if (!s) return;
    body.replaceChildren(...rows(s, v, research).map((r) => h('div.cx-row', { 'data-state': r.state },
      h('i.cx-dot', { 'aria-hidden': 'true' }), h('div.cx-row-main', {}, h('b', {}, r.name), h('span', {}, r.gives), h('small', {}, r.detail)),
      badge(r.word, r.state === 'on' ? 'ok' : r.state === 'off' ? 'bad' : r.state === 'locked' ? 'dim' : 'warn'))));
  };
  draw();
  // The research connection's state is the server's to say: asked once when the sheet opens.
  void fetch('/api/trading/tv-mcp/status', { credentials: 'same-origin' }).then(async (res) => {
    research = res.ok ? ((await res.json()) as { configured: boolean }) : null;
    draw();
  }).catch(() => {
    research = null;
    draw();
  });
  const live = feeds.filter((f) => !f.delayed && !f.stale).map((f) => f.symbol);
  const delayed = feeds.filter((f) => f.delayed && !f.stale).map((f) => f.symbol);
  const answer = state === 'offline' ? 'This window is showing the last thing the office sent. It tries again every second: nothing needs reloading.'
    : state === 'live' ? `${live.join(', ')} bars are arriving in real time. A forward run started now is a real-time paper test.`
    : state === 'mixed' ? `${live.join(', ')} ${live.length === 1 ? 'is' : 'are'} real-time; ${delayed.join(', ') || 'the rest'} ${delayed.length === 1 ? 'is' : 'are'} on delayed bars. A run that trades a delayed market is a delayed forward replay.`
    : state === 'delayed' ? 'NQ, ES and GC are on Yahoo’s bars, which run several minutes behind the exchange. That is fine for research and for a delayed forward replay. It is not real-time, and a run on it is never called a live test.'
    : state === 'closed' ? `No bars arrive while the market is shut. When it reopens, ${feeds.filter((f) => f.delayed).map((f) => f.symbol).join(', ') || 'the futures'} will be on ${feeds.some((f) => !f.delayed) ? 'delayed bars and the rest real-time' : 'Yahoo’s delayed bars'} unless one of the real-time routes below is set up by then.`
    : 'No fresh bars on any market although the session is open: a feed has stopped. Check each connection below.';
  const openSettings = () => openTrading('office', 'connections');
  return h('div.pf-sheet.cx', {},
    h('div.tl-how-head', {}, h('div', {}, h('span.tl-kicker', {}, 'WHAT THE OFFICE IS HEARING FROM, RIGHT NOW'), h('h3', {}, 'Connections')), h('button.tl-btn', { type: 'button', onclick: back }, 'Back')),
    h('div.cx-answer', { 'data-kind': word.kind }, h('div', {}, h('span.tl-kicker', {}, 'IS THE DATA REAL-TIME?'), h('b', {}, word.head), h('p', {}, answer)),
      h('button.tl-btn.primary', { type: 'button', onclick: openSettings }, 'Open connection settings')),
    h('div.cx-markets', {}, ...feeds.map((f) => h('div.cx-market', { 'data-kind': f.stale ? 'dim' : f.delayed ? 'warn' : 'ok' },
      h('b', {}, f.symbol), badge(f.stale ? 'QUIET' : f.delayed ? 'DELAYED' : 'REAL-TIME', f.stale ? 'dim' : f.delayed ? 'warn' : 'ok'), h('span', {}, f.source), h('small', {}, `Newest bar ${age(f.ageSec)}`)))),
    h('div.cx-cols', {},
      h('section.tl-panel', {}, h('div.tl-panel-head', {}, h('h3', {}, 'Every connection'), h('span', {}, 'What each is for, and whether it is up')), body),
      h('section.tl-panel', {}, h('div.tl-panel-head', {}, h('h3', {}, 'To get real-time futures'), h('span', {}, 'Either route works. Both are read-only.')),
        h('div.cx-route', {}, h('span.cx-route-n', {}, 'A'), h('div', {}, h('b', {}, 'From your TradingView charts'), h('ol', {},
          h('li', {}, 'Open connection settings, and copy the Pine script under “TradingView → real-time candles”.'),
          h('li', {}, 'Add it to a 1-minute chart of each market (NQ1!, ES1!, GC1!).'),
          h('li', {}, 'Create one alert per chart on “Any alert() function call”, with the office’s webhook address.'),
          h('li', {}, 'Within a minute the market above turns REAL-TIME. It needs a TradingView plan with webhooks, your CME data subscription, and an https address TradingView can reach (a tunnel, for localhost).')))),
        h('div.cx-route', {}, h('span.cx-route-n', {}, 'B'), h('div', {}, h('b', {}, 'From TopstepX (ProjectX)'), h('ol', {},
          h('li', {}, 'Activate API access in your TopstepX dashboard.'),
          h('li', {}, 'Open connection settings and connect ProjectX with your username and API key.'),
          h('li', {}, 'Press “Enable real-time futures”. The markets above turn REAL-TIME when bars arrive.')))),
        h('p.tl-fine', {}, 'The same settings are also at ☰ → Connections and at the foot of the Session Desk (J).'))));
}
