import { describe, expect, it } from 'vitest';
import { parseHash, stockHref } from '../src/lib/nav.ts';

describe('parseHash', () => {
  it('routes, sections and stock symbols', () => {
    expect(parseHash('#/home').route).toBe('home');
    expect(parseHash('#/profile/rules')).toMatchObject({ route: 'profile', sub: 'rules' });
    expect(parseHash('#/stock/ogdc')).toMatchObject({ route: 'stock', sub: 'OGDC' });
    expect(parseHash('#/stock').route).toBe('home');
    expect(parseHash('#/home?market').route).toBe('market');
    expect(parseHash('#/news?week').query.has('week')).toBe(true);
    expect(parseHash('#/settings').route).toBe('profile');
    expect(parseHash('').route).toBe('home');
    expect(stockHref('ubl')).toBe('#/stock/UBL');
  });
});
