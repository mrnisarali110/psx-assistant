import { useEffect, useState, type FormEvent } from 'react';
import type { ScreenProps } from '../App.tsx';
import { supabase } from '../lib/data.ts';
import { config, isIOS } from '../lib/config.ts';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push.ts';
import { asOfLabel } from '../../shared/format.ts';
import type { Settings } from '../../shared/types.ts';
import { Button, Card, ErrorNote, Field, Section, inputCls } from '../components/ui.tsx';

export function SettingsScreen({ data, source, reload, onExitDemo }: ScreenProps & { onExitDemo: () => void }) {
  return (
    <>
      <header><h1 className="text-xl font-bold">Settings</h1></header>
      <Notifications {...{ data, source, reload }} />
      <Thresholds {...{ data, source, reload }} />
      <Section title="Account">
        <Card className="space-y-3">
          <p className="text-sm">{source.kind === 'demo' ? 'Demo mode (nothing is saved)' : `Signed in as ${data.email}`}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Last data refresh: {data.lastRun ? `${asOfLabel(data.lastRun.started_at)} (${data.lastRun.job}${data.lastRun.ok === false ? ', PSX unavailable' : ''})` : 'none yet'}
          </p>
          {source.kind === 'demo'
            ? <Button onClick={onExitDemo}>Sign in or create an account</Button>
            : <Button kind="secondary" onClick={() => supabase().auth.signOut()}>Sign out</Button>}
        </Card>
      </Section>
      <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
        This app gives suggestions only and never trades or asks for broker logins. Not licensed financial advice.
      </p>
    </>
  );
}

