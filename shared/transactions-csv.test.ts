import { describe, expect, it } from 'vitest';
import { TXN_CSV_TEMPLATE, dedupeTxns, parseTxnCsv, txnsToCsv } from './transactions-csv.ts';
import type { Txn } from './types.ts';

const HEADER = 'date,symbol,side,shares,price,charges';
const MEBL: Txn = { symbol: 'MEBL', side: 'buy', shares: 8, price: 548.11, amount: 4384.88, executed_on: '2026-10-06', source: 'csv', charges: 9.45 };
const txn = (executed_on: string, symbol: string, side: Txn['side'], shares: number, price: number, over: Partial<Txn> = {}): Txn =>
  ({ symbol, side, shares, price, amount: Math.round(shares * price * 100) / 100, executed_on, source: 'csv', charges: null, ...over });

describe('TXN_CSV_TEMPLATE', () => {
  it('starts with the header in the documented order', () => {
    expect(TXN_CSV_TEMPLATE.split('\n')[0]).toBe(HEADER);
  });

  it('parses to 2 rows with no errors, charges blank on the second', () => {
    const { rows, errors } = parseTxnCsv(TXN_CSV_TEMPLATE);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(MEBL);
    expect(rows[1]).toEqual({ symbol: 'SYS', side: 'sell', shares: 10, price: 120.5, amount: 1205, executed_on: '2026-09-22', source: 'csv', charges: null });
  });
});

