/**
 * Profile: a short list of sections, each with a one-line summary, opening its own page at #/profile/<section>.
 * Phones show the list or one section (with a back link); a wide screen keeps the list beside the open section.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { ScreenProps } from '../App.tsx';
import { dayTime, rs } from '../../shared/format.ts';
import type { Settings } from '../../shared/types.ts';
import { parseHash, profileHref } from '../lib/nav.ts';
import { haptic } from '../lib/gestures.ts';
import { Icon, type IconName } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { Card } from '../components/ui.tsx';
import { AccountSection, Avatar } from './profile/Account.tsx';
import { AlertsSection } from './profile/Alerts.tsx';
import { BrokerSection } from './profile/Broker.tsx';
import { AiSection, AppearanceSection, DataSection, THEME_LABEL, useThemePref } from './profile/More.tsx';
import { PlanSection } from './profile/Plan.tsx';
import { RulesSection, activeRules } from './profile/Rules.tsx';

const SECTIONS = ['account', 'plan', 'rules', 'broker', 'alerts', 'ai', 'appearance', 'data'] as const;
type SectionId = (typeof SECTIONS)[number];
const isSection = (s: string | null | undefined): s is SectionId => (SECTIONS as readonly string[]).includes(s ?? '');

/** One line in the list: icon, name, summary, chevron. A link, so the phone's back button returns to the list. */
function Item({ id, icon, label, summary, active, lead }: { id: SectionId; icon: IconName; label: string; summary: string; active: boolean; lead?: ReactNode }) {
  return (
    <a href={profileHref(id)} onClick={() => haptic()} aria-current={active ? 'page' : undefined}
      className={`press flex min-h-14 cursor-pointer items-center gap-3 px-4 py-3 ${active ? 'lg:bg-brand/10' : 'hover:bg-surface-2'}`}>
      {lead ?? <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted"><Icon name={icon} className="h-[18px] w-[18px]" /></span>}
      <span className="min-w-0 flex-1">
        <span className={`block text-16 font-medium ${active ? 'lg:text-brand' : ''}`}>{label}</span>
        <span className="block truncate text-14 text-muted">{summary}</span>
      </span>
      <Icon name="chevron" className="h-5 w-5 shrink-0 text-muted" />
    </a>
  );
}

export function Profile({ data, source, reload, onExitDemo, section }: ScreenProps & { onExitDemo: () => void; section?: string | null }) {
  const toast = useToast();
  const [theme, setTheme] = useThemePref();
  // The app shell passes the section from the hash; until it does, follow the hash here.
  const [fromHash, setFromHash] = useState(() => parseHash(location.hash).sub);
  useEffect(() => {
    if (section !== undefined) return;
    const on = () => setFromHash(parseHash(location.hash).sub);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [section]);
  const raw = section !== undefined ? section : fromHash;
  const open = isSection(raw) ? raw : null;
  const shown: SectionId = open ?? 'plan'; // a wide screen always has a section open beside the list

  const s = data.settings;
  const demo = source.kind === 'demo';
  const save = async (patch: Partial<Settings>) => {
    try { await source.saveSettings(patch); await reload(); toast('Saved'); } catch (e) { toast((e as Error).message); }
  };
  const props = { data, source, reload, save };
  const rules = activeRules(s);
  const lastData = demo ? 'Saved prices from Oct 5'
    : data.lastRefresh?.finished_at ? `Last refresh ${dayTime(data.lastRefresh.started_at)}`
      : data.lastRun ? `Last market check ${dayTime(data.lastRun.started_at)}` : 'Not run yet';
  const item = (id: SectionId, icon: IconName, label: string, summary: string, lead?: ReactNode) =>
    <Item id={id} icon={icon} label={label} summary={summary} active={shown === id} lead={lead} />;

  const page = {
    account: <AccountSection {...props} onExitDemo={onExitDemo} />,
    plan: <PlanSection {...props} />,
    rules: <RulesSection {...props} />,
    broker: <BrokerSection {...props} />,
    alerts: <AlertsSection {...props} />,
    ai: <AiSection {...props} />,
    appearance: <AppearanceSection theme={theme} setTheme={setTheme} />,
    data: <DataSection {...props} />,
  }[shown];

  return (
    <div className="lg:grid lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start lg:gap-8">
      <nav aria-label="Profile sections" className={`space-y-4 lg:sticky lg:top-8 ${open ? 'hidden lg:block' : ''}`}>
        <h1 className="text-28 font-bold tracking-tight">Profile</h1>
        <Card className="overflow-hidden px-0 py-0">
          {item('account', 'user', 'Account', demo ? 'Demo account' : data.email ?? 'Signed in', <Avatar data={data} source={source} size="h-9 w-9 text-16" />)}
        </Card>
        <Card className="divide-y divide-line overflow-hidden px-0 py-0">
          {item('plan', 'coins', 'My plan', `${rs(s.monthly_budget_pkr)} a month${s.sip_step_up_pct > 0 ? ` · +${s.sip_step_up_pct}% a year` : ''}`)}
          {item('rules', 'scale', 'My rules', `${rules} rule${rules === 1 ? '' : 's'} active`)}
          {item('broker', 'briefcase', 'Broker & tax', `${s.broker} · ${s.tax_filer ? 'Filer' : 'Non-filer'} · ${s.commission_pct}% commission`)}
        </Card>
        <Card className="divide-y divide-line overflow-hidden px-0 py-0">
          {item('alerts', 'bell', 'Alerts', s.notifications_enabled ? `On · quiet ${s.quiet_hours.start} to ${s.quiet_hours.end}${data.telegramLinked ? ' · Telegram' : ''}` : 'Off')}
          {item('ai', 'sparkles', 'AI', s.ai_enabled ? 'Suggestions on' : 'Off')}
          {item('appearance', theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor', 'Appearance', THEME_LABEL[theme])}
          {item('data', 'refresh', 'Data', lastData)}
        </Card>
        {/* The phone's footer; on a wide screen the sidebar carries this line. */}
        <p className="px-1 text-12 text-muted lg:hidden">Suggestions only, not licensed financial advice. Check live prices in your broker app.</p>
      </nav>
      <div className={`lg:max-w-3xl ${open ? '' : 'hidden lg:block'}`}>{page}</div>
    </div>
  );
}
