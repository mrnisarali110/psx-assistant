/**
 * Read a broker portfolio from screenshots (JS InvestPro or similar) with a vision model.
 * Runs server-side (Cloudflare Worker); images are only held in memory for the request, never stored.
 * The symbols already in the portfolio go along as hints, so a smudged "O" vs "0" lands on the right
 * stock; quantities and costs are still read from the picture, never copied from the hints.
 */
import type { LlmRouter } from './llm.ts';
import { cleanImported, type ImportedRow } from './changes.ts';

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_portfolio: { type: 'BOOLEAN', description: 'true only if the images show a stock portfolio/holdings list' },
    holdings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'PSX ticker exactly as shown, e.g. SYS, MEBL' },
          shares: { type: 'INTEGER', description: 'Quantity / volume held' },
          avg_cost: { type: 'NUMBER', description: 'Average buy price / cost per share in rupees (not market price)' },
        },
        required: ['symbol', 'shares', 'avg_cost'],
      },
    },
  },
  required: ['is_portfolio', 'holdings'],
};

export const MAX_KNOWN_SYMBOLS = 60;

/** Only clean tickers, deduplicated, capped: this text goes into the prompt. */
export function cleanKnownSymbols(known: unknown): string[] {
  if (!Array.isArray(known)) return [];
  const out = new Set<string>();
  for (const k of known) {
    const s = String(k ?? '').toUpperCase().trim();
    if (/^[A-Z0-9]{1,12}$/.test(s)) out.add(s);
    if (out.size >= MAX_KNOWN_SYMBOLS) break;
  }
  return [...out].sort();
}

export function importParts(images: { mime: string; base64: string }[], known: string[] = []) {
  const hint = known.length
    ? ` The investor already holds these symbols: ${known.join(', ')}. If a symbol in the picture looks almost like one of them (O vs 0, I vs 1), use the known symbol. Holdings not in that list are fine too; include them. Quantities and average costs must come from the picture: do not assume they are unchanged.`
    : '';
  return [
    ...images.map((i) => ({ image: i })),
    { text: `Extract every holding row: ticker symbol, quantity held, and AVERAGE cost per share (not the current market price, not total value). The images may overlap; list each symbol once.${hint}` },
  ];
}

/** An answer worth keeping: a portfolio with at least one clean row. Anything else sends the router to the next model / provider. */
export const usableRead = (data: any) => data?.is_portfolio !== false && cleanImported(Array.isArray(data?.holdings) ? data.holdings : []).rows.length > 0;

export async function readPortfolioScreenshots(ai: LlmRouter, images: { mime: string; base64: string }[], opts: { known?: string[] } = {}):
  Promise<{ rows: ImportedRow[]; dropped: string[]; isPortfolio: boolean; model: string }> {
  const { data, model } = await ai.json<any>('vision',
    'You read screenshots of a Pakistan Stock Exchange broker app portfolio. Copy each holding exactly as shown. Never guess a value you cannot read; skip that row instead.',
    importParts(images, opts.known), SCHEMA, { accept: usableRead });
  const { rows, dropped } = cleanImported(Array.isArray(data?.holdings) ? data.holdings : []);
  return { rows, dropped, isPortfolio: data?.is_portfolio !== false, model };
}
