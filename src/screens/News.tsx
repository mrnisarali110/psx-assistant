import { useMemo, useState } from 'react';
import type { BcState } from '../../shared/bluechip.ts';
import { BcBadge } from '../components/BcBadge.tsx';
import type { ScreenProps } from '../App.tsx';
import { cleanFigures, cleanHeadline, dedupeFilings, dividendImpact, groupByDay, metricChips, tidyTitle, type DividendImpact } from '../../shared/news.ts';
import { dateSane, dateVerdict, datesIn, tradingCalendar, weekAhead, type WeekEvent } from '../../shared/calendar.ts';
import { pktDate } from '../../shared/time.ts';
import { day, dayTime, rs } from '../../shared/format.ts';
import { DEFAULT_RULES, DEFAULT_SETTINGS, type AlertLogRow, type Announcement } from '../../shared/types.ts';
import { AiBadge } from '../components/AiCard.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Card, Change, Chip, CompanyMark, Empty, InfoTip, Segmented, chipCls, chipRowCls } from '../components/ui.tsx';
import { useSwipeTabs } from '../lib/gestures.ts';
import { openStock, stockHref } from '../lib/nav.ts';

/** Filing kinds are labels, not signals: one neutral style for all (red / green mean price direction only). */
const KIND: Record<Announcement['kind'], string> = { dividend: 'Dividend', results: 'Results', board_meeting: 'Board meeting', other: 'Notice' };

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
  const cal = useMemo(() => tradingCalendar(DEFAULT_RULES, data.indexDaily), [data.indexDaily]);
  const news = useMemo(() => groupByDay(
    dedupeFilings(data.announcements.filter((a) => filter === 'all' || a.kind !== 'other')).sort((a, b) => b.published_at.localeCompare(a.published_at)),
    (a) => a.published_at, today), [data.announcements, filter, today]);
  const alerts = useMemo(() => groupByDay(data.alerts, (a) => pktDate(new Date(a.sent_at)), today), [data.alerts, today]);
  const week = useMemo(() => weekAhead({
    today, days: 7, held: data.holdings.map((h) => h.symbol), watched: data.watchlist.map((w) => w.symbol), dividends: data.dividends,
    announcements: data.announcements, holdings: data.holdings, cal,
  }), [data, today, cal]);
  const sectors = useMemo(() => {
    const m: Record<string, string | null> = {};
    for (const r of data.screen) m[r.symbol] = r.sector;
    for (const h of data.holdings) m[h.symbol] = h.sector ?? m[h.symbol] ?? null;
    return m;
  }, [data.screen, data.holdings]);
  // "Impact on you" for each dividend-bearing filing of a stock you hold, with the same share count Expected uses.
  const impacts = useMemo(() => {
    const m = new Map<string, DividendImpact>();
    const filer = data.settings.tax_filer ?? DEFAULT_SETTINGS.tax_filer;
    for (const a of data.announcements) {
      if (a.kind !== 'dividend' && a.kind !== 'results') continue;
      const r = dividendImpact(a, { events: data.dividends, txns: data.transactions, holdings: data.holdings, sector: sectors[a.symbol], filer, today, cal });
      if (r) m.set(a.id, r);
    }
    return m;
  }, [data.announcements, data.dividends, data.transactions, data.holdings, data.settings.tax_filer, sectors, today, cal]);

  // One centred, readable feed at every width: cards of very different heights never sit side by side.
  return (
    <div className="space-y-4 lg:mx-auto lg:w-full lg:max-w-3xl">
      <header className="space-y-3">
        <h1 className="text-20 font-bold tracking-tight">News</h1>
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
                <Card className="divide-y divide-line py-1">
                  {week.events.map((e) => <WeekRow key={`${e.symbol}|${e.kind}|${e.date}`} e={e} bc={data.bluechip[e.symbol]} />)}
                </Card>
              ) : <Empty title="Nothing dated in the next 7 days">Book closures, last days to buy, results and board meetings for your stocks appear here as PSX announces them.</Empty>
            ) : news.length ? news.map((g) => (
              <section key={g.label} className="space-y-2">
                <DayHeader>{g.label}</DayHeader>
                {g.items.map((a) => <NewsCard key={a.id} a={a} sector={sectors[a.symbol]} impact={impacts.get(a.id) ?? null} />)}
              </section>
            )) : <Empty title="No news for your stocks yet">Filings are checked every 30 minutes in market hours; the AI reads the important ones.</Empty>}
          </>
        ) : alerts.length ? alerts.map((g) => (
          <section key={g.label} className="space-y-2">
            <DayHeader>{g.label}</DayHeader>
            <Card className="divide-y divide-line py-1">
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
    <h2 className="sticky top-0 z-10 -mx-1 bg-canvas/90 px-2 py-2 text-12 font-semibold tracking-wide text-muted uppercase backdrop-blur">
      {children}
    </h2>
  );
}

