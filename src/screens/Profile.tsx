import { useEffect, useState, type ReactNode } from 'react';
import type { ScreenProps } from '../App.tsx';
import { supabase } from '../lib/data.ts';
import { config, isIOS } from '../lib/config.ts';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push.ts';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme.ts';
import { asOfLabel } from '../../shared/format.ts';
import type { Settings } from '../../shared/types.ts';
import { Icon, type IconName } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { Button, Card, Disclaimer, ErrorNote, Section, Segmented, Toggle, inputCls } from '../components/ui.tsx';

/** A settings row: icon, label + hint, control on the right. */
function Row({ icon, label, hint, children }: { icon: IconName; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"><Icon name={icon} className="h-[18px] w-[18px]" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">{label}</p>
        {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** Number that saves when you leave the field (or press Enter). */
function NumberInput({ value, onSave, min, max, prefix, suffix, label, width = 'w-28' }: {
  value: number; onSave: (v: number) => Promise<void>; min: number; max: number; prefix?: string; suffix?: string; label: string; width?: string;
}) {
  const show = (v: number) => v.toLocaleString('en-PK');
  const [text, setText] = useState(show(value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(show(value)), [value]);
  const commit = async () => {
    const v = Number(text.replace(/[,\s]/g, ''));
    if (!Number.isFinite(v) || v < min || v > max) { setBad(true); return; }
    setBad(false);
    if (v !== value) await onSave(v);
  };
  return (
    <span className={`relative ${width}`}>
      {prefix && <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-slate-400">{prefix}</span>}
      <input aria-label={label} aria-invalid={bad} inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className={`${inputCls} num text-right ${prefix ? 'pl-9' : ''} ${suffix ? 'pr-8' : ''} ${bad ? 'border-rose-500' : ''}`} />
      {suffix && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-slate-400">{suffix}</span>}
    </span>
  );
}

export function Profile({ data, source, reload, onExitDemo }: ScreenProps & { onExitDemo: () => void }) {
  const toast = useToast();
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const s = data.settings;
  const save = async (patch: Partial<Settings>) => {
    try { await source.saveSettings(patch); await reload(); toast('Saved'); } catch (e) { toast((e as Error).message); }
  };
  const initial = (data.email ?? '?').slice(0, 1).toUpperCase();

  return (
    <>
      <header className="flex items-center gap-4">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-emerald-600 text-xl font-bold text-white">{source.kind === 'demo' ? 'D' : initial}</span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold">{source.kind === 'demo' ? 'Demo account' : data.email}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Last market check {data.lastRun ? `${asOfLabel(data.lastRun.started_at)}${data.lastRun.ok === false ? ' (PSX unavailable)' : ''}` : 'not yet'}
          </p>
        </div>
      </header>

      <Section title="Appearance">
        <Segmented label="Appearance" value={theme} onChange={(v) => { setTheme(v); setThemePref(v); }}
          options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </Section>

      <Section title="Money">
        <Card className="divide-y divide-slate-100 py-0 dark:divide-slate-800">
          <Row icon="coins" label="Monthly investment" hint="Your SIP. The portfolio shows how much is invested so far this month.">
            <NumberInput label="Monthly investment" prefix="Rs" value={s.monthly_budget_pkr} min={0} max={10_000_000} width="w-36" onSave={(v) => save({ monthly_budget_pkr: v })} />
          </Row>
          <Row icon="shield" label="Crash fund" hint="Kept apart; only suggested on a crash.">
            <NumberInput label="Crash fund" prefix="Rs" value={s.crash_fund_pkr} min={0} max={100_000_000} width="w-36" onSave={(v) => save({ crash_fund_pkr: v })} />
          </Row>
          <Row icon="down" label="Crash level" hint="KSE-100 below this suggests half the crash fund.">
            <NumberInput label="Crash level" value={s.crash_trigger_kse} min={1000} max={1_000_000} width="w-32" onSave={(v) => save({ crash_trigger_kse: v })} />
          </Row>
        </Card>
      </Section>

      <Section title="Your rules">
        <Card className="divide-y divide-slate-100 py-0 dark:divide-slate-800">
          <Row icon="scale" label="Max per stock" hint="No new money above this share of the portfolio.">
            <NumberInput label="Max per stock" suffix="%" value={s.max_position_pct} min={1} max={100} width="w-24" onSave={(v) => save({ max_position_pct: v })} />
          </Row>
          <Row icon="bag" label="Opportunity alert" hint="Tell me when a stock is this far below my last buy.">
            <NumberInput label="Opportunity alert" suffix="%" value={s.drop_alert_pct} min={1} max={99} width="w-24" onSave={(v) => save({ drop_alert_pct: v })} />
          </Row>
          <Row icon="shield" label="Shariah-compliant only" hint="Discover and AI suggest only KMI All Share stocks.">
            <Toggle label="Shariah-compliant only" checked={s.shariah_only} onChange={(v) => save({ shariah_only: v })} />
          </Row>
        </Card>
      </Section>

      <Notifications data={data} source={source} reload={reload} save={save} />

      <Section title="AI Assistant">
        <Card className="py-0">
          <Row icon="sparkles" label="AI suggestions" hint="Uses Groq and Google Gemini free tiers, which may use what they receive to improve their products. They get symbols, share counts and costs, never your name or email.">
            <Toggle label="AI suggestions" checked={!!s.ai_enabled} onChange={(v) => save({ ai_enabled: v })} />
          </Row>
        </Card>
      </Section>

      <Card className="py-1">
        {source.kind === 'demo'
          ? <button type="button" onClick={onExitDemo} className="flex min-h-12 w-full cursor-pointer items-center gap-3 font-semibold text-teal-700 dark:text-teal-400"><Icon name="user" />Sign in or create an account</button>
          : <button type="button" onClick={() => supabase().auth.signOut()} className="flex min-h-12 w-full cursor-pointer items-center gap-3 font-semibold text-rose-600 dark:text-rose-400"><Icon name="logout" />Sign out</button>}
      </Card>
      <Disclaimer />
    </>
  );
}

function Notifications({ data, source, reload, save }: Pick<ScreenProps, 'data' | 'source' | 'reload'> & { save: (p: Partial<Settings>) => Promise<void> }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => { pushState().then(setState); }, []);
  const s = data.settings;

  async function togglePush() {
    setBusy(true);
    setError(null);
    try {
      if (state === 'on') await disablePush(source); else await enablePush(source);
      setState(await pushState());
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function linkTelegram() {
    setError(null);
    try { setCode(await source.createTelegramCode()); } catch (e) { setError((e as Error).message); }
  }
  const pushHint = {
    unsupported: 'Not supported in this browser', 'needs-install': 'Add the app to your Home Screen first',
    denied: isIOS() ? 'Blocked: iPhone Settings → Notifications → PSX Assist' : 'Blocked: site settings → Notifications → Allow', off: 'Off on this phone', on: 'On for this phone',
  };

  return (
    <Section title="Notifications">
      <Card className="divide-y divide-slate-100 py-0 dark:divide-slate-800">
        <Row icon="bell" label="Push on this phone" hint={state ? pushHint[state] : '…'}>
          {(state === 'on' || state === 'off') && <Toggle label="Push on this phone" checked={state === 'on'} onChange={() => !busy && togglePush()} />}
        </Row>
        <Row icon="alert" label="Send me alerts" hint="Market-hours alerts (max 3 a day) and the 9 PM digest. Crash alerts always come through.">
          <Toggle label="Send me alerts" checked={s.notifications_enabled} onChange={(v) => save({ notifications_enabled: v })} />
        </Row>
        <Row icon="moon" label="Quiet hours" hint={`${s.quiet_hours.start} to ${s.quiet_hours.end}, except crash alerts`}>
          <span className="flex gap-1">
            <input aria-label="Quiet from" type="time" className={`${inputCls} w-[6.5rem] px-2`} defaultValue={s.quiet_hours.start} onBlur={(e) => e.target.value !== s.quiet_hours.start && save({ quiet_hours: { ...s.quiet_hours, start: e.target.value } })} />
            <input aria-label="Quiet until" type="time" className={`${inputCls} w-[6.5rem] px-2`} defaultValue={s.quiet_hours.end} onBlur={(e) => e.target.value !== s.quiet_hours.end && save({ quiet_hours: { ...s.quiet_hours, end: e.target.value } })} />
          </span>
        </Row>
        <Row icon="send" label="Telegram backup" hint={data.telegramLinked ? 'Linked' : 'Same alerts in Telegram'}>
          {!data.telegramLinked && !code && <Button kind="secondary" className="min-h-9" onClick={linkTelegram}>Link</Button>}
          {data.telegramLinked && <Icon name="check" className="h-5 w-5 text-emerald-500" label="Linked" />}
        </Row>
        {code && (
          <div className="space-y-1 py-3 text-sm">
            {config.telegramBot
              ? <a className="font-semibold text-teal-700 underline dark:text-teal-400" href={`https://t.me/${config.telegramBot}?start=${code}`} target="_blank" rel="noopener noreferrer">Open @{config.telegramBot} and tap Start</a>
              : <p>Send this code to the bot: <span className="font-mono font-bold">{code}</span></p>}
            <p className="text-xs text-slate-500 dark:text-slate-400">The code works for 15 minutes; linking finishes within about 20. <button type="button" className="cursor-pointer font-semibold underline" onClick={reload}>Check</button></p>
          </div>
        )}
      </Card>
      <ErrorNote error={error} />
    </Section>
  );
}
