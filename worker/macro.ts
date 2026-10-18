/**
 * Market Compass macro facts, read politely from the publishers' own public documents (honest User-Agent, no bot-check
 * bypass, a handful of requests a night):
 *   - SBP /assets/document/* PDFs: T-bill auction, PIB fixed-rate auction, liquid FX reserves, the daily mark-to-market
 *     exchange rates (PKR/USD) and KIBOR. SBP's HTML pages are bot-checked for scripts and are never used. A missing
 *     SBP asset answers HTTP 200 with an HTML page, so every answer must really be a PDF.
 *   - PBS monthly review PDF (CPI inflation, year on year); its link is read from the PBS price statistics page.
 *   - PSX home page: the KSE-100 panel's 1-year and YTD change.
 * Every value carries the date the document states and the URL it came from. Nothing here is a hardcoded value.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import { BASE_URL, FetchError, USER_AGENT, parseIndexStats, type IndexStats } from './feed.ts';
import { sbpDate } from './sbp.ts';

export interface MacroReading { series: string; as_of: string /* YYYY-MM-DD */; value: number; source: string /* URL */ }

const SBP_DOCS = 'https://www.sbp.org.pk/assets/document/';
const PBS_HOST = 'www.pbs.gov.pk';
export const MACRO_URLS = {
  tbills: `${SBP_DOCS}auction-tbills.pdf`,
  pib: `${SBP_DOCS}Auction-Investment.pdf`,
  forex: `${SBP_DOCS}forex.pdf`,
  pbs_prices: `https://${PBS_HOST}/price-statistics/`,
  psx_home: `${BASE_URL}/`,
};
/** Dated daily SBP files are looked for on the given day and up to this many days before it (weekends, holidays). */
export const MAX_STEP_BACK_DAYS = 7;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const monthIndex = (name: string) => MONTHS.findIndex((m) => m === name.toLowerCase() || m.slice(0, 3) === name.toLowerCase());
const num = (s: string) => { const v = Number(s.replace(/,/g, '')); return Number.isFinite(v) ? v : null; };
const pct = (v: number | null) => v != null && v > 0 && v < 100;

/** Today's date in Pakistan (UTC+5, no DST). */
export function pktToday(now = Date.now()): string { return new Date(now + 5 * 3600_000).toISOString().slice(0, 10); }
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "October 14, 2026" / "16-Oct-2026" / "16-Oct-26" → ISO day. */
export function looseDate(text: string): string | null {
  let m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text);
  if (m && monthIndex(m[1]) >= 0) return iso(Number(m[3]), monthIndex(m[1]) + 1, Number(m[2]));
  m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(text);
  if (m && monthIndex(m[2]) >= 0) return iso(Number(m[3]), monthIndex(m[2]) + 1, Number(m[1]));
  m = /(\d{1,2}-[A-Za-z]{3}-\d{2})(?!\d)/.exec(text);
  return m ? sbpDate(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Pure parsers: document text in, dated readings out
// ---------------------------------------------------------------------------

/** SBP MTB auction result: cut-off yield per tenor ("01-Month <realized> <face> 11.5003% 11.4307%"). */
export function parseTbills(text: string, source = MACRO_URLS.tbills): MacroReading[] {
  const dm = /invited[\s\S]{0,200}?\bon\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/.exec(text);
  const as_of = dm && looseDate(dm[1]);
  if (!as_of) return [];
  const out: MacroReading[] = [];
  for (const m of text.matchAll(/(\d{2})-Month\s+[\d,.]+\s+[\d,.]+\s+([\d.]+)%\s+([\d.]+)%/g)) {
    const series = `tbill_${Number(m[1])}m`;
    const value = num(m[2]);
    if (pct(value) && !out.some((r) => r.series === series)) out.push({ series, as_of, value: value!, source });
  }
  return out;
}

/** SBP PIB fixed-rate auction result: cut-off yield per tenor. A tenor with no accepted bids has no row and is skipped. */
export function parsePib(text: string, source = MACRO_URLS.pib): MacroReading[] {
  const dm = /held on\s+(\d{1,2}-[A-Za-z]{3}-\d{2,4})/.exec(text);
  const as_of = dm && looseDate(dm[1]);
  if (!as_of) return [];
  const out: MacroReading[] = [];
  for (const m of text.matchAll(/(\d{2})-Year\s+[\d,.]+\s+[\d,.]+\s+[\d,.-]+\s+[\d,.]+\s+[\d.]+\s+([\d.]+)%\s+([\d.]+)%/g)) {
    const series = `pib_${Number(m[1])}y`;
    const value = num(m[2]);
    if (pct(value) && !out.some((r) => r.series === series)) out.push({ series, as_of, value: value!, source });
  }
  return out;
}

/** SBP liquid FX reserves: every week-end row ("9-Oct-26 21,469.5 5,393.8 26,863.3", US$ million) → SBP and total. */
export function parseForex(text: string, source = MACRO_URLS.forex): MacroReading[] {
  const out: MacroReading[] = [];
  for (const m of text.matchAll(/(\d{1,2}-[A-Z][a-z]{2}-\d{2})\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)/g)) {
    const as_of = sbpDate(m[1]);
    const sbp = num(m[2]);
    const total = num(m[4]);
    if (!as_of || sbp == null || total == null || total <= 0) continue;
    for (const r of [{ series: 'fx_reserves_sbp', value: sbp }, { series: 'fx_reserves_total', value: total }]) {
      const i = out.findIndex((x) => x.series === r.series && x.as_of === as_of);
      if (i >= 0) out.splice(i, 1);
      out.push({ ...r, as_of, source });
    }
  }
  return out;
}

