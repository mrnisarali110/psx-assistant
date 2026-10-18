import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { DemoSource, LiveSource, supabase, type AppData, type DataSource } from './lib/data.ts';
import { config, isIOS, isStandalone } from './lib/config.ts';
import { resyncPush } from './lib/push.ts';
import { applyTheme, watchSystemTheme } from './lib/theme.ts';
import { haptic, usePullToRefresh } from './lib/gestures.ts';
import { isMarketOpen } from '../shared/time.ts';
import { DEFAULT_RULES } from '../shared/types.ts';
import { ToastProvider } from './components/Toast.tsx';
import { Icon, type IconName } from './components/Icon.tsx';
import { Skeleton } from './components/ui.tsx';
import { Splash } from './components/Splash.tsx';
import { useNumberFade } from './components/motion.ts';
import { Login, NewPassword } from './screens/Login.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { Home } from './screens/Home.tsx';
import { Portfolio } from './screens/Portfolio.tsx';
import { Discover } from './screens/Discover.tsx';
import { News } from './screens/News.tsx';
import { Profile } from './screens/Profile.tsx';

export type Route = 'home' | 'portfolio' | 'discover' | 'news' | 'profile';
const ROUTES: Route[] = ['home', 'portfolio', 'discover', 'news', 'profile'];
const LEGACY: Record<string, Route> = { today: 'home', plan: 'home', settings: 'profile' };

export interface ScreenProps {
  data: AppData;
  source: DataSource;
  reload: () => Promise<void>;
  go: (r: Route) => void;
}

