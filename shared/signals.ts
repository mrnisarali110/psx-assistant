/**
 * Market and holding rules (spec section 7) plus notification limits (section 8).
 * Pure functions: data in, decisions out. Wording comes from templates here.
 */
import type { IndexSnapshot, Rules, Settings } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import type { PortfolioView } from './portfolio.ts';
import { titleCase } from './allocate.ts';
import { daysBetween, inWindow, isoWeek, pktParts } from './time.ts';

const fmt0 = (v: number) => Math.round(v).toLocaleString('en-PK');

// ---------------------------------------------------------------------------
// Today banner: Buy, Hold or Wait, with one plain sentence
// ---------------------------------------------------------------------------
export type MarketState = 'crash' | 'crash_level' | 'dip' | 'rally' | 'normal' | 'no_data';

export interface Banner {
  action: 'Buy' | 'Hold' | 'Wait';
  state: MarketState;
  reason: string;
}

export function marketState(idx: IndexSnapshot | null, settings: Settings, rules: Rules = DEFAULT_RULES): MarketState {
  if (!idx || idx.kse100 == null) return 'no_data';
  const ch = idx.change_pct;
  if (ch != null && ch <= rules.market.crash_pct) return 'crash';
  if (idx.kse100 < settings.crash_trigger_kse) return 'crash_level';
  if (ch != null && ch <= rules.market.dip_pct) return 'dip';
  if (ch != null && ch >= rules.market.rally_pct) return 'rally';
  return 'normal';
}

export function todayBanner(idx: IndexSnapshot | null, settings: Settings,
  opts: { stale?: boolean; trancheDue?: { index: number; date: string } | null } = {},
  rules: Rules = DEFAULT_RULES): Banner {
  const state = marketState(idx, settings, rules);
  const half = Math.round(settings.crash_fund_pkr * rules.market.crash_fund_deploy_fraction);
  const staleNote = opts.stale ? ' Prices may be out of date, so check your broker app.' : '';
  if (state === 'no_data' || !idx) {
    return { action: 'Wait', state, reason: 'No market data yet. Check live prices in your broker app.' };
  }
  const ch = idx.change_pct ?? 0;
  const away = ((idx.kse100 - settings.crash_trigger_kse) / idx.kse100) * 100;
  switch (state) {
    case 'crash':
      return { action: 'Buy', state, reason: `KSE-100 down ${Math.abs(ch).toFixed(1)}% today. Crash rule: consider using up to Rs ${fmt0(half)} of your crash fund, in steps.${staleNote}` };
    case 'crash_level':
      return { action: 'Buy', state, reason: `KSE-100 at ${fmt0(idx.kse100)} is below your crash level of ${fmt0(settings.crash_trigger_kse)}. Consider deploying half your crash fund (Rs ${fmt0(half)}).${staleNote}` };
    case 'dip':
      return { action: 'Buy', state, reason: `KSE-100 down ${Math.abs(ch).toFixed(1)}% today. Good day for your next tranche.${staleNote}` };
    case 'rally':
      return { action: 'Wait', state, reason: `KSE-100 up ${ch.toFixed(1)}% today. Don't chase the spike; buy in tranches.${staleNote}` };
    default:
      if (opts.trancheDue) {
        return { action: 'Buy', state, reason: `Tranche ${opts.trancheDue.index} of your plan is due today. KSE-100 ${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%.${staleNote}` };
      }
      return { action: 'Hold', state, reason: `KSE-100 ${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% today, no signal. Crash-fund trigger is ${away.toFixed(1)}% away.${staleNote}` };
  }
}

// ---------------------------------------------------------------------------
// Alert candidates
// ---------------------------------------------------------------------------
export interface AlertCandidate {
  kind: string;
  symbol: string | null;
  title: string;
  message: string;
  dedupe_key: string;
  urgent: boolean; // crash alerts ignore the daily limit and quiet hours
  url: string; // screen to open on tap
}

