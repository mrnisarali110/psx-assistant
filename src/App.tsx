import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { DemoSource, LiveSource, supabase, type AppData, type DataSource } from './lib/data.ts';
import { config, isIOS, isStandalone } from './lib/config.ts';
import { resyncPush } from './lib/push.ts';
import { applyTheme, watchSystemTheme } from './lib/theme.ts';
import { haptic, usePullToRefresh } from './lib/gestures.ts';
import { parseHash, profileHref, type ParsedHash, type Route } from './lib/nav.ts';
import { isMarketOpen } from '../shared/time.ts';
import { DEFAULT_RULES } from '../shared/types.ts';
import { ToastProvider } from './components/Toast.tsx';
import { Icon, type IconName } from './components/Icon.tsx';
import { Skeleton } from './components/ui.tsx';
import { LogoMark, Splash } from './components/Splash.tsx';
import { Freshness } from './components/Freshness.tsx';
import { useNumberFade } from './components/motion.ts';
import { Login, NewPassword } from './screens/Login.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { FirstRun } from './screens/FirstRun.tsx';
import { Home } from './screens/Home.tsx';
import { Portfolio } from './screens/Portfolio.tsx';
import { Discover } from './screens/Discover.tsx';
import { News } from './screens/News.tsx';
import { Profile } from './screens/Profile.tsx';
import { Market } from './screens/Market.tsx';
import { Stock } from './screens/Stock.tsx';

export type { Route } from './lib/nav.ts';

