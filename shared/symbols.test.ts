import { describe, expect, it } from 'vitest';
import { EX_MARKERS, baseSymbol, canonicalSymbol, dedupeBySymbol, exLabel, normalisePriceMap, normaliseWatchSymbol, splitSymbol } from './symbols.ts';
import { DEFAULT_RULES } from './types.ts';
import type { Holding, Price, PriceMap } from './types.ts';

const price = (symbol: string, over: Partial<Price> = {}): Price => ({
  symbol, name: null, sector: null, price: null, change: null, change_pct: null, volume: null, ldcp: null,
  high_52w: null, low_52w: null, dividend_yield_pct: null, pe: null, is_shariah: null, as_of: null, ...over,
});

describe('splitSymbol', () => {
  it('splits the examples from the spec', () => {
    expect(splitSymbol('APLXD')).toEqual({ base: 'APL', ex: 'XD' });
    expect(splitSymbol('HUBC')).toEqual({ base: 'HUBC', ex: null });
    expect(splitSymbol('APLXBR')).toEqual({ base: 'APL', ex: 'XBXR' }); // compact form, normalised
    expect(splitSymbol('HUBCXB')).toEqual({ base: 'HUBC', ex: 'XB' });
    expect(splitSymbol('HUBCXR')).toEqual({ base: 'HUBC', ex: 'XR' });
    expect(splitSymbol('LUCKXDXB')).toEqual({ base: 'LUCK', ex: 'XDXB' });
    expect(splitSymbol('LUCKXDXR')).toEqual({ base: 'LUCK', ex: 'XDXR' });
    expect(splitSymbol('LUCKXBXR')).toEqual({ base: 'LUCK', ex: 'XBXR' });
    expect(splitSymbol('LUCKXDXBXR')).toEqual({ base: 'LUCK', ex: 'XDXBXR' });
  });

  it('upper-cases and trims, and puts markers in the fixed order XD, XB, XR without repeats', () => {
    expect(splitSymbol('  aplxd ')).toEqual({ base: 'APL', ex: 'XD' });
    expect(splitSymbol('hubc')).toEqual({ base: 'HUBC', ex: null });
    expect(splitSymbol('MEBLXRXD')).toEqual({ base: 'MEBL', ex: 'XDXR' });
    expect(splitSymbol('MEBLXRXBXD')).toEqual({ base: 'MEBL', ex: 'XDXBXR' });
    expect(splitSymbol('MEBLXDBR')).toEqual({ base: 'MEBL', ex: 'XDXBXR' }); // one X, three letters
    expect(splitSymbol('MEBLXDXD')).toEqual({ base: 'MEBL', ex: 'XD' });
  });

  it('never leaves fewer than 2 characters, and never strips a symbol that is only markers', () => {
    expect(splitSymbol('AXD')).toEqual({ base: 'AXD', ex: null });
    expect(splitSymbol('ABXD')).toEqual({ base: 'AB', ex: 'XD' });
    expect(splitSymbol('XD')).toEqual({ base: 'XD', ex: null });
    expect(splitSymbol('XDXB')).toEqual({ base: 'XDXB', ex: null }); // not "XD" ex "XB"
    expect(splitSymbol('XBR')).toEqual({ base: 'XBR', ex: null });
    expect(splitSymbol('')).toEqual({ base: '', ex: null });
    expect(splitSymbol('   ')).toEqual({ base: '', ex: null });
    // Backs off group by group: stripping all of "XBXD" would leave "A", so only the last group goes.
    expect(splitSymbol('AXBXD')).toEqual({ base: 'AXB', ex: 'XD' });
    // A single compact group cannot be shortened, so nothing is stripped.
    expect(splitSymbol('AXDBR')).toEqual({ base: 'AXDBR', ex: null });
  });

  it('leaves an X that is not followed by a marker letter alone', () => {
    expect(splitSymbol('NEXT')).toEqual({ base: 'NEXT', ex: null });
    expect(splitSymbol('ABXXD')).toEqual({ base: 'ABX', ex: 'XD' });
    expect(splitSymbol('EXIDE')).toEqual({ base: 'EXIDE', ex: null });
  });

  it('with `known`, protects a real symbol that happens to end in a marker', () => {
    const known = ['FOXB', 'APL', 'HUBC'];
    expect(splitSymbol('FOXB', known)).toEqual({ base: 'FOXB', ex: null }); // listed itself, "FO" is not
    expect(splitSymbol('foxb ', new Set(known))).toEqual({ base: 'FOXB', ex: null }); // any iterable, any case
    expect(splitSymbol('APLXD', known)).toEqual({ base: 'APL', ex: 'XD' }); // APLXD not listed: a marked APL
    expect(splitSymbol('HUBCXDXB', known)).toEqual({ base: 'HUBC', ex: 'XDXB' });
    expect(splitSymbol('OGDCXD', known)).toEqual({ base: 'OGDC', ex: 'XD' }); // neither listed: still stripped
  });

  it('with `known`, keeps a listed base whole and reads only what PSX appended to it', () => {
    // FOXB is the listed symbol and XD / XR its pending action: the base is FOXB, never an invented "FO".
    expect(splitSymbol('FOXBXD', ['FOXB'])).toEqual({ base: 'FOXB', ex: 'XD' });
    expect(splitSymbol('FOXBXR', ['FOXB'])).toEqual({ base: 'FOXB', ex: 'XR' });
    expect(splitSymbol('FOXBXDXR', ['FOXB'])).toEqual({ base: 'FOXB', ex: 'XDXR' });
    expect(splitSymbol(' foxbxd', new Set(['FOXB']))).toEqual({ base: 'FOXB', ex: 'XD' });
    // The listed base is enough on its own; the marked form need not be listed too.
    expect(splitSymbol('FOXBXD', ['FOXB', 'FOXBXD'])).toEqual({ base: 'FOXB', ex: 'XD' });
    // When more than one cut lands on a listed symbol the longest base wins.
    expect(splitSymbol('FOXBXD', ['FO', 'FOXB'])).toEqual({ base: 'FOXB', ex: 'XD' });
    // Without `known` the same symbol is stripped greedily: that is exactly what `known` is for.
    expect(splitSymbol('FOXBXD')).toEqual({ base: 'FO', ex: 'XDXB' });
    expect(splitSymbol('FOXBXD', ['APL'])).toEqual({ base: 'FO', ex: 'XDXB' }); // a list without FOXB cannot help
  });

  it('with `known`, strips when both the marked and the base symbol are listed (the screen shows both)', () => {
    expect(splitSymbol('APLXD', ['APL', 'APLXD'])).toEqual({ base: 'APL', ex: 'XD' });
    // Only the marked form is listed and the base is not: it is treated as a real symbol and kept whole.
    expect(splitSymbol('APLXD', ['APLXD'])).toEqual({ base: 'APLXD', ex: null });
    // Backs off to the longest base that is listed.
    expect(splitSymbol('APLXDXB', ['APLXD', 'APLXDXB'])).toEqual({ base: 'APLXD', ex: 'XB' });
    expect(splitSymbol('FOXB', [])).toEqual({ base: 'FO', ex: 'XB' }); // an empty list protects nothing
  });
});

