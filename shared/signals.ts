/**
 * Market and holding rules, the day's stance, and notification delivery.
 * Pure functions: data in, decisions out.
 */
import type { AiInsight, IndexSnapshot, Rules, Settings } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import type { PortfolioView } from './portfolio.ts';
import { mergeCall } from './portfolio.ts';
import { titleCase } from './format.ts';
import { daysBetween, inWindow, isoWeek, pktParts } from './time.ts';

const fmt0 = (v: number) => Math.round(v).toLocaleString('en-PK');

// ---------------------------------------------------------------------------
// The day's stance: Buy / Hold / Wait with one plain sentence
// ---------------------------------------------------------------------------
export type MarketState = 'crash' | 'crash_level' | 'dip' | 'rally' | 'normal' | 'no_data';

export interface Banner {
  action: 'Buy' | 'Hold' | 'Wait';
  state: MarketState;
  reason: string;
  source: 'ai' | 'rules';
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

export function todayBanner(idx: IndexSnapshot | null, settings: Settings, opts: { stale?: boolean } = {},
  rules: Rules = DEFAULT_RULES): Banner {
  const state = marketState(idx, settings, rules);
  const half = Math.round(settings.crash_fund_pkr * rules.market.crash_fund_deploy_fraction);
  const staleNote = opts.stale ? ' Prices may be out of date.' : '';
  if (state === 'no_data' || !idx) return { action: 'Wait', state, reason: 'No market data yet.', source: 'rules' };
  const ch = idx.change_pct ?? 0;
  const away = ((idx.kse100 - settings.crash_trigger_kse) / idx.kse100) * 100;
  const r = (action: Banner['action'], reason: string): Banner => ({ action, state, reason: reason + staleNote, source: 'rules' });
  switch (state) {
    case 'crash': return r('Buy', `KSE-100 down ${Math.abs(ch).toFixed(1)}%. Crash rule: consider up to Rs ${fmt0(half)} of your crash fund, in steps.`);
    case 'crash_level': return r('Buy', `KSE-100 below your crash level of ${fmt0(settings.crash_trigger_kse)}. Consider half your crash fund (Rs ${fmt0(half)}).`);
    case 'dip': return r('Buy', `KSE-100 down ${Math.abs(ch).toFixed(1)}% today. Good day to put this month's cash to work.`);
    case 'rally': return r('Wait', `KSE-100 up ${ch.toFixed(1)}% today. Don't chase the spike.`);
    default: return r('Hold', `KSE-100 ${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% today, nothing unusual. Crash level is ${away.toFixed(1)}% away.`);
  }
}

/** The AI's stance when it is fresh, except it can never say Buy on a rally day (don't chase). */
export function dayStance(banner: Banner, ai: AiInsight | null, now: Date, rules: Rules = DEFAULT_RULES): Banner {
  if (!ai?.stance || now.getTime() - Date.parse(ai.created_at) > rules.ai.fresh_hours * 3600_000) return banner;
  const action = ai.stance === 'buy' ? 'Buy' : ai.stance === 'wait' ? 'Wait' : 'Hold';
  if (action === 'Buy' && banner.action === 'Wait') return banner;
  if (banner.state === 'crash' || banner.state === 'crash_level') return banner; // crash wording stays exact
  return { action, state: banner.state, reason: ai.headline, source: 'ai' };
}

// ---------------------------------------------------------------------------
// Alert candidates
// ---------------------------------------------------------------------------
/** urgent: always sent (crash). market: actionable, during market hours, counts toward the daily limit.
 *  digest: news and summaries, bundled into the night digest, outside the daily limit. */
export type AlertLevel = 'urgent' | 'market' | 'digest';

export interface AlertCandidate {
  kind: string;
  symbol: string | null;
  title: string;
  message: string;
  dedupe_key: string;
  level: AlertLevel;
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
      kind: 'crash', symbol: null, level: 'urgent', url: '/#/home', dedupe_key: `crash:${date}`,
      title: `Crash: KSE-100 ${ch.toFixed(1)}%`,
      message: `KSE-100 down ${Math.abs(ch).toFixed(1)}% to ${fmt0(idx.kse100)}. Consider using up to Rs ${fmt0(half)} of your crash fund, in steps.`,
    });
  } else if (ch != null && ch <= rules.market.dip_pct) {
    out.push({
      kind: 'dip', symbol: null, level: 'market', url: '/#/portfolio', dedupe_key: `dip:${date}`,
      title: `Dip: KSE-100 ${ch.toFixed(1)}%`, message: `KSE-100 down ${Math.abs(ch).toFixed(1)}%. Good moment for this month's cash.`,
    });
  }
  if (idx.kse100 < settings.crash_trigger_kse) {
    out.push({
      kind: 'crash_level', symbol: null, level: 'urgent', url: '/#/home', dedupe_key: `crash_level:${isoWeek(date)}`,
      title: 'KSE-100 below your crash level',
      message: `KSE-100 at ${fmt0(idx.kse100)} is under ${fmt0(settings.crash_trigger_kse)}. Consider deploying half your crash fund (Rs ${fmt0(half)}).`,
    });
  }
  return out;
}

/**
 * Holding alerts from each holding's call (AI when available, rules otherwise). Buying chances repeat
 * at most every `repeat_days` per stock; cap and sector warnings once a week.
 */
