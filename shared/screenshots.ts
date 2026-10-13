/**
 * Read a broker portfolio from screenshots (JS InvestPro or similar) with a vision model.
 * Runs server-side (Cloudflare Worker); images are only held in memory for the request, never stored.
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

export async function readPortfolioScreenshots(ai: LlmRouter, images: { mime: string; base64: string }[]):
  Promise<{ rows: ImportedRow[]; dropped: string[]; isPortfolio: boolean; model: string }> {
  const { data, model } = await ai.json<any>('vision',
    'You read screenshots of a Pakistan Stock Exchange broker app portfolio. Copy each holding exactly as shown. Never guess a value you cannot read; skip that row instead.',
    [
      ...images.map((i) => ({ image: i })),
      { text: 'Extract every holding row: ticker symbol, quantity held, and AVERAGE cost per share (not the current market price, not total value). The images may overlap; list each symbol once.' },
    ], SCHEMA);
  const { rows, dropped } = cleanImported(Array.isArray(data?.holdings) ? data.holdings : []);
  return { rows, dropped, isPortfolio: data?.is_portfolio !== false, model };
}