export interface ScreenProps {
  data: AppData;
  source: DataSource;
  reload: () => Promise<void>;
  go: (r: Route) => void;
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export default function App() {
  const [nav, setNav] = useState<ParsedHash>(() => parseHash(location.hash));
  const { route, sub } = nav;
  const [demo, setDemo] = useState(() => new URLSearchParams(location.search).has('demo') || store.get('psx-demo') === '1');
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [onboarded, setOnboarded] = useState(() => store.get('psx-ios-onboarded') === '1');

  useEffect(() => {
    applyTheme();
    const unwatch = watchSystemTheme();
    const onHash = () => { setNav(parseHash(location.hash)); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', onHash);
    // A tapped notification asks an already-open app to show its screen.
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open' && typeof e.data.url === 'string') location.hash = e.data.url.split('#')[1] ?? '/home';
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => {
      unwatch();
      window.removeEventListener('hashchange', onHash);
      navigator.serviceWorker?.removeEventListener('message', onMsg);
    };
  }, []);

  useEffect(() => {
    if (!config.supabaseUrl) { setAuthReady(true); return; }
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data } = sb.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const source: DataSource | null = useMemo(() => {
    if (demo) return new DemoSource();
    if (session?.user) return new LiveSource(session.user.id, session.user.email ?? null);
    return null;
  }, [demo, session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!source) return;
    try {
      setData(await source.load());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [source]);

  useEffect(() => {
    setData(null);
    reload();
    if (source) resyncPush(source);
    const onVisible = () => document.visibilityState === 'visible' && reload();
    document.addEventListener('visibilitychange', onVisible);
    // While the app stays open during trading hours, pick up the worker's 30-minute price updates on its own.
    const tick = setInterval(() => { if (document.visibilityState === 'visible' && isMarketOpen(new Date(), DEFAULT_RULES.market_hours_pkt)) reload(); }, 5 * 60_000);
    return () => { document.removeEventListener('visibilitychange', onVisible); clearInterval(tick); };
  }, [source, reload]);

  // First-run setup: a signed-in account with no holdings that has not finished or skipped it. Once it shows it stays
  // until done, so importing holdings in step 1 does not drop you out of steps 2 and 3.
  const needsSetup = !!data && source?.kind === 'live' && !data.holdings.length && !data.settings.onboarded;
  const [inSetup, setInSetup] = useState(false);
  useEffect(() => { if (needsSetup) setInSetup(true); }, [needsSetup]);

  const { pull, busy } = usePullToRefresh(reload);
  // The branded splash covers only the very first data load, then fades out as the screen renders under it.
  const [splash, setSplash] = useState(true);
  const hideSplash = useCallback(() => setSplash(false), []);
  const numberFade = useNumberFade();
  const go = (r: Route) => { location.hash = `/${r}`; };
  const startDemo = () => { store.set('psx-demo', '1'); setDemo(true); };
  const exitDemo = () => {
    store.set('psx-demo', null);
    history.replaceState(null, '', location.pathname + location.hash);
    setDemo(false);
  };

  if (isIOS() && !isStandalone() && !onboarded) {
    return <Onboarding onSkip={() => { store.set('psx-ios-onboarded', '1'); setOnboarded(true); }} />;
  }
  if (recovering) return <NewPassword onDone={() => setRecovering(false)} />;
  if (!authReady) return <Splash />;
  if (!source) return <Login onDemo={startDemo} />;

  const props = data ? { data, source, reload, go } : null;
  const unread = data ? countNew(data) : 0;
  const setup = !!props && route === 'home' && inSetup && !props.data.settings.onboarded;
  return (
    <ToastProvider>
      <div ref={numberFade} className="mx-auto flex min-h-dvh max-w-md flex-col lg:max-w-none lg:pl-60">
        {demo && (
          <div className="safe-top bg-caution/10 px-4 py-1 text-center text-12 text-ink">
            Demo with your seed portfolio and PSX prices from Oct 5.{' '}
            <button type="button" className="min-h-11 cursor-pointer px-1 font-semibold text-brand underline underline-offset-2" onClick={exitDemo}>Sign in</button>
          </div>
        )}
        <TopBar initial={avatarInitial(data?.email)} active={route === 'profile'} safeTop={!demo} />
        <div aria-hidden={!pull} className="flex justify-center overflow-hidden transition-[height]" style={{ height: pull }}>
          <span className={`mt-3 flex h-8 w-8 items-center justify-center rounded-full bg-surface shadow-card ring-1 ring-line ${busy ? 'animate-spin' : ''}`} style={{ transform: busy ? undefined : `rotate(${pull * 4}deg)` }}>
            <Icon name="refresh" className="h-4 w-4 text-brand" />
          </span>
        </div>
        <main key={`${route}/${sub ?? ''}`} className={`stagger flex-1 space-y-4 px-4 pb-24 lg:mx-auto lg:w-full lg:px-8 lg:pt-6 lg:pb-12 ${DESKTOP[route]} pt-1`}>
          {data && <Freshness data={data} className="lg:justify-end" />}
          {error && !data && (
            <div className="space-y-3 pt-10 text-center">
              <p className="flex items-center justify-center gap-2 text-14 text-ink"><Icon name="alert" className="h-4 w-4 text-caution" />Couldn't load your data: {error}</p>
              <button type="button" className="min-h-11 cursor-pointer px-2 text-14 font-semibold text-brand underline underline-offset-2" onClick={reload}>Try again</button>
            </div>
          )}
          {!props && !error && !splash && <ScreenSkeleton route={route} />}
          {setup && props && <FirstRun {...props} onDone={() => setInSetup(false)} />}
          {props && !setup && route === 'home' && <Home {...props} />}
          {props && route === 'market' && <Market {...props} />}
          {props && route === 'portfolio' && <Portfolio {...props} />}
          {props && route === 'discover' && <Discover {...props} />}
          {props && route === 'news' && <News {...props} />}
          {props && route === 'profile' && <Profile {...props} onExitDemo={exitDemo} section={sub} />}
          {props && route === 'stock' && sub && <Stock symbol={sub} {...props} />}
        </main>
        <TabBar route={route} go={go} unread={unread} />
        <SideNav route={route} go={go} unread={unread} />
        {splash && <Splash leaving={!!data || !!error} onGone={hideSplash} />}
      </div>
    </ToastProvider>
  );
}

/** Alerts and filings from the last 24 hours, shown as a dot on the News tab. */
function countNew(d: AppData) {
  const since = Date.now() - 24 * 3600_000;
  return d.alerts.filter((a) => Date.parse(a.sent_at) > since && a.channel !== 'none').length;
}

/** The first letter of the account email for the avatar ("demo" → D); a person icon until it is known. */
const avatarInitial = (email: string | null | undefined) => (email && /[a-z0-9]/i.test(email[0]) ? email[0].toUpperCase() : null);

/** Phone top bar: the name on the left, your avatar (opens Profile) on the right. Desktop has the sidebar instead. */
function TopBar({ initial, active, safeTop }: { initial: string | null; active: boolean; safeTop: boolean }) {
  return (
    <header className={`flex items-center justify-between px-4 pt-1 lg:hidden ${safeTop ? 'safe-top' : ''}`}>
      <span className="flex items-center gap-2">
        <LogoMark className="h-7 w-7" />
        <span className="text-16 font-bold tracking-tight">PSX Assist</span>
      </span>
      <a href={profileHref()} onClick={() => haptic()} aria-label="Profile and settings" aria-current={active ? 'page' : undefined}
        className="press -mr-1.5 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full">
        <span className={`flex h-8 w-8 items-center justify-center rounded-full text-14 font-bold ring-1 ${active ? 'bg-brand text-canvas ring-brand' : 'bg-surface-2 text-ink ring-line'}`}>
          {initial ?? <Icon name="user" className="h-4 w-4" />}
        </span>
      </a>
    </header>
  );
}

/** Loading placeholders shaped like the screen that is coming, so nothing jumps when it arrives. */
export function ScreenSkeleton({ route }: { route: Route }) {
  const row = (k: number) => (
    <div key={k} className="flex items-center gap-3 py-2">
      <Skeleton className="h-10 w-10 rounded-full" />
      <div className="flex-1 space-y-1.5"><Skeleton className="h-4 w-24" /><Skeleton className="h-3 w-16" /></div>
      <Skeleton className="h-4 w-16" />
    </div>
  );
  const rows = (n: number) => <div className="rounded-card bg-surface px-4 py-1 ring-1 ring-line">{Array.from({ length: n }, (_, i) => row(i))}</div>;
  const shapes: Record<Route, ReactNode> = {
    home: (
      <>
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-14 w-full rounded-card" />
        <div className="space-y-3 rounded-card bg-surface p-4 ring-1 ring-line">
          <Skeleton className="h-4 w-28" /><Skeleton className="h-8 w-40" /><Skeleton className="h-11 w-full" /><Skeleton className="h-40 w-full" />
        </div>
        {rows(4)}
      </>
    ),
    market: (
      <>
        <Skeleton className="h-7 w-32" />
        <div className="grid gap-4 lg:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36 w-full rounded-card" />)}</div>
      </>
    ),
    portfolio: (
      <>
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-12 w-full rounded-control" />
        <Skeleton className="h-28 w-full rounded-card" />
        {rows(5)}
      </>
    ),
    discover: (
      <>
        <Skeleton className="h-7 w-32" />
        <div className="flex gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11 w-24 rounded-full" />)}</div>
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 w-full rounded-card" />)}
      </>
    ),
    news: (
      <>
        <Skeleton className="h-7 w-24" />
        <div className="flex gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-28 rounded-full" />)}</div>
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full rounded-card" />)}
      </>
    ),
    profile: (
      <>
        <Skeleton className="h-7 w-28" />
        {rows(8)}
      </>
    ),
    stock: (
      <>
        <div className="flex items-center gap-3"><Skeleton className="h-12 w-12 rounded-full" /><div className="space-y-1.5"><Skeleton className="h-6 w-24" /><Skeleton className="h-4 w-36" /></div></div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 w-full rounded-card" />
        {rows(3)}
      </>
    ),
  };
  return <div className="skeleton-in space-y-4 pt-2" aria-label="Loading" role="status">{shapes[route]}</div>;
}

