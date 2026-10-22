/**
 * The stock page, #/stock/SYMBOL (owner review B8): the one detail view every ticker opens. Price and the session it
 * is from, the price chart (stored closes only), your position, why you own it, your own rules checked one by one with
 * their reasons, P/E with its basis, dividends and recent filings. Buy / Edit / Plan sale / Remove open the existing
 * sheets. Phone: one column in that order. Desktop: the stock on the left, you and your rules on the right.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ScreenProps } from '../App.tsx';
import type { BcState } from '../../shared/bluechip.ts';
import type { ScreenRow } from '../../shared/discover.ts';
import { upcomingDividends } from '../../shared/discover.ts';
import { tradingCalendar } from '../../shared/calendar.ts';
import { day, rs, rs2, sectorLabel, sessionLabel } from '../../shared/format.ts';
import { dedupeFilings, tidyTitle } from '../../shared/news.ts';
import { whtPct } from '../../shared/performance.ts';
import {
  addBlockedReason, lossQuartersInARow, reviewReason, trimReason, valueCheck,
  type HoldingCall, type HoldingView, type PortfolioView, type RuleContext,
} from '../../shared/portfolio.ts';
import { isSpecial, oneOffYield, payoutFrequency, payoutOf, regularDividend } from '../../shared/quality.ts';
import { exLabel } from '../../shared/symbols.ts';
import { pktDate } from '../../shared/time.ts';
import { peFor, sectorNote } from '../../shared/valuation.ts';
import { DEFAULT_RULES, type DividendEvent, type Price, type PriceDay, type Rules, type Settings } from '../../shared/types.ts';
import { BcBadge, BcSheet } from '../components/BcBadge.tsx';
import { latestAsOf } from '../components/Freshness.tsx';
import { CallChip } from '../components/Holding.tsx';
import { useHoldingActions } from '../components/HoldingActions.tsx';
import { Icon } from '../components/Icon.tsx';
import { MIN_CLOSES, PriceChart, RangeBar, priceSeries, type PricePoint } from '../components/PriceChart.tsx';
import { Button, Card, Change, Chip, CompanyMark, Empty, InfoTip, Skeleton } from '../components/ui.tsx';
import { haptic } from '../lib/gestures.ts';
import { profileHref } from '../lib/nav.ts';

// ---------------------------------------------------------------------------------------------------------------
// Your rules, checked one by one (pure: tested in Stock.test.ts)
// ---------------------------------------------------------------------------------------------------------------

/** pass = fine / the rule is met; flag = asks you to look (caution); no = not met, nothing wrong; na = cannot tell or off. */
export type CheckState = 'pass' | 'flag' | 'no' | 'na';
export interface RuleCheck { key: string; label: string; state: CheckState; text: string }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Each of your rules for one stock with its verdict and the reason, using the same functions that make the calls on
 * Home and Portfolio (so the page never disagrees with them). `row` is your holding; without it the checks are the
 * ones that matter for a first buy (sector cap, value, losses, Shariah, blue chip).
 */