export function holdingAlerts(view: PortfolioView, settings: Settings, date: string, ai: Pick<AiInsight, 'holding_calls'> | null,
  lastSent: (kind: string, symbol: string) => string | null, rules: Rules = DEFAULT_RULES): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const week = isoWeek(date);
  for (const r of view.rows) {
    const s = r.holding.symbol;
    const p = r.price?.price;
    if (p == null) continue;
    const call = mergeCall(r, ai, settings);
    if (call.call === 'opportunity' || call.call === 'average_down') {
      const last = lastSent('buy_chance', s);
      if (!last || daysBetween(last, date) >= rules.holding.repeat_days) {
        out.push({
          kind: 'buy_chance', symbol: s, level: 'market', url: '/#/portfolio', dedupe_key: `buy_chance:${s}:${date}`,
          title: call.call === 'opportunity' ? `Opportunity: ${s}` : `Average down: ${s}`,
          message: `${s} Rs ${p.toFixed(2)}: ${call.text}.`,
        });
      }
    }
    if (r.flags.over_cap) {
      out.push({
        kind: 'over_cap', symbol: s, level: 'market', url: '/#/portfolio', dedupe_key: `over_cap:${s}:${week}`,
        title: `${s} over your ${settings.max_position_pct}% cap`, message: `${s} is ${r.weight_pct!.toFixed(1)}% of your portfolio. Pause new money to it.`,
      });
    } else if (call.call === 'trim') {
      // Your own sell/trim rules (target price, P/E far above the sector, a dividend cut) or the AI's trim call: once a week per stock.
      out.push({
        kind: 'trim', symbol: s, level: 'market', url: '/#/portfolio', dedupe_key: `trim:${s}:${week}`,
        title: `Trim? ${s}`, message: `${s} Rs ${p.toFixed(2)}: ${call.text}. Plan the sale in Portfolio → Sell.`,
      });
    }
    if (r.call.call === 'review' && r.holding.status !== 'review') {
      // A review date reached: a digest item, once a week per stock.
      out.push({
        kind: 'review_due', symbol: s, level: 'digest', url: '/#/portfolio', dedupe_key: `review_due:${s}:${week}`,
        title: `Review ${s}`, message: `${s}: ${r.call.text}.`,
      });
    }
    if (r.flags.big_move && r.price?.change_pct != null) {
      const c = r.price.change_pct;
      out.push({
        kind: 'big_move', symbol: s, level: 'market', url: '/#/portfolio', dedupe_key: `big_move:${s}:${date}`,
        title: `${s} ${c > 0 ? '+' : ''}${c.toFixed(1)}% today`, message: `${s} moved ${c > 0 ? '+' : ''}${c.toFixed(1)}% to Rs ${p.toFixed(2)}.`,
      });
    }
  }
  for (const tip of view.rebalance.filter((t) => t.kind === 'sector')) {
    out.push({
      kind: 'rebalance', symbol: null, level: 'digest', url: '/#/home', dedupe_key: `rebalance:${tip.name}:${week}`,
      title: `Rebalance: ${titleCase(tip.name)} ${tip.pct.toFixed(0)}%`, message: tip.text,
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
  suppressed: AlertCandidate[]; // over the daily limit or notifications off: logged to the app's history, never pushed
  deferred: AlertCandidate[]; // quiet hours, or a digest item outside the digest run: not logged, sent later
}

/**
 * One notification per level per run. Urgent always goes out. Market alerts respect quiet hours and the
 * daily limit. Digest items only go out in the night digest run (`digestRun`), outside the daily limit.
 */
export function planDelivery(cands: AlertCandidate[], o: {
  now: Date; sentToday: number; quiet: { start: string; end: string }; enabled: boolean; digestRun?: boolean; maxPerDay?: number; titlePrefix?: string;
}): DeliveryPlan {
  const plan: DeliveryPlan = { send: [], suppressed: [], deferred: [] };
  if (!cands.length) return plan;
  if (!o.enabled) return { ...plan, suppressed: cands };
  const max = o.maxPerDay ?? DEFAULT_RULES.notifications.max_per_day;
  const quiet = inWindow(pktParts(o.now).minutes, o.quiet.start, o.quiet.end);
  const urgent = cands.filter((c) => c.level === 'urgent');
  const market = cands.filter((c) => c.level === 'market');
  const digest = cands.filter((c) => c.level === 'digest');

  if (urgent.length) plan.send.push(bundle(urgent, true));
  if (market.length) {
    if (quiet) plan.deferred.push(...market);
    else if (o.sentToday >= max) plan.suppressed.push(...market);
    else plan.send.push(bundle(market, false, o.titlePrefix));
  }
  if (digest.length) {
    if (!o.digestRun || quiet) plan.deferred.push(...digest);
    else plan.send.push(bundle(digest, false));
  }
  return plan;
}

function bundle(alerts: AlertCandidate[], urgent: boolean, prefix = ''): Notification {
  const lead = alerts.find((a) => a.kind === 'night_digest') ?? alerts[0];
  const rest = alerts.filter((a) => a !== lead);
  const title = alerts.length === 1 || lead.kind === 'night_digest'
    ? lead.title
    : `${alerts.length} updates: ${alerts.map((a) => a.symbol ?? a.kind.replace('_', ' ')).slice(0, 4).join(', ')}`;
  return {
    title: prefix + title,
    body: alerts.length === 1 ? lead.message
      : [lead, ...rest].slice(0, 5).map((a) => `• ${a.message}`).join('\n') + (alerts.length > 5 ? `\n+${alerts.length - 5} more in the app` : ''),
    url: urgent ? '/#/home' : alerts.every((a) => a.url === lead.url) ? lead.url : '/#/news',
    urgent,
    alerts: [lead, ...rest],
  };
}
