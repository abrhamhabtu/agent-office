import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FeedStatus, Impact, NewsItem, Symbol } from '../../shared/trading.js';
import { pacific } from './engine.js';

// The wire: this week's economic calendar (ForexFactory's public feed: the time, the consensus, the
// previous print and, once it's out, the actual) and the headlines off a few public market RSS feeds,
// each tagged with the markets it moves. Only what the sources said; nothing is written here.

const CALENDAR = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FEEDS: { name: string; url: string }[] = [
  { name: 'CNBC', url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html' },
  { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'Investing.com', url: 'https://www.investing.com/rss/news_25.rss' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
];
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) agent-office' };
/** ForexFactory asks for no more than a couple of pulls every five minutes; the week's calendar barely changes. */
const CALENDAR_EVERY = 30 * 60_000;
const HEADLINES_EVERY = 3 * 60_000;

const TAGS: [RegExp, Symbol[]][] = [
  [/\b(nasdaq|tech stocks?|semiconductor|chip|nvidia|apple|microsoft|meta|amazon|alphabet|google|tesla|ai stocks?|qqq)\b/i, ['NQ']],
  [/\b(s&p|stocks?|wall street|dow|equities|earnings|spx|spy|russell)\b/i, ['ES']],
  [/\b(gold|bullion|precious metals?|silver)\b/i, ['GC']],
  [/\b(bitcoin|btc|crypto|ether(eum)?|stablecoin|coinbase|etf flows?|microstrategy|strategy inc)\b/i, ['BTC']],
  [/\b(fed|fomc|powell|rate cuts?|rate hikes?|interest rates?|treasur(y|ies)|yields?|inflation|cpi|ppi|pce|jobs report|payrolls|nfp|unemployment|gdp|recession|tariffs?)\b/i, ['NQ', 'ES', 'GC', 'BTC']],
  [/\b(dollar|dxy|geopolitic|war|sanctions?|middle east|ukraine|israel|iran|china)\b/i, ['GC', 'ES']],
];
const HIGH = /\b(fed|fomc|powell|cpi|ppi|pce|payrolls|nfp|jobs report|rate (cut|hike|decision)|crash|plunge|surge|soar|record high|emergency|default|tariffs?)\b/i;
const MED = /\b(earnings|guidance|yields?|treasur|inflation|gdp|jobless|retail sales|ism|pmi|sentiment|nvidia|apple|microsoft|etf)\b/i;

function tag(text: string): Symbol[] {
  const out = new Set<Symbol>();
  for (const [re, syms] of TAGS) if (re.test(text)) for (const s of syms) out.add(s);
  return [...out];
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;|&#x27;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .trim();

/** The items of an RSS feed: title, link and when. */
export function parseRss(xml: string): { title: string; link?: string; at: number }[] {
  const out: { title: string; link?: string; at: number }[] = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const item = m[0];
    const title = decode(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? '');
    const link = decode(/<link>([\s\S]*?)<\/link>/.exec(item)?.[1] ?? '') || undefined;
    const at = Date.parse(decode(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(item)?.[1] ?? ''));
    if (title && Number.isFinite(at)) out.push({ title: title.slice(0, 200), link: link && /^https:\/\//.test(link) ? link : undefined, at });
  }
  return out;
}

function clock(ts: number, now: number): string {
  const p = pacific(ts);
  const t = `${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}`;
  if (p.date === pacific(now).date) return t;
  return `${new Date(`${p.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${t}`;
}

type CalendarRow = { title: string; country: string; date: string; impact: string; forecast?: string; previous?: string; actual?: string };

export class NewsDesk {
  private calendar: NewsItem[] = [];
  /** The week's calendar as ForexFactory last sent it, kept on disk so a restart doesn't ask again. */
  private cacheFile: string | null;
  private headlines: NewsItem[] = [];
  private timers: NodeJS.Timeout[] = [];
  private status: FeedStatus[] = [
    { id: 'calendar', name: 'Economic calendar · ForexFactory', ok: false, lastAt: null, note: 'This week’s US releases: time, consensus, previous and actual' },
    { id: 'headlines', name: 'Headlines · CNBC, MarketWatch, Investing.com', ok: false, lastAt: null, note: 'Market news, tagged by the futures it moves' },
  ];

  constructor(dataDir?: string) {
    this.cacheFile = dataDir ? path.join(dataDir, 'trading', 'calendar.json') : null;
  }

  start() {
    // A copy from the last half hour is used as it is; ForexFactory turns away pulls that come too often.
    let fresh = false;
    if (this.cacheFile) {
      try {
        this.useCalendar(JSON.parse(readFileSync(this.cacheFile, 'utf8')) as CalendarRow[], statSync(this.cacheFile).mtimeMs);
        fresh = Date.now() - statSync(this.cacheFile).mtimeMs < CALENDAR_EVERY;
      } catch {
        // No copy yet.
      }
    }
    if (!fresh) void this.pullCalendar();
    void this.pullHeadlines();
    this.timers.push(setInterval(() => void this.pullCalendar(), CALENDAR_EVERY));
    this.timers.push(setInterval(() => void this.pullHeadlines(), HEADLINES_EVERY));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }

  private async pullCalendar() {
    const s = this.status[0]!;
    try {
      const res = await fetch(CALENDAR, { headers: UA, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(res.status === 429 ? 'rate-limited, trying again in 30 minutes' : `${res.status}`);
      const rows = (await res.json()) as CalendarRow[];
      this.useCalendar(rows, Date.now());
      if (this.cacheFile) {
        mkdirSync(path.dirname(this.cacheFile), { recursive: true });
        writeFileSync(this.cacheFile, JSON.stringify(rows));
      }
    } catch (e) {
      // Still showing the last copy, if there is one: say so rather than going dark.
      s.ok = this.calendar.length > 0;
      s.note = `ForexFactory didn’t answer (${(e as Error).message})${this.calendar.length ? '; showing the copy from earlier' : ''}`;
    }
  }

  private useCalendar(rows: CalendarRow[], at: number) {
    const s = this.status[0]!;
    const now = Date.now();
    this.calendar = rows
      .filter((r) => r.country === 'USD' && (r.impact === 'High' || r.impact === 'Medium'))
      .map((r, i) => {
        const when = Date.parse(r.date);
        const impact: Impact = r.impact === 'High' ? 'high' : 'med';
        const text = `${r.title}${r.forecast ? ` · cons ${r.forecast}` : ''}${r.previous ? ` · prev ${r.previous}` : ''}`;
        return { id: `cal-${i}-${when}`, at: when, time: clock(when, now), headline: text, impact, symbols: tag(`${r.title} fed`), kind: 'calendar' as const, source: 'ForexFactory', forecast: r.forecast || undefined, previous: r.previous || undefined, actual: r.actual || undefined };
      })
      .filter((n) => Number.isFinite(n.at));
    s.ok = true;
    s.lastAt = at;
    s.note = 'This week’s US releases: time, consensus, previous and actual';
  }

  private async pullHeadlines() {
    const s = this.status[1]!;
    const seen = new Set<string>();
    const out: NewsItem[] = [];
    let any = false;
    await Promise.all(
      FEEDS.map(async (f) => {
        try {
          const res = await fetch(f.url, { headers: UA, signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return;
          for (const it of parseRss(await res.text())) {
            const key = it.title.toLowerCase().replace(/\W+/g, ' ').slice(0, 60);
            if (seen.has(key)) continue;
            seen.add(key);
            const symbols = tag(it.title);
            if (!symbols.length) continue;
            any = true;
            out.push({ id: `h-${key}`, at: it.at, time: '', headline: it.title, impact: HIGH.test(it.title) ? 'high' : MED.test(it.title) ? 'med' : 'low', symbols, kind: 'headline', source: f.name, link: it.link });
          }
        } catch {
          // One feed down; the others carry on.
        }
      }),
    );
    if (any) {
      this.headlines = out.sort((a, b) => b.at - a.at).slice(0, 40);
      s.ok = true;
      s.lastAt = Date.now();
    } else s.ok = false;
  }

  /** Today's and the rest of the week's calendar, then the latest headlines. Clocks are redone every time. */
  items(now = Date.now()): NewsItem[] {
    const cutoff = now - 18 * 3_600_000;
    const cal = this.calendar.filter((n) => n.at >= cutoff).map((n) => ({ ...n, time: clock(n.at, now) }));
    const heads = this.headlines.filter((n) => n.at >= now - 36 * 3_600_000).map((n) => ({ ...n, time: clock(n.at, now) }));
    return [...cal, ...heads];
  }

  /** A high-impact release within this many minutes either side of now. */
  riskyNews(now: number, minutes = 15): NewsItem | undefined {
    return this.calendar.find((n) => n.impact === 'high' && Math.abs(n.at - now) <= minutes * 60_000);
  }

  feeds(): FeedStatus[] {
    return this.status.map((s) => ({ ...s }));
  }
}
