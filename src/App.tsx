import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { DemoSource, LiveSource, supabase, type AppData, type DataSource } from './lib/data.ts';
import { config, isIOS, isStandalone } from './lib/config.ts';
import { resyncPush } from './lib/push.ts';
import { Login, NewPassword } from './screens/Login.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { Today } from './screens/Today.tsx';
import { Portfolio } from './screens/Portfolio.tsx';
import { PlanScreen } from './screens/Plan.tsx';
import { News } from './screens/News.tsx';
import { SettingsScreen } from './screens/Settings.tsx';

export type Route = 'today' | 'portfolio' | 'plan' | 'news' | 'settings';
const ROUTES: Route[] = ['today', 'portfolio', 'plan', 'news', 'settings'];

export interface ScreenProps {
  data: AppData;
  source: DataSource;
  reload: () => Promise<void>;
  go: (r: Route) => void;
}

const readRoute = (): Route => {
  const r = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] as Route;
  return ROUTES.includes(r) ? r : 'today';
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
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    // A tapped notification asks an already-open app to show its screen.
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open' && typeof e.data.url === 'string') location.hash = e.data.url.split('#')[1] ?? '/today';
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => {
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
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [source, reload]);

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
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      {demo && (
        <div className="safe-top bg-amber-100 px-4 py-2 text-center text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Demo: your seed portfolio with PSX prices from the Oct 5, 2026 close. <button className="font-semibold underline" onClick={exitDemo}>Sign in</button>
        </div>
      )}
      <main className={`flex-1 space-y-5 px-4 pb-28 ${demo ? 'pt-4' : 'safe-top pt-4'}`}>
        {error && !data && (
          <div className="space-y-3 pt-10 text-center">
            <p className="text-sm text-rose-700 dark:text-rose-400">Couldn't load your data: {error}</p>
            <button className="text-sm font-semibold text-teal-700 underline" onClick={reload}>Try again</button>
          </div>
        )}
        {!props && !error && <Splash inline />}
        {props && route === 'today' && <Today {...props} />}
        {props && route === 'portfolio' && <Portfolio {...props} />}
        {props && route === 'plan' && <PlanScreen {...props} />}
        {props && route === 'news' && <News {...props} />}
        {props && route === 'settings' && <SettingsScreen {...props} onExitDemo={exitDemo} />}
      </main>
      <Nav route={route} go={go} />
    </div>
  );
}

function Splash({ inline }: { inline?: boolean }) {
  return (
    <div className={`flex items-center justify-center ${inline ? 'pt-24' : 'min-h-dvh'}`}>
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-teal-700 border-t-transparent" aria-label="Loading" />
    </div>
  );
}

const NAV: { route: Route; label: string; icon: string }[] = [
  { route: 'today', label: 'Today', icon: 'M3 12l9-9 9 9M5 10v10h14V10' },
  { route: 'portfolio', label: 'Portfolio', icon: 'M4 7h16v13H4zM9 7V4h6v3' },
  { route: 'plan', label: 'Plan', icon: 'M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01' },
  { route: 'news', label: 'News', icon: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5' },
  { route: 'settings', label: 'Settings', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 000 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z' },
];

function Nav({ route, go }: { route: Route; go: (r: Route) => void }) {
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
      <ul className="mx-auto flex max-w-md">
        {NAV.map((n) => (
          <li key={n.route} className="flex-1">
            <button onClick={() => go(n.route)} aria-current={route === n.route ? 'page' : undefined}
              className={`flex w-full flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${route === n.route ? 'text-teal-700 dark:text-teal-400' : 'text-slate-500 dark:text-slate-400'}`}>
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={n.icon} /></svg>
              {n.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