export function marketAlerts(idx: IndexSnapshot | null, settings: Settings, date: string,
  rules: Rules = DEFAULT_RULES): AlertCandidate[] {
  if (!idx) return [];
  const out: AlertCandidate[] = [];
  const ch = idx.change_pct;
  const half = Math.round(settings.crash_fund_pkr * rules.market.crash_fund_deploy_fraction);
  if (ch != null && ch <= rules.market.crash_pct) {
    out.push({
      kind: 'crash', symbol: null, urgent: true, url: '/#/today', dedupe_key: `crash:${date}`,
      title: `Crash: KSE-100 ${ch.toFixed(1)}%`,
      message: `KSE-100 down ${Math.abs(ch).toFixed(1)}% to ${fmt0(idx.kse100)}. Consider using up to Rs ${fmt0(half)} of your crash fund, in steps.`,
    });
  } else if (ch != null && ch <= rules.market.dip_pct) {
    out.push({
      kind: 'dip', symbol: null, urgent: false, url: '/#/plan', dedupe_key: `dip:${date}`,
      title: `Dip: KSE-100 ${ch.toFixed(1)}%`,
      message: `KSE-100 down ${Math.abs(ch).toFixed(1)}%. Consider your next tranche.`,
    });
  } else if (ch != null && ch >= rules.market.rally_pct) {
    out.push({
      kind: 'rally', symbol: null, urgent: false, url: '/#/today', dedupe_key: `rally:${date}`,
      title: `Rally: KSE-100 +${ch.toFixed(1)}%`,
      message: `KSE-100 up ${ch.toFixed(1)}%. Don't chase it; stick to your tranches.`,
    });
  }
  if (idx.kse100 < settings.crash_trigger_kse) {
    out.push({
      kind: 'crash_level', symbol: null, urgent: true, url: '/#/today', dedupe_key: `crash_level:${isoWeek(date)}`,
      title: 'KSE-100 below your crash level',
      message: `KSE-100 at ${fmt0(idx.kse100)} is under ${fmt0(settings.crash_trigger_kse)}. Consider deploying half your crash fund (Rs ${fmt0(half)}).`,
    });
  }
  return out;
}

/**
 * Holding rules. `lastSent(kind, symbol)` returns the YYYY-MM-DD this alert was last sent, or null,
 * so "below cost" repeats at most every `below_cost_repeat_days`.
 */
