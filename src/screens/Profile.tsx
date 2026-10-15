import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ScreenProps } from '../App.tsx';
import { supabase } from '../lib/data.ts';
import { config, isIOS } from '../lib/config.ts';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push.ts';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme.ts';
import { asOfLabel, rs, rsShort } from '../../shared/format.ts';
import { projectWealth } from '../../shared/growth.ts';
import { buildPortfolio, screenSectors } from '../../shared/portfolio.ts';
import { previousTaxYears, taxYear } from '../../shared/tax.ts';
import { pktDate } from '../../shared/time.ts';
import { DEFAULT_RULES, type Settings } from '../../shared/types.ts';
import { GrowthCard } from '../components/Growth.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { useToast } from '../components/Toast.tsx';
import { Button, Card, Disclaimer, ErrorNote, Section, Segmented, Toggle, inputCls } from '../components/ui.tsx';
import { haptic } from '../lib/gestures.ts';

/** A settings row: icon, label + hint, control on the right. */
function Row({ icon, label, hint, children, onClick }: { icon: IconName; label: string; hint?: ReactNode; children?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"><Icon name={icon} className="h-[18px] w-[18px]" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">{label}</p>
        {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
      </div>
      {children}
    </>
  );
  return onClick
    ? <button type="button" onClick={() => { haptic(); onClick(); }} className="flex min-h-14 w-full cursor-pointer items-center gap-3 py-3 text-left active:opacity-70">{body}</button>
    : <div className="flex items-center gap-3 py-3">{body}</div>;
}

/** Number that saves when you leave the field (or press Enter). */
function NumberInput({ value, onSave, min, max, prefix, suffix, label, width = 'w-28', decimals }: {
  value: number; onSave: (v: number) => Promise<void>; min: number; max: number; prefix?: string; suffix?: string; label: string; width?: string; decimals?: number;
}) {
  const show = (v: number) => v.toLocaleString('en-PK', { maximumFractionDigits: decimals ?? 2 });
  const [text, setText] = useState(show(value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(show(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = async () => {
    const v = Number(text.replace(/[,\s]/g, ''));
    if (!Number.isFinite(v) || v < min || v > max) { setBad(true); return; }
    setBad(false);
    if (v !== value) await onSave(v);
  };
  return (
    <span className={`relative ${width}`}>
      {prefix && <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-slate-400">{prefix}</span>}
      <input aria-label={label} aria-invalid={bad} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className={`${inputCls} num text-right ${prefix ? 'pl-9' : ''} ${suffix ? 'pr-8' : ''} ${bad ? 'border-rose-500' : ''}`} />
      {suffix && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-slate-400">{suffix}</span>}
    </span>
  );
}

/** Short text that saves when you leave the field. */
function TextInput({ value, onSave, label, maxLength = 40, width = 'w-36' }: { value: string; onSave: (v: string) => Promise<void>; label: string; maxLength?: number; width?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = async () => { const v = text.trim(); if (v && v !== value) await onSave(v); else setText(value); };
  return (
    <span className={`block shrink-0 ${width}`}>
      <input aria-label={label} value={text} maxLength={maxLength} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className={`${inputCls} text-right`} />
    </span>
  );
}

export function Profile({ data, source, reload, onExitDemo }: ScreenProps & { onExitDemo: () => void }) {
  const toast = useToast();
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const [goals, setGoals] = useState(false);
  const s = data.settings;
  const save = async (patch: Partial<Settings>) => {
    try { await source.saveSettings(patch); await reload(); toast('Saved'); } catch (e) { toast((e as Error).message); }
  };
  const initial = (data.email ?? '?').slice(0, 1).toUpperCase();
  const today = pktDate(new Date());
  const year = taxYear(today);
  const priorYears = previousTaxYears(year, DEFAULT_RULES.tax.loss_carry_forward_years);
  const value = useMemo(() => buildPortfolio(data.holdings, data.prices, s, DEFAULT_RULES, screenSectors(data.screen)).total_value, [data, s]);
  const tenYears = projectWealth({ start: value, monthly: s.monthly_budget_pkr, annualReturnPct: 15, years: 10, stepUpPct: s.sip_step_up_pct }).final;

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
          <Row icon="coins" label="Monthly investment" hint="Your SIP. Home shows how much is invested so far this month.">
            <NumberInput label="Monthly investment" prefix="Rs" value={s.monthly_budget_pkr} min={0} max={10_000_000} width="w-36" decimals={0} onSave={(v) => save({ monthly_budget_pkr: v })} />
          </Row>
          <Row icon="up" label="Yearly increase" hint="Raise the monthly investment by this much every year, e.g. 10% as your income grows.">
            <NumberInput label="Yearly increase" suffix="%" value={s.sip_step_up_pct} min={0} max={100} width="w-24" onSave={(v) => save({ sip_step_up_pct: v })} />
          </Row>
          <Row icon="shield" label="Crash fund" hint="Kept apart; only suggested on a crash.">
            <NumberInput label="Crash fund" prefix="Rs" value={s.crash_fund_pkr} min={0} max={100_000_000} width="w-36" decimals={0} onSave={(v) => save({ crash_fund_pkr: v })} />
          </Row>
          <Row icon="down" label="Crash level" hint="KSE-100 below this suggests half the crash fund.">
            <NumberInput label="Crash level" value={s.crash_trigger_kse} min={1000} max={1_000_000} width="w-32" decimals={0} onSave={(v) => save({ crash_trigger_kse: v })} />
          </Row>
          <Row icon="growth" label="Goals & projection" hint={`In 10 years ≈ ${rsShort(tenYears)} at 15% a year, with today's ${rs(value)} and ${rs(s.monthly_budget_pkr)} a month.`} onClick={() => setGoals(true)}>
            <Icon name="chevron" className="h-5 w-5 shrink-0 text-slate-400" />
          </Row>
        </Card>
        <Sheet open={goals} onClose={() => setGoals(false)} title="Goals & projection">
          <div className="pb-2"><GrowthCard start={value} monthly={s.monthly_budget_pkr} stepUpPct={s.sip_step_up_pct} /></div>
        </Sheet>
      </Section>

      <Section title="Your rules">
        <Card className="divide-y divide-slate-100 py-0 dark:divide-slate-800">
          <Row icon="scale" label="Max per stock" hint="Soft cap: no new money above this share of the portfolio.">
            <NumberInput label="Max per stock" suffix="%" value={s.max_position_pct} min={1} max={100} width="w-24" onSave={(v) => save({ max_position_pct: v })} />
          </Row>
          <Row icon="scale" label="Max per sector" hint="Soft cap: no new money into a sector above this share.">
            <NumberInput label="Max per sector" suffix="%" value={s.max_sector_pct} min={1} max={100} width="w-24" onSave={(v) => save({ max_sector_pct: v })} />
          </Row>
          <Row icon="bag" label="Opportunity alert" hint="Tell me when a stock is this far below my last buy.">
            <NumberInput label="Opportunity alert" suffix="%" value={s.drop_alert_pct} min={1} max={99} width="w-24" onSave={(v) => save({ drop_alert_pct: v })} />
          </Row>
          <Row icon="shield" label="Shariah-compliant only" hint="Discover and AI suggest only KMI All Share stocks.">
            <Toggle label="Shariah-compliant only" checked={s.shariah_only} onChange={(v) => save({ shariah_only: v })} />
          </Row>
        </Card>
        <Card className="divide-y divide-slate-100 py-0 dark:divide-slate-800">
          <Row icon="tag" label="Hard cap per stock" hint="Above this a holding is marked Trim, with the reason.">
            <NumberInput label="Hard cap per stock" suffix="%" value={s.hard_stock_cap_pct} min={1} max={100} width="w-24" onSave={(v) => save({ hard_stock_cap_pct: v })} />
          </Row>
          <Row icon="tag" label="Hard cap per sector" hint="Above this the sector's biggest holding is marked Trim.">
            <NumberInput label="Hard cap per sector" suffix="%" value={s.hard_sector_cap_pct} min={1} max={100} width="w-24" onSave={(v) => save({ hard_sector_cap_pct: v })} />
          </Row>
          <Row icon="flag" label="Review after loss quarters" hint="Loss-making quarters in a row, from the results filings the AI reads. 0 turns it off.">
            <NumberInput label="Review after this many loss quarters" value={s.review_after_loss_quarters} min={0} max={12} width="w-20" decimals={0} onSave={(v) => save({ review_after_loss_quarters: v })} />
          </Row>
          <Row icon="alert" label="Sell after loss quarters" hint="Marks the holding Sell. 0 turns it off.">
            <NumberInput label="Sell after this many loss quarters" value={s.sell_after_loss_quarters} min={0} max={12} width="w-20" decimals={0} onSave={(v) => save({ sell_after_loss_quarters: v })} />
          </Row>
        </Card>
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">Sell and trim rules. A holding over its hard cap or at its target price is always marked Trim, with the reason; a review date reached marks it Review.</p>
        <Card className="divide-y divide-slate-100 py-0 dark:divide-slate-800">
          <Row icon="up" label="Trim when P/E runs ahead of its sector by" hint="Compared with the sector's typical P/E on the KSE-100 screen. 0 turns it off.">
            <NumberInput label="Trim when P/E is this much above its sector" suffix="%" value={s.trim_pe_over_sector_pct} min={0} max={500} width="w-24" onSave={(v) => save({ trim_pe_over_sector_pct: v })} />
          </Row>
          <Row icon="coins" label="Trim on a dividend cut" hint="The latest declared dividend is more than 10% below the previous one of its kind.">
            <Toggle label="Trim on a dividend cut" checked={s.trim_on_dividend_cut} onChange={(v) => save({ trim_on_dividend_cut: v })} />
          </Row>
        </Card>
      </Section>

      <Section title="Broker & tax">
        <Card className="divide-y divide-slate-100 py-0 dark:divide-slate-800">
          <Row icon="briefcase" label="Broker">
            <TextInput label="Broker" value={s.broker} onSave={(v) => save({ broker: v })} />
          </Row>
          <Row icon="coins" label="Commission" hint="Per side, % of trade value. PSX minimum 0.15%.">
            <NumberInput label="Commission" suffix="%" value={s.commission_pct} min={0} max={5} width="w-24" decimals={3} onSave={(v) => save({ commission_pct: v })} />
          </Row>
          <Row icon="coins" label="Minimum per share" hint="Whichever is higher applies: cheap shares cost more per rupee.">
            <NumberInput label="Minimum commission per share" prefix="Rs" value={s.min_commission_per_share} min={0} max={100} width="w-28" decimals={3} onSave={(v) => save({ min_commission_per_share: v })} />
          </Row>
          <Row icon="scale" label="Sales tax on commission" hint="Sindh 15%; some brokers show 13%.">
            <NumberInput label="Sales tax on commission" suffix="%" value={s.sales_tax_pct} min={0} max={100} width="w-24" onSave={(v) => save({ sales_tax_pct: v })} />
          </Row>
          <Row icon="user" label="Tax status" hint="On the Active Taxpayer List (filer): 15% capital gains tax and 15% dividend tax. Non-filer: 30% on dividends.">
            <Segmented label="Tax status" value={s.tax_filer ? 'filer' : 'non'} onChange={(v) => save({ tax_filer: v === 'filer' })}
              options={[{ value: 'filer', label: 'Filer' }, { value: 'non', label: 'Non-filer' }]} />
          </Row>
          <Row icon="check" label="Match NCCPL statement" hint="Count gains without broker charges, the way NCCPL's monthly CGT statement does.">
            <Toggle label="Match NCCPL statement" checked={s.match_nccpl} onChange={(v) => save({ match_nccpl: v })} />
          </Row>
          <Row icon="receipt" label={`CGT deducted in ${year}`} hint="From your monthly NCCPL statements, so Tax shows what is still due or refundable.">
            <NumberInput label={`CGT deducted in ${year}`} prefix="Rs" value={s.cgt_paid[year] ?? 0} min={0} max={100_000_000} width="w-32" decimals={0} onSave={(v) => save({ cgt_paid: { ...s.cgt_paid, [year]: v } })} />
          </Row>
          {priorYears.map((y) => (
            <Row key={y} icon="down" label={`Loss carried from ${y}`} hint={y === priorYears[0] ? 'Net loss of that tax year still unused (filers only, 3 years).' : undefined}>
              <NumberInput label={`Loss carried forward from ${y}`} prefix="Rs" value={s.loss_carry_forward[y] ?? 0} min={0} max={100_000_000} width="w-32" decimals={0}
                onSave={(v) => save({ loss_carry_forward: { ...s.loss_carry_forward, [y]: v } })} />
            </Row>
          ))}
        </Card>
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          Defaults come from PSX notice N-1026 and the FY 2026-27 tax rates; check them once against a real contract note and NCCPL statement. Nothing here is tax advice.
        </p>
      </Section>

      <Notifications data={data} source={source} reload={reload} save={save} />

      <Section title="AI Assistant">
        <Card className="py-0">
          <Row icon="sparkles" label="AI suggestions" hint="Uses the Groq, Google Gemini and OpenRouter free tiers, which may use what they receive to improve their products. They get symbols, share counts and costs, never your name or email.">
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