describe('baseSymbol', () => {
  it('is the base of splitSymbol and is idempotent', () => {
    const symbols = ['APLXD', 'HUBC', 'APLXBR', 'AXBXD', 'AXD', 'XDXB', 'MEBLXRXBXD', 'ABXXD', 'foxb', '', 'LUCKXDXBXR'];
    for (const s of symbols) expect(baseSymbol(baseSymbol(s))).toBe(baseSymbol(s));
    expect(baseSymbol('HUBCXD')).toBe('HUBC');
    expect(baseSymbol('FOXB', ['FOXB'])).toBe('FOXB');
    expect(baseSymbol(baseSymbol('FOXB', ['FOXB']), ['FOXB'])).toBe('FOXB');
    expect(baseSymbol('FOXBXD', ['FOXB'])).toBe('FOXB');
    expect(baseSymbol(baseSymbol('FOXBXD', ['FOXB']), ['FOXB'])).toBe('FOXB');
  });
});

describe('exLabel', () => {
  it('names each marker in plain English, combined with commas', () => {
    expect(exLabel('XD')).toBe('ex-dividend');
    expect(exLabel('XB')).toBe('ex-bonus');
    expect(exLabel('XR')).toBe('ex-right');
    expect(exLabel('XDXB')).toBe('ex-dividend, ex-bonus');
    expect(exLabel('XDXBXR')).toBe('ex-dividend, ex-bonus, ex-right');
    expect(exLabel('xbr')).toBe('ex-bonus, ex-right'); // compact and lower case still read
    expect(exLabel('XRXD')).toBe('ex-dividend, ex-right'); // fixed order regardless of input order
  });

  it('is null for nothing or for text that is not markers', () => {
    expect(exLabel(null)).toBeNull();
    expect(exLabel(undefined)).toBeNull();
    expect(exLabel('')).toBeNull();
    expect(exLabel('APL')).toBeNull();
    expect(exLabel('XDZ')).toBeNull();
  });

  it('labels every marker in the table', () => {
    for (const m of EX_MARKERS) expect(exLabel(m.code)).toBe(m.label);
  });
});