/** A ticker that opens the stock page; 44px tall so it is easy to hit inside a busy card. */
function Ticker({ symbol, className = '' }: { symbol: string; className?: string }) {
  return (
    <a href={stockHref(symbol)} className={`relative -my-2 inline-flex min-h-11 items-center font-semibold after:absolute after:inset-y-0 after:-inset-x-2 after:content-[''] text-ink underline-offset-2 hover:underline ${className}`}>
      {symbol}
    </a>
  );
}

const WEEK_ICON: Record<WeekEvent['kind'], IconName> = { buy_by: 'bag', book_closure: 'calendar', payout: 'coins', results: 'news', board_meeting: 'user', review_due: 'flag' };

/** One dated item on the "My week" list. Tapping it opens the stock page. */
export function WeekRow({ e, onOpen = openStock, bc }: { e: WeekEvent; onOpen?: (symbol: string) => void; bc?: BcState }) {
  // Today and tomorrow stand out by weight, not by colour: a date is not a warning.
  const soon = e.days <= 1;
  return (
    <button type="button" onClick={() => onOpen(e.symbol)} className="press flex min-h-12 w-full cursor-pointer items-center gap-3 py-2 text-left">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink">
        <Icon name={WEEK_ICON[e.kind]} className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-14">
          <span className="font-semibold text-ink">{e.symbol}</span><BcBadge state={bc} symbol={e.symbol} />
          <span className="text-ink">{e.title}</span>{e.mine && <Chip kind="neutral">Yours</Chip>}
        </span>
        {e.detail && <span className="block truncate text-12 text-muted">{e.detail}</span>}
      </span>
      <span className={`num shrink-0 text-right text-12 ${soon ? 'font-bold text-ink' : 'font-medium text-muted'}`}>{day(e.date)}</span>
    </button>
  );
}

const DATE_NOTE: Record<NonNullable<Announcement['ai_date_note']>, { chip: string; tip: string }> = {
  older_document: { chip: 'Older document', tip: 'The dates inside are long before the filing: a re-upload of an old notice.' },
  date_unclear: { chip: 'Date unclear', tip: 'A date inside does not fit the filing date; read the PDF.' },
};

/** "on Thu", "tomorrow": a date word that reads inside a sentence. */
const onDay = (d: string) => { const w = day(d); return /^(Today|Tomorrow|Yesterday)$/.test(w) ? w.toLowerCase() : `on ${w}`; };
const byDay = (d: string) => { const w = day(d); return /^(Today|Tomorrow)$/.test(w) ? w.toLowerCase() : w; };

