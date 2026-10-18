/**
 * State Bank of Pakistan policy rate, read politely from SBP's own public documents (honest User-Agent, two requests
 * a night):
 *   - the history PDF "SBP's Reverse Repo, Repo and Policy (Target) Rates" (every decision since 1991), and
 *   - the monetary policy page (the rate in force now, and the latest meeting's sentence when SBP shows it).
 * Before 25 May 2015 SBP's policy rate was the reverse repo (ceiling) rate (footnote 1 of the PDF), so that column is
 * used for older rows. Nothing here is a hardcoded rate.
 */
import { getDocumentProxy } from 'unpdf';
import type { PolicyRate } from '../shared/regime.ts';
import { DEFAULT_RULES, type Rules } from '../shared/types.ts';
import { FetchError, USER_AGENT } from './feed.ts';

export interface PdfItem { page: number; x: number; y: number; str: string }

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** "28-Apr-26" → "2026-04-28"; two-digit years from 70 on are 19xx (the table starts in 1991). */
export function sbpDate(text: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(text.trim());
  const mm = m && MONTHS[m[2].toLowerCase()];
  if (!m || !mm) return null;
  const yy = Number(m[3]);
  return `${yy >= 70 ? 1900 + yy : 2000 + yy}-${mm}-${m[1].padStart(2, '0')}`;
}

/**
 * Rebuild the table from positioned text: a row is the items on one line of a page; each % value belongs to the
 * column whose header is nearest on the x axis. Text extraction alone scrambles the columns, so positions are needed.
 */
export function parseRateHistory(items: PdfItem[]): PolicyRate[] {
  const out: PolicyRate[] = [];
  for (const page of [...new Set(items.map((i) => i.page))]) {
    const onPage = items.filter((i) => i.page === page && i.str.trim());
    const head = (re: RegExp) => onPage.find((i) => re.test(i.str))?.x ?? null;
    const cols = [
      { key: 'ceiling', x: head(/Reverse Repo/i) }, { key: 'floor', x: head(/^Repo \(Floor\)/i) }, { key: 'policy', x: head(/Policy \(Target\)/i) },
    ].filter((c): c is { key: string; x: number } => c.x != null);
    if (!cols.length) continue;
    const lines: PdfItem[][] = [];
    for (const it of [...onPage].sort((a, b) => b.y - a.y)) {
      const line = lines.find((l) => Math.abs(l[0].y - it.y) <= 2);
      if (line) line.push(it); else lines.push([it]);
    }
    for (const line of lines) {
      const cells = [...line].sort((a, b) => a.x - b.x);
      const day = sbpDate(cells[0].str);
      if (!day) continue;
      const v: Record<string, number> = {};
      for (const c of cells.slice(1)) {
        const m = /^(\d+(?:\.\d+)?)%$/.exec(c.str.trim());
        if (!m) continue;
        const col = cols.reduce((best, k) => (Math.abs(k.x - c.x) < Math.abs(best.x - c.x) ? k : best));
        v[col.key] = Number(m[1]);
      }
      const policy = v.policy ?? v.ceiling;
      if (policy == null) continue;
      out.push({ decided_on: day, policy_rate: policy, ceiling: v.ceiling ?? null, floor: v.floor ?? null, source: 'sbp_history_pdf' });
    }
  }
  return out.sort((a, b) => a.decided_on.localeCompare(b.decided_on));
}

export async function pdfItems(bytes: Uint8Array): Promise<PdfItem[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: PdfItem[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    for (const it of tc.items as { str?: string; transform?: number[] }[]) {
      if (it.str && it.transform) out.push({ page: p, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), str: it.str });
    }
  }
  return out;
}

const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * The monetary policy page: the rate in the "SBP Policy Rate" box, and the latest decision sentence when present
 * ("... kept the policy rate unchanged at 11.5% in its meeting held on 14 September, 2026").
 */
export function parseRatePage(html: string): { rate: number | null; meeting: { day: string; rate: number } | null } {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const box = /SBP Policy Rate\s+(\d+(?:\.\d+)?)\s*%/i.exec(text);
  const m = /policy rate[^.%]{0,60}?(?:at|to)\s+(\d+(?:\.\d+)?)\s*%[^.]{0,80}?held on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i.exec(text);
  const month = m ? FULL_MONTHS.indexOf(m[3].toLowerCase()) : -1;
  return {
    rate: box ? Number(box[1]) : null,
    meeting: m && month >= 0 ? { day: `${m[4]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`, rate: Number(m[1]) } : null,
  };
}

/** History plus the latest meeting from the page (only when it is newer than the PDF's last row). */
export function mergeRates(history: PolicyRate[], page: ReturnType<typeof parseRatePage>): PolicyRate[] {
  const out = [...history];
  const last = out.at(-1);
  if (page.meeting && (!last || page.meeting.day > last.decided_on)) {
    out.push({ decided_on: page.meeting.day, policy_rate: page.meeting.rate, ceiling: null, floor: null, source: 'sbp_page' });
  }
  return out;
}

async function get(url: string, accept: string, fetchImpl: typeof fetch): Promise<Response> {
  const resp = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(30_000) });
  if (resp.status !== 200) throw new FetchError(`GET ${url} failed: HTTP ${resp.status}`);
  return resp;
}

/** Fetch both SBP documents. The page is a bonus: if it fails the PDF still counts; if the PDF fails, nothing is saved. */
export async function fetchPolicyRates(rules: Rules = DEFAULT_RULES, fetchImpl: typeof fetch = fetch): Promise<{ rates: PolicyRate[]; page_rate: number | null; errors: string[] }> {
  const src = rules.regime.rate_sources;
  const errors: string[] = [];
  const resp = await get(src.history_pdf, 'application/pdf', fetchImpl);
  if (!/pdf/i.test(resp.headers.get('content-type') ?? '')) throw new FetchError('SBP rate history is not a PDF (the link may have moved)');
  const history = parseRateHistory(await pdfItems(new Uint8Array(await resp.arrayBuffer())));
  if (history.length < 10) throw new FetchError(`SBP rate history: only ${history.length} rows read`);
  let page: ReturnType<typeof parseRatePage> = { rate: null, meeting: null };
  try {
    page = parseRatePage(await (await get(src.current_page, 'text/html', fetchImpl)).text());
  } catch (e) {
    errors.push(`sbp page: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rates = mergeRates(history, page);
  // The box on the page is the rate in force now: if it disagrees with the newest row, say so (a decision we missed).
  if (page.rate != null && rates.at(-1)!.policy_rate !== page.rate) errors.push(`sbp: page shows ${page.rate}% but the history ends at ${rates.at(-1)!.policy_rate}%`);
  return { rates, page_rate: page.rate, errors };
}