/** The phone's tab bar: five places. Profile is the avatar at the top right; a stock page belongs to no tab. */
const TABS: { route: Route; label: string; icon: IconName }[] = [
  { route: 'home', label: 'Home', icon: 'home' },
  { route: 'market', label: 'Market', icon: 'chart' },
  { route: 'portfolio', label: 'Portfolio', icon: 'briefcase' },
  { route: 'discover', label: 'Discover', icon: 'compass' },
  { route: 'news', label: 'News', icon: 'news' },
];

/**
 * Desktop (1024px and up): a page, not a stretched phone. Home and Market lay out their own grid; Profile keeps its
 * list beside the open section; the list screens get a wider page whose lists form a grid (see each screen).
 */
const DESKTOP: Record<Route, string> = {
  home: 'lg:max-w-6xl lg:space-y-5 2xl:max-w-7xl',
  market: 'lg:max-w-6xl lg:space-y-5 2xl:max-w-7xl',
  profile: 'lg:max-w-6xl 2xl:max-w-7xl',
  portfolio: 'lg:max-w-6xl 2xl:max-w-7xl',
  discover: 'lg:max-w-6xl 2xl:max-w-7xl',
  news: 'lg:max-w-5xl',
  stock: 'lg:max-w-6xl lg:space-y-5 2xl:max-w-7xl',
};

