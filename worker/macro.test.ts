import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addDays, cpiFallbackUrls, fetchMacro, findCpiLinks, indexStatsReadings, kiborUrl, latestDatedPdf, m2mUrl, MACRO_URLS, parseCpi,
  parseForex, parseKibor, parseM2m, parsePib, parseTbills, pdfBytes, pktToday,
} from './macro.ts';
import { parseIndexStats, USER_AGENT } from './feed.ts';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** A minimal one-page PDF whose text is the given lines (so the fetch path runs through the real PDF reader). */
function tinyPdf(lines: string[]): Uint8Array<ArrayBuffer> {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = `BT /F1 10 Tf 40 760 Td ${lines.map((l, i) => `${i ? '0 -14 Td ' : ''}(${esc(l)}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(new TextEncoder().encode(out));
}
const pdfResp = (lines: string[]) => new Response(tinyPdf(lines), { status: 200, headers: { 'content-type': 'application/pdf' } });
const missingAsset = () => new Response('<!DOCTYPE html><html><head><title>State Bank of Pakistan</title></head><body>Page</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
const notFound = () => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } });

describe('macro parsers (SBP / PBS / PSX documents)', () => {
  it('reads T-bill cut-off yields and the auction date', () => {
    const src = MACRO_URLS.tbills;
    expect(parseTbills(fx('macro-tbills.txt'))).toEqual([
      { series: 'tbill_1m', as_of: '2026-10-14', value: 11.5003, source: src },
      { series: 'tbill_3m', as_of: '2026-10-14', value: 11.9999, source: src },
      { series: 'tbill_6m', as_of: '2026-10-14', value: 12.3989, source: src },
      { series: 'tbill_12m', as_of: '2026-10-14', value: 12.4999, source: src },
    ]);
    expect(parseTbills('01-Month 1 2 11.5% 11.4%')).toEqual([]); // no date, no readings
  });

  it('reads PIB cut-off yields; a tenor with no bids is skipped', () => {
    const rows = parsePib(fx('macro-pib.txt'));
    expect(rows.map((r) => [r.series, r.value])).toEqual([['pib_2y', 12.795], ['pib_3y', 12.746], ['pib_5y', 12.8998], ['pib_10y', 12.85]]);
    expect(rows.every((r) => r.as_of === '2026-10-07' && r.source === MACRO_URLS.pib)).toBe(true);
    const noTen = fx('macro-pib.txt').replace(/10-Year 25,025\.000 24,589\.779 1,207\.048 25,796\.827 98\.0643 12\.8500% 12\.8135%/, '10-Year - - -');
    expect(parsePib(noTen).map((r) => r.series)).toEqual(['pib_2y', 'pib_3y', 'pib_5y']);
  });

  it('reads every week-end FX reserves row (SBP and total, US$ million)', () => {
    const rows = parseForex(fx('macro-forex.txt'));
    expect(rows).toHaveLength(12); // six weeks x two series; month-end and fiscal-year rows are not weekly
    expect(rows.slice(-2)).toEqual([
      { series: 'fx_reserves_sbp', as_of: '2026-10-09', value: 21469.5, source: MACRO_URLS.forex },
      { series: 'fx_reserves_total', as_of: '2026-10-09', value: 26863.3, source: MACRO_URLS.forex },
    ]);
    expect(rows[0]).toMatchObject({ series: 'fx_reserves_sbp', as_of: '2026-09-04', value: 18328.2 });
  });

  it('reads the PKR/USD ready rate and KIBOR 3M offer with the printed date', () => {
    const u = m2mUrl('2026-10-16');
    expect(u).toBe('https://www.sbp.org.pk/assets/document/mark-to-market-revaluation-exchange-rate-16-october-2026.pdf');
    expect(parseM2m(fx('macro-m2m.txt'), u, '2026-10-16')).toEqual([{ series: 'pkr_usd', as_of: '2026-10-16', value: 276.9115, source: u }]);
    const k = kiborUrl('2026-10-16');
    expect(k).toBe('https://www.sbp.org.pk/assets/document/kibor-rates-16-october-2026.pdf');
    expect(parseKibor(fx('macro-kibor.txt'), k, '2026-10-16')).toEqual([{ series: 'kibor_3m', as_of: '2026-10-16', value: 12.01, source: k }]);
  });

  it('reads CPI year-on-year inflation, including a decrease', () => {
    const src = 'https://www.pbs.gov.pk/wp-content/uploads/2020/07/Monthly-Review-September2026.pdf';
    expect(parseCpi(fx('macro-cpi.txt'), src)).toEqual([{ series: 'cpi_yoy', as_of: '2026-09-01', value: 10.3, source: src }]);
    expect(parseCpi('1. CPI inflation General, decreased by 1.2% on year-on-year basis in May 2024 as compared', src)).toEqual([{ series: 'cpi_yoy', as_of: '2024-05-01', value: -1.2, source: src }]);
    expect(parseCpi('nothing', src)).toEqual([]);
  });

  it('finds the monthly review link on the PBS page (PBS host only) and builds fallbacks', () => {
    expect(findCpiLinks(fx('macro-pbs-prices.html'))).toEqual(['https://www.pbs.gov.pk/wp-content/uploads/2020/07/Monthly-Review-September2026.pdf']);
    expect(findCpiLinks('<a href="https://evil.example/Monthly-Review-May2026.pdf">x</a>')).toEqual([]);
    expect(cpiFallbackUrls('2026-01-05')).toEqual([
      'https://www.pbs.gov.pk/wp-content/uploads/2020/07/Monthly-Review-December2025.pdf',
      'https://www.pbs.gov.pk/wp-content/uploads/2020/07/Monthly-Review-November2025.pdf',
    ]);
  });

  it('reads the KSE-100 1-year and YTD change from the PSX home page panel', () => {
    const stats = parseIndexStats(fx('home.html'));
    expect(stats).toEqual({ as_of: '2026-10-05', one_year_pct: -1.85, ytd_pct: -4.7, high_52w: 191032.7344, low_52w: 144119.4395 });
    expect(indexStatsReadings(stats)).toEqual([
      { series: 'kse100_1y_pct', as_of: '2026-10-05', value: -1.85, source: MACRO_URLS.psx_home },
      { series: 'kse100_ytd_pct', as_of: '2026-10-05', value: -4.7, source: MACRO_URLS.psx_home },
    ]);
    expect(parseIndexStats('<p>no panel</p>')).toBeNull();
  });

  it('dates: PKT today and stepping back across a month end', () => {
    expect(pktToday(Date.UTC(2026, 9, 17, 20, 0))).toBe('2026-10-18'); // 01:00 PKT next day
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });
});

