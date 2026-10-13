import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { dedupeFilings, groupByDay, tidyTitle } from '../../shared/news.ts';
import { pktDate } from '../../shared/time.ts';
import { asOfLabel } from '../../shared/format.ts';
import type { AlertLogRow, Announcement } from '../../shared/types.ts';
import { AiBadge } from '../components/AiCard.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Card, Empty, Segmented, SymbolAvatar, Tag, type Tone } from '../components/ui.tsx';
import { useSwipeTabs } from '../lib/gestures.ts';

const KIND: Record<Announcement['kind'], { label: string; tone: Tone }> = {
  dividend: { label: 'Dividend', tone: 'green' }, results: { label: 'Results', tone: 'teal' },
  board_meeting: { label: 'Board meeting', tone: 'amber' }, other: { label: 'Notice', tone: 'slate' },
};

const ALERT_ICON = (kind: string): IconName =>
  kind.startsWith('crash') ? 'alert' : kind === 'buy_chance' || kind === 'dip' ? 'down' : kind.startsWith('ai') ? 'sparkles'
    : kind.startsWith('announcement') ? 'news' : kind.startsWith('dividend') ? 'coins' : kind === 'rebalance' || kind === 'over_cap' ? 'scale' : 'bell';

export function News({ data }: ScreenProps) {
  const [tab, setTab] = useState<'news' | 'alerts'>('news');
  const [all, setAll] = useState(false);
  const today = pktDate(new Date());
  const swipe = useSwipeTabs(2, tab === 'news' ? 0 : 1, (i) => setTab(i === 0 ? 'news' : 'alerts'));
  const news = useMemo(() => groupByDay(
    dedupeFilings(data.announcements.filter((a) => all || a.kind !== 'other')).sort((a, b) => b.published_at.localeCompare(a.published_at)),
    (a) => a.published_at, today), [data.announcements, all, today]);
  const alerts = useMemo(() => groupByDay(data.alerts, (a) => pktDate(new Date(a.sent_at)), today), [data.alerts, today]);

  return (
    <>
      <header className="space-y-3">
        <h1 className="text-xl font-bold tracking-tight">News</h1>
        <Segmented label="News" value={tab} onChange={setTab} options={[{ value: 'news', label: 'Company news' }, { value: 'alerts', label: 'Your alerts' }]} />
      </header>
      <div {...swipe} className="touch-pan-y space-y-5">
        {tab === 'news' ? (
          <>
            <div className="flex flex-wrap gap-2">
              {[{ v: false, l: 'Dividends, results, meetings' }, { v: true, l: 'Everything' }].map((o) => (
                <button key={o.l} type="button" onClick={() => setAll(o.v)} aria-pressed={all === o.v}
                  className={`min-h-9 cursor-pointer rounded-full px-3 text-sm font-medium ${all === o.v ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'bg-slate-200/70 dark:bg-slate-800'}`}>{o.l}</button>
              ))}
            </div>
            {news.length ? news.map((g) => (
              <section key={g.label} className="space-y-2">
                <h2 className="px-1 text-[13px] font-semibold text-slate-500 dark:text-slate-400">{g.label}</h2>
                {g.items.map((a) => <NewsCard key={a.id} a={a} />)}
              </section>
            )) : <Empty title="No news for your stocks yet">Filings are checked every 30 minutes in market hours; the AI reads the important ones.</Empty>}
          </>
        ) : alerts.length ? alerts.map((g) => (
          <section key={g.label} className="space-y-2">
            <h2 className="px-1 text-[13px] font-semibold text-slate-500 dark:text-slate-400">{g.label}</h2>
            <Card className="divide-y divide-slate-100 py-1 dark:divide-slate-800">
              {g.items.map((a) => <AlertItem key={a.dedupe_key} a={a} />)}
            </Card>
          </section>
        )) : <Empty title="No alerts yet">Market alerts arrive during trading hours; the digest at 9 PM.</Empty>}
      </div>
    </>
  );
}

function NewsCard({ a }: { a: Announcement }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="flex gap-3">
        <SymbolAvatar symbol={a.symbol} size="h-10 w-10" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{a.symbol}</span>
            <Tag tone={KIND[a.kind].tone}>{KIND[a.kind].label}</Tag>
            {a.ai_summary && <AiBadge />}
          </div>
          <p className="mt-1 text-[15px] leading-snug">{a.ai_summary ?? tidyTitle(a.title, a.symbol)}</p>
          {a.ai_summary && <p className="mt-1 line-clamp-1 text-xs text-slate-500 dark:text-slate-400">{tidyTitle(a.title, a.symbol)}</p>}
          {!!a.ai_figures?.length && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(open ? a.ai_figures : a.ai_figures.slice(0, 3)).map((f) => (
                <Tag key={f.label} tone={f.verified ? 'teal' : 'slate'}>{f.verified && <Icon name="check" className="h-3 w-3" label="checked against the PDF" />}{f.label}: {f.value}</Tag>
              ))}
              {a.ai_figures.length > 3 && !open && <button type="button" className="cursor-pointer text-xs font-semibold text-teal-700 dark:text-teal-400" onClick={() => setOpen(true)}>+{a.ai_figures.length - 3}</button>}
            </div>
          )}
          <div className="mt-2 flex items-center justify-between">
            {a.ai_summary && a.ai_verified === false ? <span className="text-[11px] text-amber-700 dark:text-amber-400">Some figures not checked (scanned PDF)</span> : <span />}
            {a.pdf_url && <a href={a.pdf_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 text-sm font-semibold text-teal-700 dark:text-teal-400">PDF <Icon name="external" className="h-4 w-4" /></a>}
          </div>
        </div>
      </div>
    </Card>
  );
}

function AlertItem({ a }: { a: AlertLogRow }) {
  return (
    <div className="flex gap-3 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"><Icon name={ALERT_ICON(a.kind)} className="h-4 w-4" /></span>
      <div className="min-w-0">
        <p className="text-sm">{a.message}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {asOfLabel(a.sent_at)} · {a.channel === 'none' ? 'in the app only (daily limit)' : a.channel === 'both' ? 'push + Telegram' : a.channel === 'telegram' ? 'Telegram' : 'push'}
        </p>
      </div>
    </div>
  );
}
