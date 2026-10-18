import { useMemo, useState } from 'react';
import type { BcState } from '../../shared/bluechip.ts';
import { BcBadge } from '../components/BcBadge.tsx';
import type { ScreenProps } from '../App.tsx';
import { dedupeFilings, groupByDay, tidyTitle } from '../../shared/news.ts';
import { dateSane, dateVerdict, datesIn, tradingCalendar, weekAhead, type WeekEvent } from '../../shared/calendar.ts';
import { pktDate } from '../../shared/time.ts';
import { asOfLabel, dateLabel } from '../../shared/format.ts';
import { DEFAULT_RULES, type AlertLogRow, type Announcement } from '../../shared/types.ts';
import { AiBadge } from '../components/AiCard.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Card, Empty, Segmented, SymbolAvatar, Tag, chipCls, chipRowCls, type Tone } from '../components/ui.tsx';
import { useSwipeTabs } from '../lib/gestures.ts';

const KIND: Record<Announcement['kind'], { label: string; tone: Tone }> = {
  dividend: { label: 'Dividend', tone: 'green' }, results: { label: 'Results', tone: 'teal' },
  board_meeting: { label: 'Board meeting', tone: 'amber' }, other: { label: 'Notice', tone: 'slate' },
};

const ALERT_ICON = (kind: string): IconName =>
  kind.startsWith('crash') ? 'alert' : kind === 'buy_chance' || kind === 'dip' ? 'down' : kind.startsWith('ai') ? 'sparkles'
    : kind.startsWith('announcement') ? 'news' : kind.startsWith('dividend') ? 'coins' : kind === 'rebalance' || kind === 'over_cap' ? 'scale'
      : kind === 'trim' ? 'tag' : kind === 'review_due' ? 'flag' : 'bell';

type NewsFilter = 'important' | 'all' | 'week';
const FILTERS: { v: NewsFilter; l: string }[] = [{ v: 'important', l: 'Dividends, results, meetings' }, { v: 'week', l: 'My week' }, { v: 'all', l: 'Everything' }];

export function News({ data }: ScreenProps) {
  const [tab, setTab] = useState<'news' | 'alerts'>('news');
  const [filter, setFilter] = useState<NewsFilter>(() => (location.hash.includes('week') ? 'week' : 'important'));
  const today = pktDate(new Date());
  const swipe = useSwipeTabs(2, tab === 'news' ? 0 : 1, (i) => setTab(i === 0 ? 'news' : 'alerts'));
  const news = useMemo(() => groupByDay(
    dedupeFilings(data.announcements.filter((a) => filter === 'all' || a.kind !== 'other')).sort((a, b) => b.published_at.localeCompare(a.published_at)),
    (a) => a.published_at, today), [data.announcements, filter, today]);
  const alerts = useMemo(() => groupByDay(data.alerts, (a) => pktDate(new Date(a.sent_at)), today), [data.alerts, today]);
  const week = useMemo(() => weekAhead({
    today, days: 7, held: data.holdings.map((h) => h.symbol), watched: data.watchlist.map((w) => w.symbol), dividends: data.dividends,
    announcements: data.announcements, holdings: data.holdings, cal: tradingCalendar(DEFAULT_RULES, data.indexDaily),
  }), [data, today]);

  // One centred, readable feed at every width: cards of very different heights never sit side by side.
  return (
    <div className="space-y-4 lg:mx-auto lg:w-full lg:max-w-3xl">
      <header className="space-y-3">
        <h1 className="text-xl font-bold tracking-tight">News</h1>
        <Segmented label="News" value={tab} onChange={setTab} options={[{ value: 'news', label: 'Company news' }, { value: 'alerts', label: 'Your alerts' }]} />
      </header>
      <div {...swipe} className="touch-pan-y space-y-4">
        {tab === 'news' ? (
          <>
            <div role="group" aria-label="Show" className={chipRowCls}>
              {FILTERS.map((o) => (
                <button key={o.v} type="button" onClick={() => setFilter(o.v)} aria-pressed={filter === o.v} className={chipCls(filter === o.v, 'ink')}>{o.l}</button>
              ))}
            </div>
            {filter === 'week' ? (
              week.events.length ? (
                <Card className="divide-y divide-slate-100 py-1 dark:divide-slate-800">
                  {week.events.map((e) => <WeekRow key={`${e.symbol}|${e.kind}|${e.date}`} e={e} bc={data.bluechip[e.symbol]} />)}
                </Card>
              ) : <Empty title="Nothing dated in the next 7 days">Book closures, last days to buy, results and board meetings for your stocks appear here as PSX announces them.</Empty>
            ) : news.length ? news.map((g) => (
              <section key={g.label} className="space-y-2">
                <DayHeader>{g.label}</DayHeader>
                {g.items.map((a) => <NewsCard key={a.id} a={a} />)}
              </section>
            )) : <Empty title="No news for your stocks yet">Filings are checked every 30 minutes in market hours; the AI reads the important ones.</Empty>}
          </>
        ) : alerts.length ? alerts.map((g) => (
          <section key={g.label} className="space-y-2">
            <DayHeader>{g.label}</DayHeader>
            <Card className="divide-y divide-slate-100 py-1 dark:divide-slate-800">
              {g.items.map((a) => <AlertItem key={a.dedupe_key} a={a} />)}
            </Card>
          </section>
        )) : <Empty title="No alerts yet">Market alerts arrive during trading hours; the digest at 9 PM.</Empty>}
      </div>
    </div>
  );
}