function Notifications({ data, source, reload }: Pick<ScreenProps, 'data' | 'source' | 'reload'>) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => { pushState().then(setState); }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (state === 'on') await disablePush(source);
      else await enablePush(source);
      setState(await pushState());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function linkTelegram() {
    setError(null);
    try {
      setCode(await source.createTelegramCode());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const label = { unsupported: 'Not supported in this browser', 'needs-install': 'Install the app first', denied: 'Blocked in phone settings', off: 'Off', on: 'On' };
  return (
    <Section title="Notifications">
      <Card className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium">Push alerts on this phone</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">{state ? label[state] : '…'}</p>
          </div>
          {(state === 'on' || state === 'off') && (
            <Button kind={state === 'on' ? 'secondary' : 'primary'} onClick={toggle} disabled={busy}>
              {state === 'on' ? 'Turn off' : 'Enable notifications'}
            </Button>
          )}
        </div>
        {state === 'needs-install' && (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            On iPhone: open this site in Safari, tap Share, then “Add to Home Screen”. Open the installed app and come back here.
          </p>
        )}
        {state === 'denied' && (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {isIOS() ? 'iPhone Settings → Notifications → PSX Assist → Allow.' : 'Site settings → Notifications → Allow, then reopen the app.'}
          </p>
        )}
        <div className="border-t border-slate-100 pt-4 dark:border-slate-800">
          <p className="font-medium">Telegram backup</p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {data.telegramLinked ? 'Linked: alerts also arrive in Telegram.' : 'Same alerts in Telegram, useful if phone notifications are unreliable.'}
          </p>
          {!data.telegramLinked && !code && <Button kind="secondary" className="mt-2" onClick={linkTelegram}>Link Telegram</Button>}
          {code && (
            <div className="mt-2 space-y-2 rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800">
              {config.telegramBot ? (
                <>
                  <a className="block font-semibold text-teal-700 underline dark:text-teal-400" href={`https://t.me/${config.telegramBot}?start=${code}`} target="_blank" rel="noopener noreferrer">
                    Open @{config.telegramBot} and tap Start
                  </a>
                  <p>Or send it this code: <span className="font-mono font-bold">{code}</span></p>
                </>
              ) : (
                <p>Send this code to the bot: <span className="font-mono font-bold">{code}</span></p>
              )}
              <p className="text-xs text-slate-500 dark:text-slate-400">The code works for 15 minutes. Linking finishes within about 20 minutes.</p>
              <button className="text-xs font-semibold underline" onClick={reload}>Check again</button>
            </div>
          )}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">At most 3 notifications a day; dips are bundled. Crash alerts always come through, even in quiet hours.</p>
        <ErrorNote error={error} />
      </Card>
    </Section>
  );
}

type Form = Record<'monthly_budget_pkr' | 'crash_fund_pkr' | 'crash_trigger_kse' | 'max_position_pct' | 'drop_alert_pct' | 't1' | 't2' | 't3' | 'd2' | 'd3' | 'quiet_start' | 'quiet_end', string> & { shariah_only: boolean; notifications_enabled: boolean };

function Thresholds({ data, source, reload }: Pick<ScreenProps, 'data' | 'source' | 'reload'>) {
  const s = data.settings;
  const ts = s.tranche_split;
  const initial: Form = {
    monthly_budget_pkr: String(s.monthly_budget_pkr), crash_fund_pkr: String(s.crash_fund_pkr), crash_trigger_kse: String(s.crash_trigger_kse),
    max_position_pct: String(s.max_position_pct), drop_alert_pct: String(s.drop_alert_pct),
    t1: String(ts[0]?.pct ?? 40), t2: String(ts[1]?.pct ?? 40), t3: String(ts[2]?.pct ?? 20),
    d2: String(ts[1]?.after_days ?? 14), d3: String(ts[2]?.after_days ?? 25),
    quiet_start: s.quiet_hours.start, quiet_end: s.quiet_hours.end, shariah_only: s.shariah_only, notifications_enabled: s.notifications_enabled,
  };
  const [f, setF] = useState<Form>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setSaved(false); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = (k: keyof Form) => Number(f[k]);
    const split = [n('t1'), n('t2'), n('t3')];
    if (split.some((x) => !(x >= 0)) || split.reduce((a, b) => a + b, 0) !== 100) return setError('Tranche percentages must add up to 100.');
    if (!(n('max_position_pct') > 0 && n('max_position_pct') <= 100)) return setError('Max position must be between 1 and 100%.');
    if (!(n('drop_alert_pct') > 0 && n('drop_alert_pct') < 100)) return setError('Below-cost alert must be between 1 and 99%.');
    if (!/^\d{2}:\d{2}$/.test(f.quiet_start) || !/^\d{2}:\d{2}$/.test(f.quiet_end)) return setError('Quiet hours look like 23:00.');
    const patch: Partial<Settings> = {
      monthly_budget_pkr: n('monthly_budget_pkr'), crash_fund_pkr: n('crash_fund_pkr'), crash_trigger_kse: n('crash_trigger_kse'),
      max_position_pct: n('max_position_pct'), drop_alert_pct: n('drop_alert_pct'),
      tranche_split: [{ pct: split[0], after_days: 0 }, { pct: split[1], after_days: n('d2') }, { pct: split[2], after_days: n('d3') }],
      quiet_hours: { start: f.quiet_start, end: f.quiet_end }, shariah_only: f.shariah_only, notifications_enabled: f.notifications_enabled,
    };
    try {
      await source.saveSettings(patch);
      setError(null);
      setSaved(true);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const num = (k: keyof Form, label: string, hint?: string) => (
    <Field label={label} hint={hint}><input className={`${inputCls} num`} inputMode="decimal" value={f[k] as string} onChange={set(k)} /></Field>
  );
  return (
    <Section title="Your rules">
      <Card>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {num('monthly_budget_pkr', 'Monthly budget (Rs)')}
            {num('crash_fund_pkr', 'Crash fund (Rs)')}
            {num('crash_trigger_kse', 'Crash level (KSE-100)')}
            {num('max_position_pct', 'Max per stock (%)')}
            {num('drop_alert_pct', 'Below-cost alert (%)')}
          </div>
          <Field label="Tranches (% now / % later / % buffer)" hint={`Second after ${f.d2} days, buffer after ${f.d3} days. Must add up to 100.`}>
            <div className="grid grid-cols-3 gap-2">
              <input className={`${inputCls} num`} inputMode="numeric" value={f.t1} onChange={set('t1')} aria-label="Tranche 1 percent" />
              <input className={`${inputCls} num`} inputMode="numeric" value={f.t2} onChange={set('t2')} aria-label="Tranche 2 percent" />
              <input className={`${inputCls} num`} inputMode="numeric" value={f.t3} onChange={set('t3')} aria-label="Buffer percent" />
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            {num('d2', 'Tranche 2 after (days)')}
            {num('d3', 'Buffer after (days)')}
            <Field label="Quiet from"><input className={inputCls} type="time" value={f.quiet_start} onChange={set('quiet_start')} /></Field>
            <Field label="Quiet until"><input className={inputCls} type="time" value={f.quiet_end} onChange={set('quiet_end')} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-5 w-5 accent-teal-700" checked={f.shariah_only} onChange={(e) => { setF({ ...f, shariah_only: e.target.checked }); setSaved(false); }} />
            Shariah-compliant stocks only
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-5 w-5 accent-teal-700" checked={f.notifications_enabled} onChange={(e) => { setF({ ...f, notifications_enabled: e.target.checked }); setSaved(false); }} />
            Send me notifications (all devices)
          </label>
          <ErrorNote error={error} />
          <Button type="submit">{saved ? 'Saved ✓' : 'Save rules'}</Button>
        </form>
      </Card>
    </Section>
  );
}