function NewsCard({ a, sector, impact }: { a: Announcement; sector: string | null | undefined; impact: DividendImpact | null }) {
  // ISSUE-06 for filings read before the worker checked dates: the same check runs here on what the AI wrote.
  const note = a.ai_date_note ?? (a.ai_summary ? (() => {
    const v = dateVerdict([a.ai_summary, ...(a.ai_figures ?? []).map((f) => f.value)], a.published_at);
    return v === 'ok' ? null : v;
  })() : null);
  const badDate = (text: string) => datesIn(text).some((d) => !dateSane(d, a.published_at));
  const headline = cleanHeadline(a.title, a.symbol, a.ai_metrics?.headline);
  const metrics = metricChips(a.ai_metrics);
  const figures = metrics.length ? [] : cleanFigures(a.ai_figures);
  const unverified = !!a.ai_summary && a.ai_verified === false;
  return (
    <Card>
      <div className="flex gap-3">
        <a href={stockHref(a.symbol)} aria-label={`Open ${a.symbol}`} className="-m-0.5 h-11 shrink-0 rounded-full p-0.5">
          <CompanyMark symbol={a.symbol} sector={sector} />
        </a>
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <div className="flex items-start gap-2">
            <div className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <Ticker symbol={a.symbol} />
              <Chip kind="neutral">{KIND[a.kind]}</Chip>
              {a.ai_summary && <AiBadge />}
              {unverified && !note && <InfoTip label="Figures not checked" text="Some figures could not be checked against the PDF (it is a scanned image). Read the PDF before acting." />}
              {note && <><Chip kind="caution">{DATE_NOTE[note].chip}</Chip><InfoTip label="Why" text={DATE_NOTE[note].tip} /></>}
            </div>
            {/* The source sits top-right on every card, so a short notice does not end in an empty row. */}
            {a.pdf_url && <a href={a.pdf_url} target="_blank" rel="noopener noreferrer" aria-label={`${a.symbol} filing PDF`} className="-mt-2 -mr-2 inline-flex min-h-11 shrink-0 items-center gap-1 rounded-chip px-3 text-14 font-semibold text-brand hover:bg-surface-2">PDF <Icon name="external" className="h-4 w-4" /></a>}
          </div>
          <p className="mt-1 text-16 leading-snug font-semibold text-ink">{headline}</p>
          {a.ai_summary && <p className="mt-1 text-14 leading-relaxed text-muted">{a.ai_summary}</p>}
          {!a.ai_summary && a.ai_metrics?.headline && <p className="mt-1 line-clamp-1 text-12 text-muted">{tidyTitle(a.title, a.symbol)}</p>}
          {metrics.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {metrics.map((m) => (
                <span key={m.key} className="inline-flex max-w-full items-baseline gap-1 rounded-chip bg-surface-2 px-2.5 py-1 text-12">
                  <span className="text-muted">{m.label}</span>
                  {m.change != null ? <Change value={m.change} className="font-semibold" /> : <span className="num font-semibold text-ink">{m.value}</span>}
                  {m.note && <span className="text-muted">· {m.note}</span>}
                </span>
              ))}
            </div>
          )}
          {figures.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {figures.map((f) => {
                const bad = badDate(f.value);
                // Figures wrap inside the card on a phone: long values must never run past the edge.
                return (
                  <span key={`${f.label}|${f.value}`} className={`inline-flex max-w-full items-start gap-1 rounded-control px-2.5 py-1 text-12 break-words ${bad ? 'bg-caution/10 text-caution' : 'bg-surface-2 text-ink'}`}>
                    {f.verified && !bad && <Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-muted" label="checked against the PDF" />}
                    <span className="min-w-0"><span className={bad ? '' : 'text-muted'}>{f.label.endsWith('…') ? f.label : `${f.label}:`}</span> <span className="font-semibold">{f.value}</span>{bad ? ' (date unclear)' : ''}</span>
                  </span>
                );
              })}
            </div>
          )}
          {impact && (
            <p className="mt-3 flex gap-2 rounded-control bg-surface-2 px-3 py-2 text-14 text-ink">
              <Icon name="coins" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <span>
                <span className="font-semibold">Impact on you: </span>
                {impact.past
                  ? <>≈ <b className="num">{rs(impact.net)}</b> after tax on your {impact.shares.toLocaleString('en-PK')} shares (book closure {day(impact.book_closure)})</>
                  : <>≈ <b className="num">{rs(impact.net)}</b> after tax if you hold {onDay(impact.book_closure)}{impact.buy_by && <> · buy more by {byDay(impact.buy_by)}</>}</>}
                {impact.basis === 'holdings' && <span className="text-muted"> · from your holdings</span>}
              </span>
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

const CHANNEL = (c: string | null) => (c === 'none' ? 'in the app only (daily limit)' : c === 'both' ? 'push + Telegram' : c === 'telegram' ? 'Telegram' : 'push');

function AlertItem({ a }: { a: AlertLogRow }) {
  return (
    <div className="flex gap-3 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted"><Icon name={ALERT_ICON(a.kind)} className="h-4 w-4" /></span>
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <p className="text-14 leading-relaxed text-ink">{a.message}</p>
        <p className="text-12 text-muted">
          {a.symbol && <><Ticker symbol={a.symbol} className="text-12" /> · </>}{dayTime(a.sent_at)} · {CHANNEL(a.channel)}
        </p>
      </div>
    </div>
  );
}