export function ruleChecks({ symbol, row, price, sector, settings: s, ctx, view, bc, shariah, rules = DEFAULT_RULES }: {
  symbol: string; row?: HoldingView; price: Price | null; sector: string | null; settings: Settings; ctx: RuleContext;
  view: Pick<PortfolioView, 'rows' | 'sector_weights'>; bc?: BcState; shariah: boolean | null; rules?: Rules;
}): RuleCheck[] {
  const out: RuleCheck[] = [];
  const sectorKey = row?.sector ?? sector ?? 'Unknown';
  const value = valueCheck(symbol, price, sectorKey, ctx, rules);

  if (row) {
    const h = row.holding;
    const buyAt = s.buy_more_below_pct ?? rules.holding.average_down_pct;
    const ref = h.last_buy_price && h.last_buy_price > 0 ? `your last buy (${rs2(h.last_buy_price)})` : `your average cost (${rs2(h.avg_cost)})`;
    const vs = row.vs_ref_pct;
    const blocked = addBlockedReason(h, row.weight_pct, s, row.sector_pct);
    if (vs == null) out.push({ key: 'buy_more', label: 'Buy more', state: 'na', text: 'No live price yet' });
    else {
      const below = vs < 0 ? -vs : 0;
      const where = vs < 0 ? `${below.toFixed(1)}% below ${ref}` : `${vs.toFixed(1)}% above ${ref}`;
      const [state, text]: [CheckState, string] = below < buyAt ? ['no', `${where}; your rule waits for ${buyAt}% below`]
        : blocked ? ['no', `${where}, but ${blocked}`]
          : !value.ok ? ['no', `${where}, but ${value.text}`]
            : ['pass', `${where} and ${value.text}`];
      out.push({ key: 'buy_more', label: 'Buy more', state, text: cap(text) });
    }

    const w = row.weight_pct;
    const soft = s.max_position_pct;
    const hard = s.hard_stock_cap_pct ?? rules.holding.hard_stock_cap_pct;
    out.push(w == null ? { key: 'stock_cap', label: 'Stock cap', state: 'na', text: 'No live price to work out its share' }
      : w > hard ? { key: 'stock_cap', label: 'Stock cap', state: 'flag', text: `${w.toFixed(1)}% of your portfolio, over your ${hard}% hard cap` }
        : w >= soft ? { key: 'stock_cap', label: 'Stock cap', state: 'flag', text: `${w.toFixed(1)}% of your portfolio: at your ${soft}% cap, so no new money` }
          : { key: 'stock_cap', label: 'Stock cap', state: 'pass', text: `${w.toFixed(1)}% of your portfolio; new money stops at ${soft}%, trim above ${hard}%` });
  }

  // Sector cap: your whole sector's share, held or not (a first buy adds to it too).
  const softSector = s.max_sector_pct ?? rules.holding.sector_limit_pct;
  const hardSector = s.hard_sector_cap_pct ?? rules.holding.hard_sector_cap_pct;
  if (!sector && !row) out.push({ key: 'sector_cap', label: 'Sector cap', state: 'na', text: 'Sector not known' });
  else {
    const name = sectorKey === 'Unknown' ? 'Its sector' : sectorLabel(sectorKey);
    const pct = row?.sector_pct ?? view.sector_weights.find((x) => x.sector === sectorKey)?.pct ?? 0;
    out.push(pct > hardSector ? { key: 'sector_cap', label: 'Sector cap', state: 'flag', text: `${name} is ${pct.toFixed(0)}% of your portfolio, over your ${hardSector}% hard cap` }
      : pct >= softSector ? { key: 'sector_cap', label: 'Sector cap', state: 'flag', text: `${name} is ${pct.toFixed(0)}% of your portfolio: at your ${softSector}% cap, so no new money` }
        : { key: 'sector_cap', label: 'Sector cap', state: 'pass', text: pct > 0 ? `${name} is ${pct.toFixed(0)}% of your portfolio; new money stops at ${softSector}%` : `You hold nothing in ${name} yet; new money stops at ${softSector}%` });
  }

  if (row) {
    const h = row.holding;
    const peers = view.rows.filter((r) => r.sector === row.sector && r.value != null);
    const biggest = row.value != null && peers.every((r) => (r.value as number) <= (row.value as number));
    const trim = trimReason(h, price, row.weight_pct, row.sector, s, ctx, rules, row.sector_pct == null ? undefined : { pct: row.sector_pct, biggest });
    out.push(trim ? { key: 'trim', label: 'Trim rules', state: 'flag', text: cap(trim) }
      : { key: 'trim', label: 'Trim rules', state: 'pass', text: `None apply: under your hard caps, no dividend cut, P/E not stretched${h.target_price ? `, below your target ${rs2(h.target_price)}` : ''}` });
  }

  out.push({ key: 'value', label: 'Value check', state: value.ok ? 'pass' : 'no', text: cap(value.text) });

  const reviewAt = s.review_after_loss_quarters ?? 0;
  const sellAt = s.sell_after_loss_quarters ?? 0;
  const losses = lossQuartersInARow(symbol, ctx.earnings);
  out.push(!reviewAt && !sellAt ? { key: 'losses', label: 'Loss quarters', state: 'na', text: 'Off in your rules' }
    : !losses.latest ? { key: 'losses', label: 'Loss quarters', state: 'na', text: 'No quarterly results read yet' }
      : sellAt && losses.count >= sellAt ? { key: 'losses', label: 'Loss quarters', state: 'flag', text: `Loss in each of the last ${losses.count} quarters: your rule says sell after ${sellAt}` }
        : reviewAt && losses.count >= reviewAt ? { key: 'losses', label: 'Loss quarters', state: 'flag', text: `Loss in each of the last ${losses.count} quarters: your rule says review after ${reviewAt}` }
          : { key: 'losses', label: 'Loss quarters', state: 'pass', text: losses.count
            ? `Loss in the latest ${losses.count === 1 ? 'quarter' : `${losses.count} quarters`}; your rule reviews after ${reviewAt || sellAt}`
            : `Profit in the latest quarter (to ${day(losses.latest)})` });

  if (s.shariah_only) {
    out.push(shariah == null ? { key: 'shariah', label: 'Shariah only', state: 'na', text: 'PSX gives no Shariah status for it' }
      : shariah ? { key: 'shariah', label: 'Shariah only', state: 'pass', text: 'Shariah compliant (KMI All Share)' }
        : { key: 'shariah', label: 'Shariah only', state: 'flag', text: 'Not Shariah compliant; your rules allow Shariah stocks only' });
  }

  if (!bc) out.push({ key: 'bluechip', label: 'Blue-chip checks', state: 'na', text: 'Not checked yet (the night run checks it)' });
  else {
    const passed = bc.checks.filter((c) => c.ok === true).length;
    const of = `${passed} of ${bc.checks.length} checks pass`;
    out.push({
      key: 'bluechip', label: 'Blue-chip checks',
      state: bc.status === 'bc' ? 'pass' : bc.status === 'at_risk' ? 'flag' : bc.status === 'not_bc' ? 'no' : 'na',
      // The reasons behind each check are one tap away (Checks); the line stays short.
      text: `${BC_WORD[bc.status]}: ${of}`,
    });
  }
  return out;
}

