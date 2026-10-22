/**
 * "Refresh latest": runs the whole system now on the server: PSX prices and screen, company pages, filings read by
 * the AI, fresh AI suggestions, Discover picks and a blue-chip recheck of your stocks. Starts the run, follows it
 * (worker_runs) and reloads the app when it finishes. At most one every 10 minutes; never sends notifications.
 */
import { useEffect, useRef, useState } from 'react';
import type { DataSource, WorkerRun } from '../lib/data.ts';
import { dayTime } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';
import { Icon } from './Icon.tsx';
import { Button } from './ui.tsx';

type Phase = { kind: 'idle' } | { kind: 'running'; since: string } | { kind: 'done'; ok: boolean } | { kind: 'error'; text: string };
const POLL_MS = 15_000;
const STEPS = ['PSX prices and market screen', 'Company pages and annual results', 'Filings read by the AI', 'AI suggestions and Discover picks', 'Blue-chip checks'];

export function RefreshLatest({ source, last, reload }: { source: DataSource; last: WorkerRun | null; reload: () => Promise<void> }) {
  const [phase, setPhase] = useState<Phase>(() => (last && !last.finished_at && Date.now() - Date.parse(last.started_at) < 30 * 60_000 ? { kind: 'running', since: last.started_at } : { kind: 'idle' }));
  const [tick, setTick] = useState(0);
  const timer = useRef<number | null>(null);

  // Follow the run: a refresh started after `since` that has finished means done.
  useEffect(() => {
    if (phase.kind !== 'running') return;
    const since = Date.parse(phase.since) - 60_000; // the job can start a little before our clock says
    const poll = async () => {
      try {
        const run = await source.refreshRun();
        if (run && Date.parse(run.started_at) >= since && run.finished_at) {
          setPhase({ kind: 'done', ok: run.ok !== false });
          await reload();
          return;
        }
      } catch { /* try again on the next tick */ }
      setTick((t) => t + 1);
      timer.current = window.setTimeout(poll, POLL_MS);
    };
    timer.current = window.setTimeout(poll, POLL_MS);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [phase, source, reload]);

  async function start() {
    haptic();
    try {
      const r = await source.refreshAll();
      if (r.status === 'started') setPhase({ kind: 'running', since: r.requested_at });
      else if (r.status === 'running') setPhase({ kind: 'running', since: r.started_at });
      else if (r.status === 'recent') setPhase({ kind: 'error', text: `Refreshed a few minutes ago. Try again in ${r.retry_in_min} min.` });
      else setPhase({ kind: 'error', text: r.status === 'not_configured' ? 'Refresh is not switched on yet: the server needs its GitHub token (one command, see the note in the app guide).' : r.error });
    } catch (e) {
      setPhase({ kind: 'error', text: (e as Error).message });
    }
  }

  const running = phase.kind === 'running';
  const elapsed = running ? Math.max(0, Math.round((Date.now() - Date.parse(phase.since)) / 60_000)) : 0;
  return (
    <div className="space-y-3 py-3">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <Icon name="refresh" className={`h-[18px] w-[18px] ${running ? 'animate-spin [animation-duration:1.4s]' : ''}`} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-16 font-medium">Refresh latest</p>
          <p className="text-14 text-muted">
            Runs everything now: prices, filings, AI, blue chips. {last?.finished_at ? `Last refresh ${dayTime(last.started_at)}.` : 'Not run yet.'}
          </p>
        </div>
        <Button kind="secondary" className="min-h-11 shrink-0" disabled={running} onClick={start}>{running ? 'Running…' : 'Refresh'}</Button>
      </div>
      {running && (
        <div className="rounded-control bg-surface-2 p-3 text-14" role="status" aria-live="polite" data-tick={tick}>
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-line"><div className="refresh-bar h-full w-1/3 rounded-full bg-brand" /></div>
          <p className="font-medium">Working on it{elapsed ? ` · ${elapsed} min` : ''}. Usually 3 to 8 minutes; you can leave this screen.</p>
          <ul className="mt-1 space-y-0.5 text-muted">{STEPS.map((s) => <li key={s}>· {s}</li>)}</ul>
        </div>
      )}
      {phase.kind === 'done' && (
        <p className={`flex items-center gap-1.5 text-14 ${phase.ok ? 'text-ink' : 'text-caution'}`} role="status">
          <Icon name={phase.ok ? 'check' : 'alert'} className="h-4 w-4 shrink-0" />
          {phase.ok ? 'Everything is up to date.' : 'Finished, but PSX or the AI did not answer everything; what did arrive is shown.'}
        </p>
      )}
      {phase.kind === 'error' && <p className="flex items-center gap-1.5 text-14 text-caution" role="alert"><Icon name="alert" className="h-4 w-4 shrink-0" />{phase.text}</p>}
    </div>
  );
}