/** SBP mark-to-market revaluation rates: the USD ready rate. The date is the one printed on the sheet. */
export function parseM2m(text: string, source: string, fileDay: string): MacroReading[] {
  const m = /USD\s+([\d.]+)/.exec(text);
  const value = m ? num(m[1]) : null;
  if (value == null || value <= 0) return [];
  const printed = /(\d{1,2}-[A-Za-z]{3}-\d{2,4})/.exec(text);
  return [{ series: 'pkr_usd', as_of: (printed && looseDate(printed[1])) ?? fileDay, value, source }];
}

/** SBP KIBOR sheet: the 3-month offer rate. */
export function parseKibor(text: string, source: string, fileDay: string): MacroReading[] {
  const m = /3\s*-\s*Month\s+([\d.]+)\s+([\d.]+)/.exec(text);
  const value = m ? num(m[2]) : null;
  if (!pct(value)) return [];
  const printed = /(\d{1,2}-[A-Za-z]{3}-\d{2,4})/.exec(text);
  return [{ series: 'kibor_3m', as_of: (printed && looseDate(printed[1])) ?? fileDay, value: value!, source }];
}

/** PBS monthly review: "CPI inflation General, increased|decreased by X% on year-on-year basis in September 2026". */
export function parseCpi(text: string, source: string): MacroReading[] {
  const m = /CPI inflation General,\s*(increased|decreased)\s+by\s+([\d.]+)%\s+on\s+year-on-year\s+basis\s+in\s+([A-Za-z]+)\s+(\d{4})/i.exec(text.replace(/\s+/g, ' '));
  const mi = m ? monthIndex(m[3]) : -1;
  const v = m ? num(m[2]) : null;
  if (!m || mi < 0 || v == null) return [];
  return [{ series: 'cpi_yoy', as_of: iso(Number(m[4]), mi + 1, 1), value: m[1].toLowerCase() === 'decreased' ? -v : v, source }];
}