describe('parseTxnCsv', () => {
  it('accepts semicolons, quoted cells, CRLF and a BOM', () => {
    const text = '﻿date;symbol;side;shares;price;charges\r\n"2026-10-06";"MEBL";"buy";"8";"548.11";"9.45"\r\n';
    expect(parseTxnCsv(text)).toEqual({ rows: [MEBL], errors: [] });
  });

  it('ends records on a lone CR (Excel "CSV (Macintosh)") and still numbers the lines', () => {
    const text = `${HEADER}\r2026-10-06,MEBL,buy,8,548.11,9.45\r2026-10-06,MEBL,buy,x,548.11,\r`;
    const { rows, errors } = parseTxnCsv(text);
    expect(rows).toEqual([MEBL]);
    expect(errors).toEqual([expect.stringMatching(/^Line 3: shares "x"/)]);
  });

  it('keeps a line break inside quotes in the cell and counts it in the line numbers', () => {
    const text = `${HEADER},note\n2026-10-06,MEBL,buy,8,548.11,9.45,"two\r\nlines"\n2026-10-06,MEBL,buy,x,548.11,,\n`;
    const { rows, errors } = parseTxnCsv(text);
    expect(rows).toEqual([MEBL]);
    expect(errors).toEqual([expect.stringMatching(/^Line 4: shares "x"/)]);
  });

  it('keeps a delimiter inside quotes and reads thousands separators', () => {
    const text = `${HEADER}\n2026-10-06,MEBL,buy,"1,000","548.11",\n2026-10-06,MEBL,buy,"1,00,000",548.11,\n`;
    const { rows, errors } = parseTxnCsv(text);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ shares: 1000, price: 548.11, amount: 548110, charges: null });
    expect(rows[1]).toMatchObject({ shares: 100000 }); // lakh grouping
  });

  it('reads decimal commas in a semicolon file, where dots group thousands', () => {
    const text = 'date;symbol;side;shares;price;charges\n2026-10-06;MEBL;buy;8;548,11;9,45\n2026-10-06;MEBL;buy;1.000;1.234,56;\n2026-10-06;MEBL;buy;10.000;548.11;0.500\n';
    const { rows, errors } = parseTxnCsv(text);
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual(MEBL);
    expect(rows[1]).toMatchObject({ shares: 1000, price: 1234.56, amount: 1234560, charges: null });
    expect(rows[2]).toMatchObject({ shares: 10000, price: 548.11, charges: 0.5 }); // groups of three are thousands; two decimals, or a leading 0, is a decimal point
  });

  it('reads a comma followed by one or two digits as a decimal comma in a comma file too', () => {
    const text = `${HEADER}\n2026-10-06,MEBL,buy,8,"548,11","9,45"\n2026-10-06,MEBL,buy,8,"1.234,5",\n`;
    const { rows, errors } = parseTxnCsv(text);
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual(MEBL);
    expect(rows[1]).toMatchObject({ price: 1234.5 });
  });

  it('rejects a number that fits neither reading by line number instead of guessing', () => {
    const { rows, errors } = parseTxnCsv(`${HEADER}\n2026-10-06,MEBL,buy,8,"12.34,5",\n2026-10-06,MEBL,buy,8,"1,000,50",\n`);
    expect(rows).toEqual([]);
    expect(errors).toEqual([expect.stringMatching(/^Line 2: price "12.34,5"/), expect.stringMatching(/^Line 3: price "1,000,50"/)]);
    const semi = parseTxnCsv('date;symbol;side;shares;price;charges\n2026-10-06;MEBL;buy;8;1,00,000;\n');
    expect(semi.rows).toEqual([]);
    expect(semi.errors).toEqual([expect.stringMatching(/^Line 2: price "1,00,000"/)]);
  });

  it('rejects a date after today by line number (today is the PKT date unless given)', () => {
    const text = `${HEADER}\n2099-01-01,MEBL,buy,8,548.11,\n2026-10-16,MEBL,buy,8,548.11,\n2026-10-15,MEBL,buy,8,548.11,\n`;
    const { rows, errors } = parseTxnCsv(text, { today: '2026-10-15' });
    expect(rows.map((r) => r.executed_on)).toEqual(['2026-10-15']);
    expect(errors).toEqual([
      expect.stringMatching(/^Line 2: date "2099-01-01" is after today \(2026-10-15\)/),
      expect.stringMatching(/^Line 3: date "2026-10-16" is after today/),
    ]);
    const byClock = parseTxnCsv(`${HEADER}\n2099-01-01,MEBL,buy,8,548.11,\n`);
    expect(byClock.rows).toEqual([]);
    expect(byClock.errors).toEqual([expect.stringMatching(/^Line 2: date "2099-01-01" is after today/)]);
  });

  it('does not let a side named after an Object.prototype member through', () => {
    const text = [HEADER, '2026-10-06,MEBL,constructor,8,548.11,', '2026-10-06,MEBL,__proto__,8,548.11,', '2026-10-06,MEBL,toString,8,548.11,'].join('\n');
    const { rows, errors } = parseTxnCsv(text);
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      expect.stringMatching(/^Line 2: side "constructor" not understood/),
      expect.stringMatching(/^Line 3: side "__proto__" not understood/),
      expect.stringMatching(/^Line 4: side "toString" not understood/),
    ]);
  });

  it('understands every date format and writes YYYY-MM-DD', () => {
    // "Oct 6, 2026" holds the delimiter, so in a comma CSV it has to be quoted, as a spreadsheet would write it.
    const dates = ['2026-10-06', '2026/10/06', '06/10/2026', '6/10/2026', '06-10-2026', '06.10.2026', '6 Oct 2026', '06 October 2026', '06-Oct-2026', '"Oct 6, 2026"', 'October 6 2026'];
    const text = [HEADER, ...dates.map((d) => `${d},MEBL,buy,8,548.11,`)].join('\n');
    const { rows, errors } = parseTxnCsv(text);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.executed_on)).toEqual(dates.map(() => '2026-10-06'));
  });

  it('rejects an impossible date by line number', () => {
    const { rows, errors } = parseTxnCsv(`${HEADER}\n2026-02-30,MEBL,buy,8,548.11,\n31/13/2026,MEBL,buy,8,548.11,\nsoon,MEBL,buy,8,548.11,`);
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^Line 2: date "2026-02-30"/);
    expect(errors[1]).toMatch(/^Line 3: date "31\/13\/2026"/);
    expect(errors[2]).toMatch(/^Line 4: date "soon"/);
  });

  it('matches columns by alias, in any case and order, and ignores extra columns', () => {
    const text = 'Note,Rate,Qty,Buy/Sell,Scrip,Trade Date,Commission\nfill,548.11,8,B,meblxd,6 Oct 2026,\n';
    const { rows, errors } = parseTxnCsv(text);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ ...MEBL, charges: null }]); // symbol upper-cased, XD marker stripped
  });

  it('accepts the other aliases and side spellings, with no charges column at all', () => {
    const text = ['executed_on,ticker,type,volume,price', '2026-10-06,MEBL,purchase,8,548.11', '2026-10-07,SYS,S,10,120.5', '2026-10-08,SYS,sale,1,120.5', '2026-10-09,MEBL,sold,2,500'].join('\n');
    const { rows, errors } = parseTxnCsv(text);
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.symbol, r.side, r.charges])).toEqual([['MEBL', 'buy', null], ['SYS', 'sell', null], ['SYS', 'sell', null], ['MEBL', 'sell', null]]);
  });

  it('reports a bad side or zero shares by line number and skips only those rows', () => {
    const text = [HEADER, '2026-10-06,MEBL,hold,8,548.11,', '2026-10-06,MEBL,buy,0,548.11,', '2026-10-06,MEBL,buy,8,548.11,9.45'].join('\n');
    const { rows, errors } = parseTxnCsv(text);
    expect(rows).toEqual([MEBL]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^Line 2: side "hold"/);
    expect(errors[1]).toMatch(/^Line 3: shares "0"/);
  });

  it('reports a bad price, negative charges, a fractional share count and a bad symbol', () => {
    const text = [HEADER, '2026-10-06,MEBL,buy,8,0,', '2026-10-06,MEBL,buy,8,548.11,-1', '2026-10-06,MEBL,buy,8.5,548.11,', '2026-10-06,ME BL,buy,8,548.11,', '2026-10-06,,buy,8,548.11,'].join('\n');
    const { rows, errors } = parseTxnCsv(text);
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      expect.stringMatching(/^Line 2: price "0"/),
      expect.stringMatching(/^Line 3: charges "-1"/),
      expect.stringMatching(/^Line 4: shares "8.5"/),
      expect.stringMatching(/^Line 5: symbol "ME BL"/),
      expect.stringMatching(/^Line 6: symbol is blank/),
    ]);
  });

  it('counts blank lines in the line numbers but never as rows', () => {
    const text = `${HEADER}\n\n2026-10-06,MEBL,buy,8,548.11,\n   \n2026-10-06,MEBL,buy,x,548.11,\n\n`;
    const { rows, errors } = parseTxnCsv(text);
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([expect.stringMatching(/^Line 5: shares "x"/)]);
  });

  it('a header with no rows under it is an error, never an empty success', () => {
    for (const text of [`${HEADER}\n`, `${HEADER}\r`, `${HEADER}\r\n\r\n   \r\n`, HEADER]) {
      expect(parseTxnCsv(text)).toEqual({ rows: [], errors: [expect.stringMatching(/^No rows found after the header line \(line 1\)/)] });
    }
  });

  it('needs a header row and says which columns are missing', () => {
    expect(parseTxnCsv('')).toEqual({ rows: [], errors: [expect.stringMatching(/empty/)] });
    const noHeader = parseTxnCsv('2026-10-06,MEBL,buy,8,548.11,9.45\n');
    expect(noHeader.rows).toEqual([]);
    expect(noHeader.errors).toEqual([expect.stringMatching(/^Line 1: no column for date, symbol, side, shares, price\./)]);
    const partial = parseTxnCsv('date,symbol,side\n2026-10-06,MEBL,buy\n');
    expect(partial.errors).toEqual([expect.stringMatching(/^Line 1: no column for shares, price\./)]);
  });
});