describe('dedupeBySymbol', () => {
  it('keeps the richer row, names it by the base and flags the marker', () => {
    const apl = price('APL', { price: 400, pe: 5.2, dividend_yield_pct: 8 }); // 3 filled fields
    const aplxd = price('APLXD', { price: 395 }); // 1 filled field
    const out = dedupeBySymbol([apl, aplxd]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: 'APL', ex: 'XD', price: 400, pe: 5.2, dividend_yield_pct: 8 });
  });

  it('keeps the marked row\'s data when it is the richer one', () => {
    const apl = price('APL', { price: 400 });
    const aplxd = price('APLXD', { price: 395, pe: 5.1, name: 'Attock Petroleum' });
    expect(dedupeBySymbol([apl, aplxd])[0]).toMatchObject({ symbol: 'APL', ex: 'XD', price: 395, pe: 5.1, name: 'Attock Petroleum' });
  });

  it('on a tie keeps the marked row, whichever came first', () => {
    const a = price('HUBC', { price: 100, pe: 4 });
    const b = price('HUBCXD', { price: 98, pe: 4 });
    expect(dedupeBySymbol([a, b])[0]).toMatchObject({ symbol: 'HUBC', ex: 'XD', price: 98 });
    expect(dedupeBySymbol([b, a])[0]).toMatchObject({ symbol: 'HUBC', ex: 'XD', price: 98 });
  });

  it('on a tie between two unmarked copies keeps the later one', () => {
    const old = price('SYS', { price: 120 });
    const fresh = price('SYS', { price: 125 });
    const out = dedupeBySymbol([old, fresh]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(fresh); // the same object: nothing to change
    expect(out[0].ex).toBeUndefined();
  });

  it('keeps input order for the survivors and leaves untouched rows as the same objects', () => {
    const sys = price('SYS', { price: 120 });
    const apl = price('APL', { price: 400 });
    const mebl = price('MEBL', { price: 548 });
    const aplxd = price('APLXD', { price: 395, pe: 5 }); // richer, so it survives at its own position (last)
    const out = dedupeBySymbol([sys, apl, mebl, aplxd]);
    expect(out.map((r) => r.symbol)).toEqual(['SYS', 'MEBL', 'APL']);
    expect(out[0]).toBe(sys);
    expect(out[1]).toBe(mebl);
    expect(out[2]).toMatchObject({ ex: 'XD', price: 395 });
  });

  it('combines markers from several rows and from an `ex` a row already carries', () => {
    const out = dedupeBySymbol([price('LUCKXD', { price: 1 }), price('LUCKXB', { price: 1 })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: 'LUCK', ex: 'XDXB' });
    const already = dedupeBySymbol([price('LUCK', { price: 1, ex: 'XR' }), price('LUCKXD', { price: 2, pe: 3 })]);
    expect(already[0]).toMatchObject({ symbol: 'LUCK', ex: 'XDXR', price: 2 });
  });

  it('cleans a lone marked or untidy symbol without a partner', () => {
    const out = dedupeBySymbol([price('hubcxd ', { price: 100 })]);
    expect(out[0]).toMatchObject({ symbol: 'HUBC', ex: 'XD', price: 100 });
    const lower = dedupeBySymbol([price('ogdc', { price: 200 })]);
    expect(lower[0].symbol).toBe('OGDC');
    expect(lower[0].ex).toBeUndefined(); // no marker: the ex key is not added
  });

  it('handles empty input and rows with any shape, such as holdings', () => {
    expect(dedupeBySymbol([])).toEqual([]);
    const h: Holding[] = [
      { symbol: 'HUBCXD', shares: 100, avg_cost: 95, status: 'core', sector: null, is_shariah: false },
      { symbol: 'SYS', shares: 10, avg_cost: 1200, status: 'core', sector: 'TECHNOLOGY & COMMUNICATION', is_shariah: true },
    ];
    const out = dedupeBySymbol(h);
    expect(out.map((r) => r.symbol)).toEqual(['HUBC', 'SYS']);
    expect(out[0]).toMatchObject({ shares: 100, avg_cost: 95 });
    expect(out[1]).toBe(h[1]);
  });

  it('passes `known` through so a real symbol ending in a marker is not merged', () => {
    const rows = [price('FOXB', { price: 10 }), price('FO', { price: 20 })];
    expect(dedupeBySymbol(rows).map((r) => r.symbol)).toEqual(['FO']); // greedy: FOXB folds into FO
    expect(dedupeBySymbol(rows, ['FOXB']).map((r) => r.symbol)).toEqual(['FOXB', 'FO']); // FOXB listed, FO not
    expect(dedupeBySymbol(rows, ['FOXB', 'FO']).map((r) => r.symbol)).toEqual(['FO']); // both listed: a marked FO
  });

  it('with `known`, merges a listed symbol with its marked form instead of folding both into a shorter name', () => {
    const rows = [price('FOXB', { price: 10 }), price('FOXBXD', { price: 9, pe: 3 })]; // 1 and 2 filled fields
    const out = dedupeBySymbol(rows, ['FOXB']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: 'FOXB', ex: 'XD', price: 9, pe: 3 });
    // Without `known` both rows become a marked "FO": a company that does not exist.
    expect(dedupeBySymbol(rows)[0]).toMatchObject({ symbol: 'FO', ex: 'XDXB', price: 9 });
  });
});