const BC_WORD: Record<BcState['status'], string> = { bc: 'Blue chip', at_risk: 'At risk', not_bc: 'Not a blue chip', not_enough_data: 'Not enough data yet' };

// ---------------------------------------------------------------------------------------------------------------

/** The hash the app was opened on: Back from a stock page you landed on directly goes to Portfolio, not out of the app. */
const ENTRY_HASH = typeof location === 'undefined' ? '' : location.hash;
function goBack() {
  haptic();
  if (location.hash !== ENTRY_HASH && history.length > 1) history.back();
  else location.hash = '/portfolio';
}

const fromScreen = (r: ScreenRow): Price => ({
  symbol: r.symbol, name: null, sector: r.sector, price: r.price, change: null, change_pct: r.change_pct, volume: null, ldcp: null,
  high_52w: null, low_52w: null, dividend_yield_pct: r.dividend_yield_pct, pe: r.pe, is_shariah: r.is_shariah, as_of: null, ex: r.ex ?? null,
});

const KIND_WORD: Record<string, string> = { dividend: 'Dividend', results: 'Results', board_meeting: 'Board meeting', other: 'Notice' };
const DIV_TYPE: Record<string, string> = { interim: 'Interim', final: 'Final', special: 'Special' };

export function Stock(props: ScreenProps & { symbol: string }) {
  const { data, source, symbol: sym } = props;
  const now = new Date();
  const acts = useHoldingActions(props);
  const { view, today } = acts;
  const row = view.rows.find((r) => r.holding.symbol === sym);
  const watched = data.watchlist.some((w) => w.symbol === sym);
  const screen = data.screen.find((r) => r.symbol === sym);
  const price: Price | null = data.prices[sym] ?? (screen ? fromScreen(screen) : null);
  const sector = row?.sector ?? price?.sector ?? acts.sectors[sym] ?? null;
  const shariah = price?.is_shariah ?? screen?.is_shariah ?? row?.holding.is_shariah ?? null;
  const bc = data.bluechip[sym];
  const [bcOpen, setBcOpen] = useState(false);

  // Closes: held and watched stocks come with the app's data; any other stock is read on demand.
  const inData = useMemo(() => data.priceDaily.some((p) => p.symbol === sym), [data.priceDaily, sym]);
  const [fetched, setFetched] = useState<{ symbol: string; days: PriceDay[] } | null>(null);
  useEffect(() => {
    if (inData || row || watched) return;
    let live = true;
    source.priceHistory(sym).then((days) => live && setFetched({ symbol: sym, days }), () => live && setFetched({ symbol: sym, days: [] }));
    return () => { live = false; };
  }, [sym, source, inData, row, watched]);
  const loadingHistory = !inData && !row && !watched && fetched?.symbol !== sym;
  const days = inData || row || watched ? data.priceDaily : fetched?.symbol === sym ? fetched.days : [];
  const asOf = price?.as_of ?? latestAsOf(data);
  const current: PricePoint | null = price?.price != null && price.as_of ? { day: pktDate(new Date(price.as_of)), close: price.price } : null;
  const closes = priceSeries(days, sym, now, current).length;

  const pe = acts.pe[sym] ?? peFor(sym, price?.price ?? null, data.earnings.filter((e) => e.symbol === sym), price?.pe ?? null);
  const sectorStat = sector ? acts.sectorStat[sector] : undefined;
  const checks = ruleChecks({ symbol: sym, row, price, sector, settings: data.settings, ctx: acts.ctx, view, bc, shariah });

  if (!price && !row) {
    return (
      <>
        <BackLink />
        <Empty title={`No PSX data for ${sym}`}>
          It is not in PSX's list the app reads. Check the symbol, or find stocks in <a href="#/discover" className="font-semibold text-brand underline underline-offset-2">Discover</a>.
        </Empty>
      </>
    );
  }

  const call = row ? acts.callFor(row) : null;
  return (
    <>
      <BackLink />
      <header className="space-y-3 lg:flex lg:items-end lg:justify-between lg:gap-6 lg:space-y-0">
        <div className="flex min-w-0 items-start gap-3">
          <CompanyMark symbol={sym} sector={sector} size="h-12 w-12 lg:h-14 lg:w-14" />
          <div className="min-w-0">
            <h1 className="text-28 font-bold tracking-tight">{sym}</h1>
            <p className="truncate text-14 text-muted">{[price?.name, sector && sectorLabel(sector)].filter(Boolean).join(' · ') || 'PSX'}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <BcBadge state={bc} symbol={sym} mode="status" />
              {shariah && <Chip kind="shariah" />}
              {price?.ex && <Chip kind="exdiv">{exLabel(price.ex) ?? 'Ex-dividend'}</Chip>}
              {watched && !row && <Chip kind="neutral">Watching</Chip>}
            </div>
          </div>
        </div>
        <div className="lg:text-right">
          <p className="text-40 font-bold tracking-tight">{price?.price != null ? rs2(price.price) : 'No price yet'}</p>
          <p className="flex flex-wrap items-baseline gap-x-2 text-14 lg:justify-end">
            {price?.change != null && <Change kind="rs" digits={2} value={price.change} className="font-semibold" />}
            <Change value={price?.change_pct} digits={2} className="font-semibold" label={sessionLabel(asOf, now)} />
            <span className="text-muted">{sessionLabel(asOf, now)}</span>
          </p>
        </div>
      </header>

      {/* Phone: one column in reading order (the order-* classes). Desktop: two columns; the wrappers become real boxes. */}
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-12 lg:items-start lg:gap-5">
        <div className="contents lg:col-span-7 lg:block lg:space-y-5 2xl:col-span-8">
          <Card className="order-1">
            <h2 className="sr-only">Price chart</h2>
            {loadingHistory ? <Skeleton className="h-56 w-full rounded-control" />
              : <PriceChart symbol={sym} days={days} current={current} low52={price?.low_52w ?? null} high52={price?.high_52w ?? null} now={now} />}
          </Card>
          <div className="order-5">
            <Valuation sym={sym} price={price} pe={pe} sector={sector} sectorStat={sectorStat} dividends={data.dividends} earnings={data.earnings} today={today}
              showRange={closes >= MIN_CLOSES} />
          </div>
          <div className="order-6">
            <Dividends sym={sym} dividends={data.dividends} today={today} indexDaily={data.indexDaily} shares={row?.holding.shares ?? 0}
              wht={whtPct(sector, data.settings.tax_filer)} />
          </div>
          <div className="order-7">
            <Filings sym={sym} announcements={data.announcements} />
          </div>
        </div>

        <div className="contents lg:col-span-5 lg:block lg:space-y-5 2xl:col-span-4">
          <div className="order-2">
            {row ? <Position row={row} call={call!} acts={acts} />
              : (
                <Card className="space-y-3">
                  <p className="text-14 text-muted">You don't own {sym}{watched ? '; it is on your watchlist' : ''}.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button onClick={() => acts.buy(sym)}><Icon name="bag" />Buy</Button>
                    {watched
                      ? <Button kind="secondary" onClick={() => acts.unwatch(sym)}><Icon name="x" />Stop watching</Button>
                      : <Button kind="secondary" onClick={() => acts.watch(sym)}><Icon name="eye" />Watch</Button>}
                  </div>
                </Card>
              )}
          </div>
          {row && (
            <div className="order-3">
              <Thesis row={row} today={today} onEdit={() => acts.edit(row.holding)} settings={data.settings} ctx={acts.ctx} />
            </div>
          )}
          <div className="order-4">
            <Card className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-16 font-semibold">Your rules</h2>
                {call && <CallChip call={call} />}
              </div>
              <p className="text-14 text-muted">{call ? call.text : 'Checked as if you bought it today.'}</p>
              <ul className="divide-y divide-line">
                {checks.map((c) => (
                  <li key={c.key} className="flex gap-3 py-3">
                    <Mark state={c.state} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-14 font-semibold">{c.label}</span>
                      <span className="block text-14 text-muted">{c.text}</span>
                    </span>
                    {c.key === 'bluechip' && bc && (
                      <button type="button" onClick={() => { haptic(); setBcOpen(true); }}
                        className="press -my-1 inline-flex min-h-11 shrink-0 cursor-pointer items-center self-center px-1 text-14 font-semibold text-brand">
                        Checks
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <a href={profileHref('rules')} onClick={() => haptic()} className="press inline-flex min-h-11 items-center gap-1 text-14 font-semibold text-brand">
                Change your rules<Icon name="chevron" className="h-4 w-4" />
              </a>
            </Card>
          </div>
        </div>
      </div>
      {bc && <BcSheet open={bcOpen} onClose={() => setBcOpen(false)} state={bc} />}
      {acts.ui}
    </>
  );
}

function BackLink() {
  return (
    <button type="button" onClick={goBack} className="press -ml-2 inline-flex min-h-11 cursor-pointer items-center gap-1 px-2 text-14 font-semibold text-brand">
      <Icon name="chevron" className="h-4 w-4 rotate-180" />Back
    </button>
  );
}

const MARK: Record<CheckState, { cls: string; word: string }> = {
  pass: { cls: 'bg-surface-2 text-ink', word: 'passes' },
  flag: { cls: 'bg-caution/10 text-caution', word: 'needs a look' },
  no: { cls: 'bg-surface-2 text-muted', word: 'not met' },
  na: { cls: 'bg-surface-2 text-muted', word: 'not checked' },
};
function Mark({ state }: { state: CheckState }) {
  const m = MARK[state];
  return (
    <span role="img" aria-label={m.word} className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${m.cls}`}>
      {state === 'pass' ? <Icon name="check" className="h-4 w-4" /> : state === 'flag' ? <Icon name="alert" className="h-4 w-4" />
        : state === 'no' ? <Icon name="x" className="h-4 w-4" /> : <span aria-hidden="true" className="text-14 font-bold">–</span>}
    </span>
  );
}

const Stat = ({ label, children, tip }: { label: string; children: ReactNode; tip?: string }) => (
  <div className="min-w-0">
    <p className="flex items-center gap-0.5 text-12 text-muted">{label}{tip && <InfoTip text={tip} label={`About ${label.toLowerCase()}`} />}</p>
    <div className="text-16 font-semibold">{children}</div>
  </div>
);

function Position({ row, call, acts }: { row: HoldingView; call: HoldingCall; acts: ReturnType<typeof useHoldingActions> }) {
  const h = row.holding;
  const lastBuy = h.last_buy_price && h.last_buy_price > 0 ? h.last_buy_price : null;
  const vsLast = lastBuy && row.price?.price != null ? ((row.price.price - lastBuy) / lastBuy) * 100 : null;
  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-16 font-semibold">Your position</h2>
        <CallChip call={call} />
      </div>
      <div>
        <p className="text-28 font-bold tracking-tight">{rs(row.value)}</p>
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-14">
          <Change kind="rs" value={row.pnl} className="font-semibold" label="profit or loss" />
          <Change value={row.pnl_pct} className="font-semibold" />
          <span className="text-muted">vs average cost</span>
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
        <Stat label="Shares">{h.shares.toLocaleString('en-PK')}</Stat>
        <Stat label="Average cost">{rs2(h.avg_cost)}</Stat>
        <Stat label="Cost">{rs(row.cost)}</Stat>
        <Stat label="Weight">{row.weight_pct == null ? '–' : `${row.weight_pct.toFixed(1)}%`}</Stat>
        <Stat label={sessionLabel(row.price?.as_of ?? null)}><Change kind="rs" value={row.day_change} /></Stat>
        {lastBuy && <Stat label={`vs your last buy (${rs2(lastBuy)})`}><Change value={vsLast} /></Stat>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={() => acts.buy(h.symbol)}><Icon name="bag" />Buy</Button>
        <Button kind="secondary" onClick={() => acts.planSale(h.symbol)}><Icon name="tag" />Plan sale</Button>
        <Button kind="secondary" onClick={() => acts.edit(h)}><Icon name="pencil" />Edit</Button>
        <Button kind="secondary" onClick={() => acts.remove(h)}><Icon name="trash" />Remove</Button>
      </div>
    </Card>
  );
}

function Thesis({ row, today, onEdit, settings, ctx }: { row: HoldingView; today: string; onEdit: () => void; settings: Settings; ctx: RuleContext }) {
  const h = row.holding;
  const review = reviewReason(h, ctx, settings);
  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-16 font-semibold">Why I own it</h2>
        <button type="button" onClick={() => { haptic(); onEdit(); }} className="press -my-2 inline-flex min-h-11 cursor-pointer items-center px-1 text-14 font-semibold text-brand">Edit</button>
      </div>
      <p className={`text-14 ${h.thesis ? 'text-ink' : 'text-muted'}`}>{h.thesis ?? 'Not written yet. One line on why you bought it helps you decide later.'}</p>
      {(h.review_on || h.target_price || h.note) && (
        <p className="text-14 text-muted">
          {[h.review_on && `Review ${h.review_on <= today ? 'was due' : 'on'} ${day(h.review_on)}`, h.target_price && `Target ${rs2(h.target_price)}`, h.note].filter(Boolean).join(' · ')}
        </p>
      )}
      {review && <p className="flex items-start gap-2 rounded-control bg-caution/10 p-3 text-14 text-ink"><Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-caution" />{review}</p>}
    </Card>
  );
}

function Valuation({ sym, price, pe, sector, sectorStat, dividends, earnings, today, showRange }: {
  sym: string; price: Price | null; pe: ReturnType<typeof peFor>; sector: string | null; sectorStat: ReturnType<typeof useHoldingActions>['sectorStat'][string] | undefined;
  dividends: DividendEvent[]; earnings: ScreenProps['data']['earnings']; today: string; showRange: boolean;
}) {
  const rules = DEFAULT_RULES;
  const regular = regularDividend(sym, dividends, today, price?.price ?? null, rules);
  const payout = payoutOf(sym, dividends, today, { price: price?.price ?? null, psxYieldPct: price?.dividend_yield_pct ?? null, eps: pe.eps }, DEFAULT_RULES);
  const oneOff = oneOffYield(sym, dividends, today, earnings, rules);
  const freq = payoutFrequency(sym, dividends, today, rules);
  const yieldPct = regular?.yield_pct ?? price?.dividend_yield_pct ?? null;
  const note = sectorNote(sectorStat);
  return (
    <Card className="space-y-4">
      <h2 className="text-16 font-semibold">Value</h2>
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
        <Stat label="P/E" tip="Price divided by a full year of earnings per share. The line below says which accounts the earnings come from. The same figure is used on every screen and by your rules.">
          <span>{pe.loss ? 'n/a (loss)' : pe.pe == null ? 'n/a' : pe.pe.toFixed(1)}</span>
          <span className="block text-12 font-normal text-muted">{pe.label}</span>
          {pe.outlier && <span className="mt-1 block"><Chip kind="caution">Unusual, check</Chip></span>}
        </Stat>
        <Stat label="Sector P/E">
          {note || !sectorStat ? <span className="text-14 font-normal text-muted">{cap(note ?? 'no sector figure')}</span>
            : <><span>{sectorStat.median.toFixed(1)}</span><span className="block text-12 font-normal text-muted">median of {sectorStat.peers} peers{sector ? ` in ${sectorLabel(sector)}` : ''}</span></>}
        </Stat>
        <Stat label="Dividend yield">
          <span>{yieldPct == null ? 'n/a' : `${yieldPct.toFixed(1)}%`}</span>
          <span className="block text-12 font-normal text-muted">
            {regular ? `Rs ${regular.annual_dps} a share in the last 12 months${freq.label ? ` · ${freq.label.toLowerCase()}` : ''}` : yieldPct != null ? 'PSX figure' : 'no dividend in the last 12 months'}
          </span>
          {(oneOff || (payout?.pct != null && payout.pct > rules.holding.payout_warn_pct)) && (
            <span className="mt-1 flex flex-wrap gap-1">
              {payout?.pct != null && payout.pct > rules.dividends.suspect_payout_pct ? <Chip kind="caution">Pays out {payout.pct.toFixed(0)}% of profit</Chip>
                : payout?.pct != null && payout.pct > rules.holding.payout_warn_pct ? <Chip kind="caution">High payout, may not last</Chip> : null}
              {oneOff && <Chip kind="caution">One-off in the yield</Chip>}
            </span>
          )}
        </Stat>
      </div>
      {showRange && <RangeBar low={price?.low_52w ?? null} high={price?.high_52w ?? null} value={price?.price ?? null} />}
    </Card>
  );
}

/** One row per declared dividend (PSX often posts a notice twice), newest first. */
function uniqueDividends(list: DividendEvent[]): DividendEvent[] {
  const seen = new Set<string>();
  return [...list].sort((a, b) => b.announced_on.localeCompare(a.announced_on) || Number(b.verified) - Number(a.verified)).filter((d) => {
    const k = `${d.announced_on}|${d.dps}|${d.dividend_type}|${d.book_closure_from}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function Dividends({ sym, dividends, today, indexDaily, shares, wht }: {
  sym: string; dividends: DividendEvent[]; today: string; indexDaily: ScreenProps['data']['indexDaily']; shares: number; wht: number;
}) {
  const [all, setAll] = useState(false);
  const mine = useMemo(() => uniqueDividends(dividends.filter((d) => d.symbol === sym)), [dividends, sym]);
  const cal = useMemo(() => tradingCalendar(DEFAULT_RULES, indexDaily), [indexDaily]);
  const next = useMemo(() => upcomingDividends(mine, today, DEFAULT_RULES, cal)[0] ?? null, [mine, today, cal]);
  const shown = all ? mine : mine.slice(0, 5);
  return (
    <Card className="space-y-3">
      <h2 className="text-16 font-semibold">Dividends</h2>
      {next && (
        <div className="flex items-start gap-3 rounded-control bg-surface-2 p-3">
          <Icon name="coins" className="mt-0.5 h-5 w-5 shrink-0 text-muted" />
          <div className="min-w-0 space-y-1 text-14">
            <p className="font-semibold">{next.dps != null ? `Rs ${next.dps} a share` : 'Dividend declared'} · buy by {day(next.buy_by)}</p>
            <p className="text-muted">
              Books close {day(next.book_closure_from)}.
              {shares > 0 && next.dps != null ? ` About ${rs(shares * next.dps * (1 - wht / 100))} after ${wht}% tax for your ${shares.toLocaleString('en-PK')} shares.` : ''}
            </p>
            <Chip kind="estimate">Estimate: confirm with your broker</Chip>
          </div>
        </div>
      )}
      {mine.length ? (
        <>
          <ul className="divide-y divide-line">
            {shown.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 text-14">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5 font-medium">
                    {d.dividend_type ? DIV_TYPE[d.dividend_type] : 'Cash dividend'}
                    {d.dividend_type !== 'special' && isSpecial(d, mine) && <Chip kind="caution">One-off</Chip>}
                  </span>
                  <span className="block text-12 text-muted">Declared {day(d.announced_on)}{d.book_closure_from ? ` · books close ${day(d.book_closure_from)}` : ''}</span>
                </span>
                <span className="shrink-0 font-semibold">{d.dps != null ? `Rs ${d.dps}` : '–'}</span>
              </li>
            ))}
          </ul>
          {mine.length > 5 && (
            <button type="button" onClick={() => { haptic(); setAll(!all); }} aria-expanded={all}
              className="press inline-flex min-h-11 cursor-pointer items-center text-14 font-semibold text-brand">
              {all ? 'Show fewer' : `Show all ${mine.length}`}
            </button>
          )}
        </>
      ) : <p className="text-14 text-muted">No dividend filings read for {sym} yet.</p>}
    </Card>
  );
}

function Filings({ sym, announcements }: { sym: string; announcements: ScreenProps['data']['announcements'] }) {
  const list = useMemo(() => dedupeFilings(announcements.filter((a) => a.symbol === sym))
    .sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, 5), [announcements, sym]);
  return (
    <Card className="space-y-1">
      <h2 className="text-16 font-semibold">Recent filings</h2>
      {list.length ? (
        <ul className="divide-y divide-line">
          {list.map((a) => {
            const body = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block text-14 font-medium text-ink">{a.ai_metrics?.headline ?? tidyTitle(a.title, sym)}</span>
                  <span className="block text-12 text-muted">{KIND_WORD[a.kind] ?? 'Notice'} · {day(a.published_at)}</span>
                </span>
                {a.pdf_url && <Icon name="external" className="h-4 w-4 shrink-0 text-brand" label="Opens the PDF" />}
              </>
            );
            return (
              <li key={a.id}>
                {a.pdf_url
                  ? <a href={a.pdf_url} target="_blank" rel="noopener noreferrer" className="press flex min-h-11 items-center gap-3 py-2.5">{body}</a>
                  : <div className="flex min-h-11 items-center gap-3 py-2.5">{body}</div>}
              </li>
            );
          })}
        </ul>
      ) : <p className="py-1 text-14 text-muted">No filings for {sym} in the last weeks.</p>}
      <a href="#/news" onClick={() => haptic()} className="press inline-flex min-h-11 items-center gap-1 text-14 font-semibold text-brand">
        All news<Icon name="chevron" className="h-4 w-4" />
      </a>
    </Card>
  );
}