export const cpiUrl = (year: number, month: number) => `https://${PBS_HOST}/wp-content/uploads/2020/07/Monthly-Review-${cap(MONTHS[month - 1])}${year}.pdf`;
export const m2mUrl = (day: string) => `${SBP_DOCS}mark-to-market-revaluation-exchange-rate-${dayName(day)}.pdf`;
export const kiborUrl = (day: string) => `${SBP_DOCS}kibor-rates-${dayName(day)}.pdf`;
function dayName(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d}-${MONTHS[m - 1]}-${y}`;
}

/** Monthly review links on the PBS price statistics page (PBS's own host only), newest month first. */
export function findCpiLinks(html: string): string[] {
  const found = new Map<string, number>();
  for (const m of html.matchAll(/href="([^"]*Monthly-Review-([A-Za-z]+)(\d{4})\.pdf)"/gi)) {
    let url: URL;
    try { url = new URL(m[1], MACRO_URLS.pbs_prices); } catch { continue; }
    const mi = monthIndex(m[2]);
    if (url.protocol !== 'https:' || url.host !== PBS_HOST || mi < 0) continue;
    found.set(url.href, Number(m[3]) * 12 + mi);
  }
  return [...found].sort((a, b) => b[1] - a[1]).map(([u]) => u);
}

/** The month before today's and the one before that, as fallbacks when the page cannot be read. */
export function cpiFallbackUrls(today: string): string[] {
  const [y, m] = today.split('-').map(Number);
  return [1, 2].map((back) => { const k = y * 12 + (m - 1) - back; return cpiUrl(Math.floor(k / 12), (k % 12) + 1); });
}

/** KSE-100 panel stats → series (only what the page shows). */
export function indexStatsReadings(stats: IndexStats | null, source = MACRO_URLS.psx_home): MacroReading[] {
  if (!stats?.as_of) return [];
  const out: MacroReading[] = [];
  if (stats.one_year_pct != null) out.push({ series: 'kse100_1y_pct', as_of: stats.as_of, value: stats.one_year_pct, source });
  if (stats.ytd_pct != null) out.push({ series: 'kse100_ytd_pct', as_of: stats.as_of, value: stats.ytd_pct, source });
  return out;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function get(url: string, accept: string, fetchImpl: typeof fetch): Promise<Response> {
  const resp = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(30_000) });
  if (resp.status === 403 && /Just a moment|challenge/i.test(await resp.clone().text().catch(() => ''))) {
    throw new FetchError(`${new URL(url).host} asked for a bot check (not bypassed)`);
  }
  if (resp.status !== 200) throw new FetchError(`HTTP ${resp.status} for ${url}`);
  return resp;
}

/** The PDF's bytes, or null when the answer is not a PDF (SBP answers a missing asset with HTTP 200 and an HTML page). */
export async function pdfBytes(resp: Response): Promise<Uint8Array | null> {
  if (!/pdf/i.test(resp.headers.get('content-type') ?? '')) return null;
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF') ? bytes : null;
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  return (await extractText(pdf, { mergePages: true })).text as string;
}

async function pdfAt(url: string, fetchImpl: typeof fetch): Promise<string> {
  const bytes = await pdfBytes(await get(url, 'application/pdf', fetchImpl));
  if (!bytes) throw new FetchError(`not a PDF (the document may have moved): ${url}`);
  return pdfText(bytes);
}

/** Try a dated daily file on `today`, then one day back at a time; the first real PDF wins. */
export async function latestDatedPdf(urlFor: (day: string) => string, today: string, fetchImpl: typeof fetch): Promise<{ url: string; day: string; text: string } | null> {
  for (let back = 0; back <= MAX_STEP_BACK_DAYS; back++) {
    const day = addDays(today, -back);
    const url = urlFor(day);
    let resp: Response;
    try { resp = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf' }, signal: AbortSignal.timeout(30_000) }); } catch { continue; }
    if (resp.status !== 200) continue;
    const bytes = await pdfBytes(resp);
    if (bytes) return { url, day, text: await pdfText(bytes) };
  }
  return null;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Read every source; never throws. Each source stands alone: a failure adds one short error line and the others
 * still return. A source that yields nothing parseable is an error too (the layout may have changed).
 */
export async function fetchMacro(opts: { today?: string; fetchImpl?: typeof fetch } = {}): Promise<{ readings: MacroReading[]; errors: string[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const today = opts.today ?? pktToday();
  const readings: MacroReading[] = [];
  const errors: string[] = [];

  const sources: [string, () => Promise<MacroReading[]>][] = [
    ['t-bills', async () => parseTbills(await pdfAt(MACRO_URLS.tbills, fetchImpl), MACRO_URLS.tbills)],
    ['pib', async () => parsePib(await pdfAt(MACRO_URLS.pib, fetchImpl), MACRO_URLS.pib)],
    ['fx reserves', async () => parseForex(await pdfAt(MACRO_URLS.forex, fetchImpl), MACRO_URLS.forex)],
    ['pkr/usd', async () => {
      const f = await latestDatedPdf(m2mUrl, today, fetchImpl);
      if (!f) throw new FetchError(`no mark-to-market sheet in the ${MAX_STEP_BACK_DAYS + 1} days to ${today}`);
      return parseM2m(f.text, f.url, f.day);
    }],
    ['kibor', async () => {
      const f = await latestDatedPdf(kiborUrl, today, fetchImpl);
      if (!f) throw new FetchError(`no KIBOR sheet in the ${MAX_STEP_BACK_DAYS + 1} days to ${today}`);
      return parseKibor(f.text, f.url, f.day);
    }],
    ['cpi', async () => {
      let urls: string[] = [];
      let pageNote = '';
      try { urls = findCpiLinks(await (await get(MACRO_URLS.pbs_prices, 'text/html', fetchImpl)).text()); } catch (e) { pageNote = ` (price page: ${msg(e)})`; }
      const tried = new Set<string>();
      for (const url of [...urls.slice(0, 1), ...cpiFallbackUrls(today)]) {
        if (tried.has(url)) continue;
        tried.add(url);
        try {
          const rows = parseCpi(await pdfAt(url, fetchImpl), url);
          if (rows.length) return rows;
        } catch { /* try the next month */ }
      }
      throw new FetchError(`no readable monthly review${pageNote}`);
    }],
    ['kse-100 stats', async () => indexStatsReadings(parseIndexStats(await (await get(MACRO_URLS.psx_home, 'text/html', fetchImpl)).text()), MACRO_URLS.psx_home)],
  ];

  for (const [name, run] of sources) {
    try {
      const rows = await run();
      if (!rows.length) errors.push(`macro ${name}: nothing readable in the document (layout may have changed)`);
      readings.push(...rows);
    } catch (e) {
      errors.push(`macro ${name}: ${msg(e)}`.slice(0, 300));
    }
  }
  return { readings, errors };
}
