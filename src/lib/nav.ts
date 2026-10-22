/**
 * Hash routes: #/home, #/market, #/portfolio, #/discover, #/news, #/profile[/section], #/stock/SYMBOL.
 * One parser for the app shell and every screen, so deep links (notifications, Telegram) keep working.
 */
export type Route = 'home' | 'market' | 'portfolio' | 'discover' | 'news' | 'profile' | 'stock';
export const ROUTES: Route[] = ['home', 'market', 'portfolio', 'discover', 'news', 'profile', 'stock'];
const LEGACY: Record<string, Route> = { today: 'home', plan: 'home', settings: 'profile' };

export interface ParsedHash { route: Route; sub: string | null; query: URLSearchParams }

export function parseHash(hash: string): ParsedHash {
  const h = hash.replace(/^#\/?/, '');
  const [path, q = ''] = h.split('?');
  const [first = '', second] = path.split('/');
  const query = new URLSearchParams(q);
  if (first === 'home' && query.has('market')) return { route: 'market', sub: null, query }; // older notification links
  const route = (ROUTES as string[]).includes(first) ? (first as Route) : LEGACY[first] ?? 'home';
  let sub = second ? decodeURIComponent(second) : null;
  if (route === 'stock') sub = sub ? sub.toUpperCase() : null;
  if (route === 'stock' && !sub) return { route: 'home', sub: null, query };
  return { route, sub, query };
}

export const stockHref = (symbol: string) => `#/stock/${encodeURIComponent(symbol.toUpperCase())}`;
export const openStock = (symbol: string) => { location.hash = stockHref(symbol).slice(1); };
export const profileHref = (section?: string) => (section ? `#/profile/${section}` : '#/profile');
