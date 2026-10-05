/**
 * PSX data feed: fetch and parse public pages of the PSX data portal (dps.psx.com.pk).
 *
 * Uses only the portal's normal HTML pages, fetched with an honest User-Agent:
 *   /              -> index levels (KSE-100 and others)
 *   /screener      -> one table of every listed stock (price, change, P/E, dividend yield, index membership)
 *   /company/{SYM} -> live quote, day stats, 52-week range, "as of" time, announcements
 *
 * The JSON/XHR endpoints (/timeseries, /market-watch, /symbols) reject scripted clients since
 * 2026-09-24 unless they imitate a browser and replay an anti-bot token. We deliberately do not.
 * Never invents a value: anything that cannot be parsed comes back as null.
 */
import * as cheerio from 'cheerio';
import type { Announcement, AnnouncementKind, Price } from '../shared/types.ts';

export const BASE_URL = 'https://dps.psx.com.pk';
export const USER_AGENT = 'psx-personal-assistant/1.0 (personal, non-commercial)';
const TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [2_000, 5_000];
const POLITE_DELAY_MS = 600;

export interface IndexQuote { name: string; value: number | null; change: number | null; change_pct: number | null }
export interface ScreenerRow {
  symbol: string; sector_code: string; sector: string | null; listed_in: string[]; price: number | null;
  change_pct: number | null; pe: number | null; dividend_yield_pct: number | null; market_cap: number | null;
}
export interface Quote {
  symbol: string; name: string | null; sector: string | null; price: number | null; change: number | null;
  change_pct: number | null; open: number | null; high: number | null; low: number | null; volume: number | null;
  ldcp: number | null; high_52w: number | null; low_52w: number | null; as_of: string | null;
  announcements: Announcement[];
}
export interface Snapshot {
  fetched_at: string;
  indices: Record<string, IndexQuote>;
  quotes: Record<string, Quote>;
  screener: Record<string, ScreenerRow>;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------
const SUFFIX: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/** 'Rs.114.37' -> 114.37, '(-1.27%)' -> -1.27, '1,830,789' -> 1830789, '12.6B' -> 1.26e10 */
export function parseNum(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.replace(/−/g, '-');
  const m = /-?\d[\d,]*\.?\d*/.exec(t);
  if (!m) return null;
  const v = Number(m[0].replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  const tail = t.charAt(m.index + m[0].length).toUpperCase();
  return tail in SUFFIX ? v * SUFFIX[tail] : v;
}

/** '105.98 — 174.40' -> [105.98, 174.40] */
export function parseRange(text: string | null | undefined): [number | null, number | null] {
  if (!text) return [null, null];
  const parts = text.trim().split(/\s*[—–-]\s+/);
  return parts.length === 2 ? [parseNum(parts[0]), parseNum(parts[1])] : [null, null];
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** '^ As of Mon, Oct 5, 2026 3:49 PM' -> '2026-10-05T10:49:00.000Z' (PKT is UTC+5) */
export function parseAsOf(text: string | null | undefined): string | null {
  const m = text && /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)/.exec(text);
  if (!m || !(m[1] in MONTHS)) return null;
  let h = Number(m[4]) % 12;
  if (m[6] === 'PM') h += 12;
  return new Date(Date.UTC(Number(m[3]), MONTHS[m[1]], Number(m[2]), h - 5, Number(m[5]))).toISOString();
}

/** 'Aug 28, 2026' -> '2026-08-28' */
export function parseDay(text: string): string | null {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(text.trim());
  if (!m || !(m[1] in MONTHS)) return null;
  return new Date(Date.UTC(Number(m[3]), MONTHS[m[1]], Number(m[2]))).toISOString().slice(0, 10);
}

export function classifyAnnouncement(title: string): AnnouncementKind {
  const t = title.toLowerCase();
  if (['dividend', 'bonus', 'right shares', 'payout', 'book closure'].some((w) => t.includes(w))) return 'dividend';
  if (['financial result', 'quarterly report', 'half yearly', 'annual report', 'accounts'].some((w) => t.includes(w))) return 'results';
  if (t.includes('board meeting')) return 'board_meeting';
  return 'other';
}

const txt = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

// ---------------------------------------------------------------------------
// Page parsers (pure: html in, data out)
// ---------------------------------------------------------------------------
export function parseIndices(html: string): Record<string, IndexQuote> {
  const $ = cheerio.load(html);
  const out: Record<string, IndexQuote> = {};
  $('.topIndices__item').each((_, el) => {
    const item = $(el);
    const name = txt(item.find('.topIndices__item__name').text());
    if (!name || out[name]) return;
    out[name] = {
      name,
      value: parseNum(item.find('.topIndices__item__val').text()),
      change: parseNum(item.find('.topIndices__item__change').text()),
      change_pct: parseNum(item.find('.topIndices__item__changep').text()),
    };
  });
  return out;
}

export function parseScreener(html: string): Record<string, ScreenerRow> {
  const $ = cheerio.load(html);
  const sectorNames: Record<string, string> = {};
  $('select[name="sector"] option, select#sector option').each((_, o) => {
    const v = $(o).attr('value');
    if (v && /^\d+$/.test(v)) sectorNames[v] = txt($(o).text()) ?? v;
  });
  const out: Record<string, ScreenerRow> = {};
  $('table').each((_, table) => {
    const heads = $(table).find('th').map((_, th) => txt($(th).text())?.toUpperCase() ?? '').get();
    if (!heads.includes('SYMBOL') || !heads.includes('PRICE') || Object.keys(out).length) return;
    const col = (name: string) => heads.indexOf(name);
    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('td').map((_, td) => txt($(td).text()) ?? '').get();
      if (!cells.length) return;
      const at = (name: string) => (col(name) >= 0 ? cells[col(name)] ?? null : null);
      const symbol = (at('SYMBOL') ?? '').toUpperCase();
      if (!symbol) return;
      const code = at('SECTOR') ?? '';
      out[symbol] = {
        symbol,
        sector_code: code,
        sector: sectorNames[code] ?? null,
        listed_in: (at('LISTED IN') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        price: parseNum(at('PRICE')),
        change_pct: parseNum(at('CHANGE (%)')),
        pe: parseNum(at('PE RATIO (TTM)')),
        dividend_yield_pct: parseNum(at('DIVIDEND YIELD (%)')),
        market_cap: parseNum(at('MARKET CAP.')),
      };
    });
  });
  return out;
}

export function parseCompany(html: string, symbol: string): Quote {
  const $ = cheerio.load(html);
  const sym = symbol.toUpperCase();

  // The first .stats block on the page belongs to the regular (REG) market.
  const stats: Record<string, string> = {};
  $('.stats_item').each((_, el) => {
    const item = $(el);
    let label = txt(item.find('.stats_label').text());
    let value = txt(item.find('.stats_value').text());
    if (!label || !value) {
      const parts = item.contents().map((_, n) => txt($(n).text())).get().filter(Boolean) as string[];
      if (parts.length < 2) return;
      [label, value] = [parts[0], parts[parts.length - 1]];
    }
    const key = label.replace(/\^/g, '').trim().toUpperCase();
    if (!(key in stats)) stats[key] = value;
  });

  const [low52, high52] = parseRange(stats['52-WEEK RANGE']);
  const vol = parseNum(stats['VOLUME']);
  return {
    symbol: sym,
    // Own text only: PSX nests badges such as "XD" (ex-dividend) inside the name element.
    name: txt($('.quote__name').first().contents().filter((_, n) => n.type === 'text').text()),
    sector: txt($('.quote__sector').first().text()),
    price: parseNum($('.quote__close').first().text()),
    change: parseNum($('.quote__change .change__value').first().text()),
    change_pct: parseNum($('.quote__change .change__percent').first().text()),
    open: parseNum(stats['OPEN']),
    high: parseNum(stats['HIGH']),
    low: parseNum(stats['LOW']),
    volume: vol == null ? null : Math.round(vol),
    ldcp: parseNum(stats['LDCP']),
    high_52w: high52,
    low_52w: low52,
    as_of: parseAsOf($('.quote__date').first().text()),
    announcements: parseCompanyAnnouncements($, sym),
  };
}

function parseCompanyAnnouncements($: cheerio.CheerioAPI, symbol: string): Announcement[] {
  const seen = new Set<string>();
  const out: Announcement[] = [];
  $('table').each((_, table) => {
    const heads = $(table).find('th').map((_, th) => txt($(th).text())?.toUpperCase() ?? '').get();
    if (heads[0] !== 'DATE' || heads[1] !== 'TITLE') return;
    $(table).find('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 2) return;
      const published = parseDay($(tds[0]).text());
      const title = txt($(tds[1]).text());
      if (!published || !title) return;
      const pdf = $(tr).find('a[href$=".pdf"]').attr('href') ?? null;
      const pdfUrl = pdf && pdf.startsWith('/') ? BASE_URL + pdf : pdf;
      const docId = pdf ? /\/(\d+)\.pdf$/.exec(pdf)?.[1] : undefined;
      const id = docId ? `psx-doc-${docId}` : `psx-${hash(`${symbol}|${published}|${title}`)}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, symbol, published_at: published, title, kind: classifyAnnouncement(title), pdf_url: pdfUrl });
    });
  });
  return out.sort((a, b) => b.published_at.localeCompare(a.published_at));
}

function hash(s: string): string {
  let h = 0x811c9dc5; // FNV-1a, stable across runs
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
export class FetchError extends Error {}

export interface FetcherOptions {
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  politeDelayMs?: number;
}

/** Polite HTTP client: honest User-Agent, retries with backoff, a pause between calls. */
export class Fetcher {
  private lastCall = 0;
  readonly baseUrl: string;
  private sleep: (ms: number) => Promise<void>;
  private fetchImpl: typeof fetch;
  private politeDelayMs: number;

  constructor(opts: FetcherOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? BASE_URL).replace(/\/$/, '');
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.politeDelayMs = opts.politeDelayMs ?? POLITE_DELAY_MS;
  }

  async get(path: string): Promise<string> {
    const url = this.baseUrl + path;
    let lastErr = 'unknown error';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt) await this.sleep(RETRY_DELAYS_MS[attempt - 1]);
      const wait = this.politeDelayMs - (Date.now() - this.lastCall);
      if (wait > 0) await this.sleep(wait);
      let resp: Response;
      try {
        resp = await this.fetchImpl(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        this.lastCall = Date.now();
      } catch (e) {
        lastErr = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        continue;
      }
      if (resp.status === 200) return await resp.text();
      lastErr = `HTTP ${resp.status}`;
      if (resp.status < 500 && resp.status !== 429) break; // a 4xx will not fix itself
    }
    throw new FetchError(`GET ${url} failed: ${lastErr}`);
  }
}

/** Fetch indices, screener and per-symbol company pages. Never throws; failures go to `errors`. */
export async function fetchSnapshot(symbols: string[], opts: { fetcher?: Fetcher; screener?: boolean } = {}): Promise<Snapshot> {
  const fetcher = opts.fetcher ?? new Fetcher();
  const errors: string[] = [];
  let indices: Record<string, IndexQuote> = {};
  let screener: Record<string, ScreenerRow> = {};
  const quotes: Record<string, Quote> = {};

  try {
    indices = parseIndices(await fetcher.get('/'));
    if (!indices.KSE100) errors.push('KSE100 not found on homepage (layout change?)');
  } catch (e) {
    errors.push(`indices: ${(e as Error).message}`);
  }
  if (opts.screener !== false) {
    try {
      screener = parseScreener(await fetcher.get('/screener'));
      if (!Object.keys(screener).length) errors.push('screener table not found (layout change?)');
    } catch (e) {
      errors.push(`screener: ${(e as Error).message}`);
    }
  }
  for (const s of [...new Set(symbols.map((x) => x.toUpperCase()))]) {
    try {
      const q = parseCompany(await fetcher.get(`/company/${encodeURIComponent(s)}`), s);
      if (q.price == null) errors.push(`${s}: no price on company page`);
      quotes[s] = q;
    } catch (e) {
      errors.push(`${s}: ${(e as Error).message}`);
    }
  }
  return { fetched_at: new Date().toISOString(), indices, quotes, screener, errors };
}

/** Merge a company quote with its screener row into the shape stored in `prices`. */
export function toPrice(q: Quote, s: ScreenerRow | undefined): Price {
  return {
    symbol: q.symbol,
    name: q.name,
    sector: q.sector ?? s?.sector ?? null,
    price: q.price,
    change: q.change,
    change_pct: q.change_pct,
    volume: q.volume,
    ldcp: q.ldcp,
    high_52w: q.high_52w,
    low_52w: q.low_52w,
    dividend_yield_pct: s?.dividend_yield_pct ?? null,
    pe: s?.pe ?? null,
    // KMI All Share membership = Shariah compliant. Unknown when the stock is missing from the screener.
    is_shariah: s ? s.listed_in.includes('KMIALLSHR') : null,
    as_of: q.as_of,
  };
}

export function isUsable(s: Snapshot): boolean {
  return !!s.indices.KSE100?.value && Object.values(s.quotes).some((q) => q.price != null);
}