describe('macro fetching', () => {
  it('rejects the HTML page SBP returns with HTTP 200 for a missing asset', async () => {
    expect(await pdfBytes(missingAsset())).toBeNull();
    expect(await pdfBytes(new Response('<html>', { status: 200, headers: { 'content-type': 'application/pdf' } }))).toBeNull();
    expect(await pdfBytes(pdfResp(['x']))).not.toBeNull();
  });

  it('steps back over a weekend to the last dated sheet', async () => {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      return url === m2mUrl('2026-10-16') ? pdfResp(['16-Oct-26', 'CURRENCY READY 1-WEEK', 'USD 276.9115 277.1633']) : missingAsset();
    }) as unknown as typeof fetch;
    const f = await latestDatedPdf(m2mUrl, '2026-10-18', fake);
    expect(asked).toEqual([m2mUrl('2026-10-18'), m2mUrl('2026-10-17'), m2mUrl('2026-10-16')]);
    expect(f && parseM2m(f.text, f.url, f.day)).toEqual([{ series: 'pkr_usd', as_of: '2026-10-16', value: 276.9115, source: m2mUrl('2026-10-16') }]);
    expect(await latestDatedPdf(m2mUrl, '2026-10-18', (async () => missingAsset()) as unknown as typeof fetch)).toBeNull();
  });

  it('never throws: each source stands alone, failures are short error lines, the honest UA is sent', async () => {
    const uas = new Set<string | null>();
    const fake = (async (url: string, init?: RequestInit) => {
      uas.add(new Headers(init?.headers).get('User-Agent'));
      if (url === MACRO_URLS.tbills) return pdfResp(fx('macro-tbills.txt').split('\n'));
      if (url === MACRO_URLS.forex) throw new Error('socket hang up');
      if (url === MACRO_URLS.pbs_prices) return new Response(fx('macro-pbs-prices.html'), { status: 200, headers: { 'content-type': 'text/html' } });
      if (url.includes('Monthly-Review-September2026')) return pdfResp(fx('macro-cpi.txt').split('\n'));
      if (url.includes('pbs.gov.pk')) return notFound();
      if (url === MACRO_URLS.psx_home) return new Response(fx('home.html'), { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === kiborUrl('2026-10-16')) return pdfResp(fx('macro-kibor.txt').split('\n'));
      return missingAsset(); // PIB moved, no M2M sheet at all
    }) as unknown as typeof fetch;
    const { readings, errors } = await fetchMacro({ today: '2026-10-18', fetchImpl: fake });
    expect([...uas]).toEqual([USER_AGENT]);
    expect(readings.map((r) => r.series).sort()).toEqual(['cpi_yoy', 'kibor_3m', 'kse100_1y_pct', 'kse100_ytd_pct', 'tbill_12m', 'tbill_1m', 'tbill_3m', 'tbill_6m']);
    expect(readings.find((r) => r.series === 'tbill_3m')).toMatchObject({ as_of: '2026-10-14', value: 11.9999 });
    expect(readings.find((r) => r.series === 'cpi_yoy')).toMatchObject({ as_of: '2026-09-01', value: 10.3 });
    expect(errors).toHaveLength(3);
    expect(errors.find((e) => e.startsWith('macro pib'))).toMatch(/not a PDF/);
    expect(errors.find((e) => e.startsWith('macro fx reserves'))).toMatch(/socket hang up/);
    expect(errors.find((e) => e.startsWith('macro pkr/usd'))).toMatch(/no mark-to-market sheet/);
  });
});