/** A day's label: stays at the top while its cards scroll past, so the feed always says which day you are reading. */
function DayHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="sticky top-0 z-10 -mx-1 bg-slate-50/90 px-2 py-2 text-[13px] font-semibold tracking-wide text-slate-500 uppercase backdrop-blur dark:bg-black/85 dark:text-slate-400">
      {children}
    </h2>
  );
}

const WEEK_ICON: Record<WeekEvent['kind'], IconName> = { buy_by: 'bag', book_closure: 'calendar', payout: 'coins', results: 'news', board_meeting: 'user', review_due: 'flag' };

/** One dated item on the "My week" list. */
export function WeekRow({ e, onOpen, bc }: { e: WeekEvent; onOpen?: (symbol: string) => void; bc?: BcState }) {
  const when = e.days === 0 ? 'Today' : e.days === 1 ? 'Tomorrow' : dateLabel(e.date);
  const body = (
    <>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${e.kind === 'buy_by' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
        <Icon name={WEEK_ICON[e.kind]} className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium"><span>{e.symbol}</span><BcBadge state={bc} symbol={e.symbol} /><span className="font-normal text-slate-600 dark:text-slate-300">{e.title}</span>{e.mine && <Tag tone="teal">Yours</Tag>}</span>
        {e.detail && <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{e.detail}</span>}
      </span>
      <span className={`num shrink-0 text-right text-xs font-semibold ${e.days <= 1 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>{when}</span>
    </>
  );
  return onOpen
    ? <button type="button" onClick={() => onOpen(e.symbol)} className="flex min-h-12 w-full cursor-pointer items-center gap-3 py-2 text-left active:opacity-70">{body}</button>
    : <div className="flex min-h-12 items-center gap-3 py-2">{body}</div>;
}

const DATE_NOTE: Record<NonNullable<Announcement['ai_date_note']>, string> = { older_document: 'Older document', date_unclear: 'Date unclear' };

function NewsCard({ a }: { a: Announcement }) {
  const [open, setOpen] = useState(false);
  // ISSUE-06 for filings read before the worker checked dates: the same check runs here on what the AI wrote.
  const note = a.ai_date_note ?? (a.ai_summary ? (() => {
    const v = dateVerdict([a.ai_summary, ...(a.ai_figures ?? []).map((f) => f.value)], a.published_at);
    return v === 'ok' ? null : v;
  })() : null);
  const badDate = (text: string) => datesIn(text).some((d) => !dateSane(d, a.published_at));
  return (
    <Card>
      <div className="flex gap-3">
        <SymbolAvatar symbol={a.symbol} size="h-10 w-10" />
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <div className="flex items-start gap-2">
            <div className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <span className="font-semibold">{a.symbol}</span>
              <Tag tone={KIND[a.kind].tone}>{KIND[a.kind].label}</Tag>
              {a.ai_summary && <AiBadge />}
              {note && <Tag tone="amber">{DATE_NOTE[note]}</Tag>}
            </div>
            {/* The source sits top-right on every card, so a short notice does not end in an empty row. */}
            {a.pdf_url && <a href={a.pdf_url} target="_blank" rel="noopener noreferrer" aria-label={`${a.symbol} filing PDF`} className="-mt-2 -mr-2 inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-3 text-sm font-semibold text-teal-700 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-slate-800">PDF <Icon name="external" className="h-4 w-4" /></a>}
          </div>
          <p className="mt-1 text-[15px] leading-relaxed">{a.ai_summary ?? tidyTitle(a.title, a.symbol)}</p>
          {a.ai_summary && <p className="mt-1 line-clamp-1 text-xs text-slate-500 dark:text-slate-400">{tidyTitle(a.title, a.symbol)}</p>}
          {!!a.ai_figures?.length && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(open ? a.ai_figures : a.ai_figures.slice(0, 3)).map((f) => {
                const bad = badDate(f.value);
                const tone = bad ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300' : f.verified ? 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
                // Figures wrap inside the card on a phone: long labels must never run past the edge.
                return (
                  <span key={f.label} className={`inline-flex max-w-full items-start gap-1 rounded-2xl px-2 py-0.5 text-xs font-medium break-words ${tone}`}>
                    {f.verified && !bad && <Icon name="check" className="mt-0.5 h-3 w-3 shrink-0" label="checked against the PDF" />}
                    <span className="min-w-0">{f.label}: {f.value}{bad ? ' (date unclear)' : ''}</span>
                  </span>
                );
              })}
              {a.ai_figures.length > 3 && !open && <button type="button" aria-label={`Show ${a.ai_figures.length - 3} more figures`} className="-my-2.5 inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full text-xs font-semibold text-teal-700 dark:text-teal-400" onClick={() => setOpen(true)}>+{a.ai_figures.length - 3}</button>}
            </div>
          )}
          {note ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{note === 'older_document' ? 'The dates inside are long before the filing: a re-upload of an old notice.' : 'A date inside does not fit the filing date; read the PDF.'}</p>
            : a.ai_summary && a.ai_verified === false ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Some figures not checked (scanned PDF)</p> : null}
        </div>
      </div>
    </Card>
  );
}

function AlertItem({ a }: { a: AlertLogRow }) {
  return (
    <div className="flex gap-3 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"><Icon name={ALERT_ICON(a.kind)} className="h-4 w-4" /></span>
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <p className="text-sm leading-relaxed">{a.message}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {asOfLabel(a.sent_at)} · {a.channel === 'none' ? 'in the app only (daily limit)' : a.channel === 'both' ? 'push + Telegram' : a.channel === 'telegram' ? 'Telegram' : 'push'}
        </p>
      </div>
    </div>
  );
}