export function holdingAlerts(view: PortfolioView, settings: Settings, date: string,
  lastSent: (kind: string, symbol: string) => string | null, rules: Rules = DEFAULT_RULES): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const week = isoWeek(date);
  for (const r of view.rows) {
    const s = r.holding.symbol;
    const p = r.price?.price;
    if (p == null) continue;
    if (r.flags.over_cap) {
      out.push({
        kind: 'over_cap', symbol: s, urgent: false, url: '/#/portfolio', dedupe_key: `over_cap:${s}:${week}`,
        title: `${s} over your ${settings.max_position_pct}% cap`,
        message: `${s} is ${r.weight_pct!.toFixed(1)}% of your portfolio (cap ${settings.max_position_pct}%). No new money goes to it.`,
      });
    }
    if (r.flags.below_cost) {
      const last = lastSent('below_cost', s);
      if (!last || daysBetween(last, date) >= rules.holding.below_cost_repeat_days) {
        const below = ((r.holding.avg_cost - p) / r.holding.avg_cost) * 100;
        out.push({
          kind: 'below_cost', symbol: s, urgent: false, url: '/#/portfolio', dedupe_key: `below_cost:${s}:${date}`,
          title: `${s} ${below.toFixed(1)}% below your cost`,
          message: `${s} at Rs ${p.toFixed(2)} is ${below.toFixed(1)}% below your average cost of Rs ${r.holding.avg_cost.toFixed(2)}.${r.holding.status === 'core' ? ' Core holding: eligible for averaging down.' : ''}`,
        });
      }
    }
    if (r.flags.big_move && r.price?.change_pct != null) {
      const c = r.price.change_pct;
      out.push({
        kind: 'big_move', symbol: s, urgent: false, url: '/#/portfolio', dedupe_key: `big_move:${s}:${date}`,
        title: `${s} ${c > 0 ? '+' : ''}${c.toFixed(1)}% today`,
        message: `${s} moved ${c > 0 ? '+' : ''}${c.toFixed(1)}% today to Rs ${p.toFixed(2)}.`,
      });
    }
  }
  for (const sector of view.sectors_over_limit) {
    const pct = view.sector_weights.find((w) => w.sector === sector)?.pct ?? 0;
    out.push({
      kind: 'sector_limit', symbol: null, urgent: false, url: '/#/portfolio',
      dedupe_key: `sector_limit:${sector}:${week}`,
      title: `${titleCase(sector)} is ${pct.toFixed(0)}% of your portfolio`,
      message: `${titleCase(sector)} is ${pct.toFixed(1)}%, above the ${rules.holding.sector_limit_pct}% sector limit.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delivery: daily limit, quiet hours, bundling
// ---------------------------------------------------------------------------
export interface Notification {
  title: string;
  body: string;
  url: string;
  urgent: boolean;
  alerts: AlertCandidate[];
}

export interface DeliveryPlan {
  send: Notification[];
  suppressed: AlertCandidate[]; // logged so they show in the app's alert history, never pushed
}

/**
 * Crash alerts always go out (one bundled notification). Everything else in this run is bundled
 * into a single notification, unless it is quiet hours or the user already got `max_per_day` today.
 */
export function planDelivery(cands: AlertCandidate[], o: {
  now: Date; sentToday: number; quiet: { start: string; end: string }; enabled: boolean; maxPerDay?: number;
}): DeliveryPlan {
  if (!cands.length) return { send: [], suppressed: [] };
  if (!o.enabled) return { send: [], suppressed: cands };
  const max = o.maxPerDay ?? DEFAULT_RULES.notifications.max_per_day;
  const urgent = cands.filter((c) => c.urgent);
  const normal = cands.filter((c) => !c.urgent);
  const send: Notification[] = [];
  const suppressed: AlertCandidate[] = [];
  let used = o.sentToday;

  if (urgent.length) {
    send.push(bundle(urgent, true));
    used++;
  }
  const quiet = inWindow(pktParts(o.now).minutes, o.quiet.start, o.quiet.end);
  if (normal.length) {
    if (quiet || used >= max) suppressed.push(...normal);
    else send.push(bundle(normal, false));
  }
  return { send, suppressed };
}

export const SUMMARY_KINDS = new Set(['morning_brief', 'daily_summary', 'weekly_plan', 'data_unavailable']);

function bundle(alerts: AlertCandidate[], urgent: boolean): Notification {
  if (alerts.length === 1) {
    const a = alerts[0];
    return { title: a.title, body: a.message, url: a.url, urgent, alerts };
  }
  // Dips and other alerts from the same run are bundled into one notification.
  const summary = alerts.find((a) => SUMMARY_KINDS.has(a.kind));
  if (summary) alerts = [summary, ...alerts.filter((a) => a !== summary)];
  return {
    title: urgent ? alerts[0].title
      : summary ? `${summary.title} (+${alerts.length - 1} more)`
      : `${alerts.length} updates: ${alerts.map((a) => a.symbol ?? a.kind.replace('_', ' ')).slice(0, 4).join(', ')}`,
    body: alerts.slice(0, 5).map((a) => `• ${a.message}`).join('\n') +
      (alerts.length > 5 ? `\n+${alerts.length - 5} more in the app` : ''),
    url: urgent ? '/#/today' : alerts.every((a) => a.url === alerts[0].url) ? alerts[0].url : '/#/news',
    urgent,
    alerts,
  };
}
