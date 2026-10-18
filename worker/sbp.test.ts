import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchPolicyRates, mergeRates, parseRateHistory, parseRatePage, sbpDate, type PdfItem } from './sbp.ts';
import snapshot from '../shared/sbp-policy-rates.json' with { type: 'json' };

const items = JSON.parse(readFileSync(new URL('./fixtures/sbp-rate-items.json', import.meta.url), 'utf8')) as PdfItem[];
const home = readFileSync(new URL('./fixtures/sbp_home_trimmed.html', import.meta.url), 'utf8');

describe('State Bank policy rate', () => {
  it('reads dates as SBP writes them', () => {
    expect(sbpDate('26-Feb-91')).toBe('1991-02-26');
    expect(sbpDate('28-Apr-26')).toBe('2026-04-28');
    expect(sbpDate('Date')).toBeNull();
  });

  it('rebuilds the history table from positioned PDF text (columns by x position)', () => {
    const rows = parseRateHistory(items);
    expect(rows).toHaveLength(89);
    expect(rows[0]).toEqual({ decided_on: '1991-02-26', policy_rate: 10, ceiling: 10, floor: null, source: 'sbp_history_pdf' });
    // Before 25 May 2015 the reverse repo was the policy rate; from then on the Policy (Target) Rate column.
    expect(rows.find((r) => r.decided_on === '2015-03-24')).toMatchObject({ policy_rate: 8, ceiling: 8, floor: 5.5 });
    expect(rows.find((r) => r.decided_on === '2015-05-25')).toMatchObject({ policy_rate: 6.5, ceiling: 7, floor: 5 });
    expect(rows.at(-1)).toEqual({ decided_on: '2026-04-28', policy_rate: 11.5, ceiling: 12.5, floor: 10.5, source: 'sbp_history_pdf' });
    expect(rows).toEqual(snapshot); // the demo snapshot is exactly what the parser reads
  });

  it('reads the rate box and the latest meeting from the home page', () => {
    expect(parseRatePage(home)).toEqual({ rate: 11.5, meeting: { day: '2026-09-14', rate: 11.5 } });
    expect(parseRatePage('<p>nothing here</p>')).toEqual({ rate: null, meeting: null });
  });

  it('adds the page meeting only when it is newer than the PDF', () => {
    const h = parseRateHistory(items);
    expect(mergeRates(h, { rate: 11.5, meeting: { day: '2026-09-14', rate: 11.5 } }).at(-1)).toMatchObject({ decided_on: '2026-09-14', source: 'sbp_page' });
    expect(mergeRates(h, { rate: 11.5, meeting: { day: '2026-04-28', rate: 11.5 } })).toHaveLength(89);
  });

  it('refuses an answer that is not a PDF (the link moved)', async () => {
    const html = async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(fetchPolicyRates(undefined, html as unknown as typeof fetch)).rejects.toThrow(/not a PDF/);
  });
});