const SIDE: typeof TABS = [...TABS, { route: 'profile', label: 'Profile', icon: 'user' }];

/** The desktop navigation: the phone's five places plus Profile, as a fixed left sidebar. Its footer is the app's one disclaimer on desktop. */
function SideNav({ route, go, unread }: { route: Route; go: (r: Route) => void; unread: number }) {
  return (
    <nav aria-label="Main" className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-1 border-r border-line bg-surface/85 px-3 py-6 backdrop-blur-xl lg:flex">
      <div className="mb-6 flex items-center gap-2.5 px-3">
        <LogoMark className="h-8 w-8" />
        <span className="text-16 font-bold tracking-tight">PSX Assist</span>
      </div>
      {SIDE.map((t) => {
        const active = route === t.route;
        return (
          <button key={t.route} type="button" onClick={() => go(t.route)} aria-current={active ? 'page' : undefined}
            className={`press relative flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-3 text-14 font-semibold transition-colors ${active ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink'}`}>
            <Icon name={t.icon} className={`h-5 w-5 ${active ? 'stroke-[2.4]' : ''}`} />
            {t.label}
            {t.route === 'news' && unread > 0 && !active && <span className="ml-auto h-2 w-2 rounded-full bg-brand" aria-label={`${unread} new`} />}
          </button>
        );
      })}
      <p className="mt-auto px-3 text-12 text-muted">Suggestions only, not licensed financial advice.</p>
    </nav>
  );
}

function TabBar({ route, go, unread }: { route: Route; go: (r: Route) => void; unread: number }) {
  const index = TABS.findIndex((t) => t.route === route);
  return (
    <nav aria-label="Main" className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/90 backdrop-blur-xl lg:hidden">
      <ul className="relative mx-auto flex max-w-md">
        {index >= 0 && (
          <li aria-hidden="true" className="slide-indicator pointer-events-none absolute top-0 left-0 flex w-1/5 justify-center"
            style={{ transform: `translateX(${index * 100}%)` }}>
            <span className="h-0.5 w-8 rounded-full bg-brand" />
          </li>
        )}
        {TABS.map((t) => {
          const active = route === t.route;
          return (
            <li key={t.route} className="flex-1">
              <button type="button" onClick={() => { haptic(); go(t.route); }} aria-current={active ? 'page' : undefined}
                className={`press relative flex min-h-14 w-full cursor-pointer flex-col items-center justify-center gap-0.5 text-12 font-medium ${active ? 'text-ink' : 'text-muted'}`}>
                <Icon name={t.icon} className={`h-6 w-6 ${active ? 'stroke-[2.4]' : ''}`} />
                {t.label}
                {t.route === 'news' && unread > 0 && !active && <span className="absolute top-2 left-1/2 ml-2 h-2 w-2 rounded-full bg-brand" aria-label={`${unread} new`} />}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