describe('normalisePriceMap', () => {
  it('re-keys by base symbol and sets ex on the kept row', () => {
    const map: PriceMap = {
      APLXD: price('APLXD', { price: 395, pe: 5 }),
      APL: price('APL', { price: 400 }),
      HUBC: price('HUBC', { price: 100 }),
    };
    const out = normalisePriceMap(map);
    expect(Object.keys(out).sort()).toEqual(['APL', 'HUBC']);
    expect(out.APL).toMatchObject({ symbol: 'APL', ex: 'XD', price: 395, pe: 5 });
    expect(out.HUBC).toBe(map.HUBC);
    expect(out.APLXD).toBeUndefined();
  });

  it('upper-cases keys, takes the key when a row has a blank symbol, and honours `known`', () => {
    const out = normalisePriceMap({ hubcxd: price('', { price: 100 }), foxb: price('FOXB', { price: 10 }) }, ['FOXB']);
    expect(Object.keys(out).sort()).toEqual(['FOXB', 'HUBC']);
    expect(out.HUBC).toMatchObject({ symbol: 'HUBC', ex: 'XD', price: 100 });
    expect(out.FOXB).toMatchObject({ symbol: 'FOXB', price: 10 });
    expect(normalisePriceMap({})).toEqual({});
    // A listed symbol and its marked form share one key, the listed one.
    const marked = normalisePriceMap({ FOXB: price('FOXB', { price: 10 }), FOXBXD: price('FOXBXD', { price: 9 }) }, ['FOXB']);
    expect(Object.keys(marked)).toEqual(['FOXB']);
    expect(marked.FOXB).toMatchObject({ symbol: 'FOXB', ex: 'XD', price: 9 }); // tie on fields: the marked row is newer
  });

  it('is idempotent: normalising twice changes nothing', () => {
    const once = normalisePriceMap({ APLXD: price('APLXD', { price: 395 }), APL: price('APL', { price: 400, pe: 5 }) });
    expect(normalisePriceMap(once)).toEqual(once);
    expect(once.APL).toMatchObject({ ex: 'XD', price: 400, pe: 5 });
  });
});

describe('canonical symbols', () => {
  it('normaliseWatchSymbol', () => {
    expect(normaliseWatchSymbol('ogdcl xd')).toBe('OGDC'); // lower case, a space, an ex marker and the long form
    expect(normaliseWatchSymbol(' ogdcl ')).toBe('OGDC');
    expect(normaliseWatchSymbol('OGDCXD')).toBe('OGDC');
    expect(normaliseWatchSymbol('hubc')).toBe('HUBC');
    expect(normaliseWatchSymbol('MEBLXDXB')).toBe('MEBL');
    expect(normaliseWatchSymbol('')).toBe('');
    expect(canonicalSymbol('psx:luck')).toBe('LUCK'); // stray punctuation and an exchange prefix are dropped
  });
  it('the alias map is a setting, and a listed symbol that ends in a marker is kept whole', () => {
    const rules = { ...DEFAULT_RULES, symbols: { ...DEFAULT_RULES.symbols, aliases: { ...DEFAULT_RULES.symbols.aliases, ENGRO: 'ENGROH' } } };
    expect(canonicalSymbol('engro', undefined, rules)).toBe('ENGROH');
    expect(canonicalSymbol('FOXBXD', ['FOXB'])).toBe('FOXB');
  });
});