describe('dedupeTxns', () => {
  it('skips rows already recorded on date, symbol, side, shares and price, whatever the source or charges', () => {
    const existing: Txn[] = [
      { id: 'a', ...txn('2026-10-06', 'MEBL', 'buy', 8, 548.11, { source: 'manual', charges: 9.45 }) },
      { id: 'b', ...txn('2026-09-01', 'SYS', 'sell', 10, 120.5, { source: 'import' }) },
    ];
    const rows = [
      txn('2026-10-06', 'MEBL', 'buy', 8, 548.11), // same as a
      txn('2026-10-06', 'MEBL', 'buy', 9, 548.11), // different shares
      txn('2026-10-06', 'MEBL', 'sell', 8, 548.11), // different side
      txn('2026-10-07', 'MEBL', 'buy', 8, 548.11), // different day
      txn('2026-10-06', 'MEBL', 'buy', 8, 548.12), // different price
      txn('2026-09-01', 'sys', 'sell', 10, 120.5), // same as b, lower case
    ];
    const { fresh, duplicates } = dedupeTxns(rows, existing);
    expect(duplicates).toEqual([rows[0], rows[5]]);
    expect(fresh).toEqual([rows[1], rows[2], rows[3], rows[4]]);
  });

  it('matches each recorded row once, so a second identical fill is still new', () => {
    const existing = [txn('2026-10-06', 'MEBL', 'buy', 8, 548.11)];
    const rows = [txn('2026-10-06', 'MEBL', 'buy', 8, 548.11), txn('2026-10-06', 'MEBL', 'buy', 8, 548.11)];
    const { fresh, duplicates } = dedupeTxns(rows, existing);
    expect(duplicates).toHaveLength(1);
    expect(fresh).toHaveLength(1);
  });

  it('with nothing recorded, every row is fresh', () => {
    const rows = [txn('2026-10-06', 'MEBL', 'buy', 8, 548.11)];
    expect(dedupeTxns(rows, [])).toEqual({ fresh: rows, duplicates: [] });
  });
});

describe('txnsToCsv', () => {
  it('writes the template header and one line per transaction, blank charges kept blank', () => {
    const out = txnsToCsv([MEBL, txn('2026-09-22', 'SYS', 'sell', 10, 120.5)]);
    expect(out).toBe(`${HEADER}\n2026-10-06,MEBL,buy,8,548.11,9.45\n2026-09-22,SYS,sell,10,120.5,\n`);
  });

  it('round-trips through parseTxnCsv', () => {
    const txns: Txn[] = [
      { id: '1', ...txn('2026-10-06', 'MEBL', 'buy', 8, 548.11, { source: 'manual', charges: 9.45 }) },
      { id: '2', ...txn('2026-09-22', 'SYS', 'sell', 10, 120.5, { source: 'import' }) },
      { id: '3', ...txn('2024-01-02', 'OGDC', 'buy', 1000, 99.9, { charges: 0 }) },
      { id: '4', ...txn('2025-06-30', 'HUBC', 'buy', 3, 140.1234, { charges: 1.5 }) },
    ];
    const { rows, errors } = parseTxnCsv(txnsToCsv(txns));
    expect(errors).toEqual([]);
    expect(rows).toEqual(txns.map(({ id: _id, ...t }) => ({ ...t, source: 'csv' })));
  });

  it('an empty list is just the header', () => {
    expect(txnsToCsv([])).toBe(`${HEADER}\n`);
  });
});