const readRoute = (): Route => {
  const r = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return ROUTES.includes(r as Route) ? (r as Route) : LEGACY[r] ?? 'home';
};

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [demo, setDemo] = useState(() => new URLSearchParams(location.search).has('demo') || store.get('psx-demo') === '1');
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [onboarded, setOnboarded] = useState(() => store.get('psx-ios-onboarded') === '1');

  useEffect(() => {
    applyTheme();
    const unwatch = watchSystemTheme();
    const onHash = () => { setRoute(readRoute()); window.scrollTo({ top: 0 }); };
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
  return (
    <ToastProvider>
      <div ref={numberFade} className="mx-auto flex min-h-dvh max-w-md flex-col lg:max-w-none lg:pl-60">
        {demo && (
          <div className="safe-top bg-amber-100 px-4 py-2 text-center text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Demo with your seed portfolio and PSX prices from Oct 5. <button className="cursor-pointer font-semibold underline" onClick={exitDemo}>Sign in</button>
          </div>
        )}
        <div aria-hidden={!pull} className="flex justify-center overflow-hidden transition-[height]" style={{ height: pull }}>
          <span className={`mt-3 flex h-8 w-8 items-center justify-center rounded-full bg-white shadow dark:bg-slate-800 ${busy ? 'animate-spin' : ''}`} style={{ transform: busy ? undefined : `rotate(${pull * 4}deg)` }}>
            <Icon name="refresh" className="h-4 w-4 text-teal-600" />
          </span>
        </div>
        <main key={route} className={`stagger flex-1 space-y-4 px-4 pb-24 lg:mx-auto lg:w-full lg:px-8 lg:pt-8 lg:pb-12 ${DESKTOP[route]} ${demo ? 'pt-3' : 'safe-top pt-3'}`}>
          {error && !data && (
            <div className="space-y-3 pt-10 text-center">
              <p className="text-sm text-rose-700 dark:text-rose-400">Couldn't load your data: {error}</p>
              <button className="cursor-pointer text-sm font-semibold text-teal-700 underline" onClick={reload}>Try again</button>
            </div>
          )}
          {!props && !error && !splash && <ScreenSkeleton />}
          {props && route === 'home' && <Home {...props} />}
          {props && route === 'portfolio' && <Portfolio {...props} />}
          {props && route === 'discover' && <Discover {...props} />}
          {props && route === 'news' && <News {...props} />}
          {props && route === 'profile' && <Profile {...props} onExitDemo={exitDemo} />}
        </main>
        <TabBar route={route} go={go} unread={data ? countNew(data) : 0} />
        <SideNav route={route} go={go} unread={data ? countNew(data) : 0} />
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

function ScreenSkeleton() {
  return (
    <div className="skeleton-in space-y-4 pt-2" aria-label="Loading">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-32 w-full rounded-3xl" />
      <div className="flex gap-3">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-12 rounded-full" />)}</div>
      <Skeleton className="h-48 w-full rounded-3xl" />
    </div>
  );
}

const TABS: { route: Route; label: string; icon: IconName }[] = [
  { route: 'home', label: 'Home', icon: 'home' },
  { route: 'portfolio', label: 'Portfolio', icon: 'briefcase' },
  { route: 'discover', label: 'Discover', icon: 'compass' },
  { route: 'news', label: 'News', icon: 'news' },
  { route: 'profile', label: 'Profile', icon: 'user' },
];

/**
 * Desktop (1024px and up): a page, not a stretched phone. Home and Profile flow their cards into two columns
 * (each card stays whole); the list screens get a wider page whose lists form a grid (see each screen).
 */
const DESKTOP: Record<Route, string> = {
  home: 'lg:max-w-6xl lg:block lg:columns-2 lg:gap-6 lg:space-y-0 lg:[&>*]:mb-5 lg:[&>*]:break-inside-avoid',
  profile: 'lg:max-w-6xl lg:block lg:columns-2 lg:gap-6 lg:space-y-0 lg:[&>*]:mb-5 lg:[&>*]:break-inside-avoid',
  portfolio: 'lg:max-w-6xl',
  discover: 'lg:max-w-6xl',
  news: 'lg:max-w-5xl',
};

/** The desktop navigation: the same five places as the phone's tab bar, as a fixed left sidebar. */
function SideNav({ route, go, unread }: { route: Route; go: (r: Route) => void; unread: number }) {
  return (
    <nav aria-label="Main" className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-1 border-r border-slate-200/80 bg-white/80 px-3 py-6 backdrop-blur-xl lg:flex dark:border-slate-800 dark:bg-black/70">
      <div className="mb-6 flex items-center gap-2.5 px-3">
        <img src="/favicon.svg" alt="" className="h-8 w-8 rounded-lg" />
        <span className="text-base font-bold tracking-tight">PSX Assist</span>
      </div>
      {TABS.map((t) => {
        const active = route === t.route;
        return (
          <button key={t.route} type="button" onClick={() => go(t.route)} aria-current={active ? 'page' : undefined}
            className={`press relative flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors ${active ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/60 dark:text-teal-200' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70'}`}>
            <Icon name={t.icon} className={`h-5 w-5 ${active ? 'stroke-[2.4]' : ''}`} />
            {t.label}
            {t.route === 'news' && unread > 0 && !active && <span className="ml-auto h-2 w-2 rounded-full bg-rose-500" aria-label={`${unread} new`} />}
          </button>
        );
      })}
      <p className="mt-auto px-3 text-[11px] leading-snug text-slate-400 dark:text-slate-500">Suggestions only, not licensed financial advice.</p>
    </nav>
  );
}

function TabBar({ route, go, unread }: { route: Route; go: (r: Route) => void; unread: number }) {
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t lg:hidden border-slate-200/80 bg-white/90 backdrop-blur-xl dark:border-slate-800 dark:bg-black/85">
      <ul className="relative mx-auto flex max-w-md">
        <li aria-hidden="true" className="slide-indicator pointer-events-none absolute top-0 left-0 flex w-1/5 justify-center"
          style={{ transform: `translateX(${Math.max(0, TABS.findIndex((t) => t.route === route)) * 100}%)` }}>
          <span className="h-0.5 w-8 rounded-full bg-teal-600 dark:bg-teal-400" />
        </li>
        {TABS.map((t) => {
          const active = route === t.route;
          return (
            <li key={t.route} className="flex-1">
              <button type="button" onClick={() => { haptic(); go(t.route); }} aria-current={active ? 'page' : undefined}
                className={`press relative flex min-h-14 w-full cursor-pointer flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${active ? 'text-slate-900 dark:text-white' : 'text-slate-400 dark:text-slate-500'}`}>
                <Icon name={t.icon} className={`h-6 w-6 ${active ? 'stroke-[2.4]' : ''}`} />
                {t.label}
                {t.route === 'news' && unread > 0 && !active && <span className="absolute top-2 left-1/2 ml-2 h-2 w-2 rounded-full bg-rose-500" aria-label={`${unread} new`} />}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
