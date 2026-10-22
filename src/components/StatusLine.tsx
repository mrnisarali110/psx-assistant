/**
 * Home's calm status: one line ("Hold — nothing to do today") and "What would change this?", a sheet with the
 * conditions that would turn today into Add, Trim or Review, each from your own settings and the rules file, with
 * what is true right now.
 */
import { useState } from 'react';
import type { Settings } from '../../shared/types.ts';
import { DEFAULT_RULES } from '../../shared/types.ts';
import { num, rs } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';

export type DayState = 'hold' | 'add' | 'review' | 'trim';

const LOOK: Record<DayState, { icon: IconName; cls: string }> = {
  hold: { icon: 'check', cls: 'bg-surface-2 text-ink' },
  add: { icon: 'plus', cls: 'bg-brand/10 text-brand' },
  trim: { icon: 'alert', cls: 'bg-caution/10 text-caution' },
  review: { icon: 'alert', cls: 'bg-caution/10 text-caution' },
};

/** "Hold: nothing to do today" → "Hold — nothing to do today". */
export const statusWords = (headline: string) => headline.replace(': ', ' — ');

export interface StatusInputs {
  state: DayState;
  headline: string;
  reason: string; // the market or AI reason behind today's stance
  settings: Settings;
  cashLeft: number;
  addable: string[];
  trims: string[];
  reviews: string[];
}

export function StatusLine(p: StatusInputs) {
  const [open, setOpen] = useState(false);
  const look = LOOK[p.state];
  return (
    <div role="status" className="flex items-start gap-3 rounded-card bg-surface px-4 pt-3 pb-1 ring-1 ring-line lg:items-center lg:py-2">
      <span aria-hidden="true" className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full lg:mt-0 ${look.cls}`}>
        <Icon name={look.icon} className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col lg:flex-row lg:items-center lg:justify-between lg:gap-4">
        <span className="pt-1 text-16 font-semibold leading-snug lg:pt-0">{statusWords(p.headline)}</span>
        <button type="button" onClick={() => { haptic(); setOpen(true); }}
          className="press -ml-1 inline-flex min-h-11 shrink-0 cursor-pointer items-center self-start px-1 text-14 font-semibold text-brand lg:self-auto">
          What would change this?
        </button>
      </span>
      <Sheet open={open} onClose={() => setOpen(false)} title="What would change this?">
        <Conditions {...p} />
      </Sheet>
    </div>
  );
}

function Conditions(p: StatusInputs) {
  const s = p.settings;
  const m = DEFAULT_RULES.market;
  const list = (xs: string[]) => xs.join(', ');
  const blocks: { title: string; icon: IconName; when: string[]; now: string }[] = [
    {
      title: 'Add', icon: 'plus',
      when: [
        `The market says buy: KSE-100 down ${Math.abs(m.dip_pct)}% or more in a day, or below your crash level of ${num(s.crash_trigger_kse, 0)}, or a fresh AI view says buy. Never on a rally day (up ${m.rally_pct}% or more).`,
        `You have money left this month (your plan: ${rs(s.monthly_budget_pkr)}).`,
        `A stock qualifies: ${s.buy_more_below_pct}% or more below your last buy and not dearer than its sector, with room under your caps (${s.max_position_pct}% a stock, ${s.max_sector_pct}% a sector).`,
      ],
      now: `${rs(Math.max(0, p.cashLeft))} left this month. ${p.addable.length ? `Qualifies now: ${list(p.addable)}.` : 'Nothing qualifies right now.'}`,
    },
    {
      title: 'Trim', icon: 'tag',
      when: [
        `A stock grows past ${s.hard_stock_cap_pct}% of your portfolio, or a sector past ${s.hard_sector_cap_pct}%.`,
        `A stock's P/E runs ${s.trim_pe_over_sector_pct}% above its sector's typical P/E.`,
        ...(s.trim_on_dividend_cut ? ['A company cuts its dividend.'] : []),
        ...(s.sell_after_loss_quarters > 0 ? [`${s.sell_after_loss_quarters} loss-making quarters in a row (sell).`] : []),
      ],
      now: p.trims.length ? `Your rules say trim: ${list(p.trims)}.` : 'None of your stocks meets a trim rule.',
    },
    {
      title: 'Review', icon: 'alert',
      when: [
        ...(s.review_after_loss_quarters > 0 ? [`A company makes a loss ${s.review_after_loss_quarters} quarters in a row.`] : []),
        'A review date you set for a stock comes due.',
      ],
      now: p.reviews.length ? `To review: ${list(p.reviews)}.` : 'Nothing to review.',
    },
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-control bg-surface-2 p-3">
        <p className="text-14 font-semibold">{statusWords(p.headline)}</p>
        <p className="mt-0.5 text-14 text-muted">{p.reason}</p>
      </div>
      {blocks.map((b) => (
        <section key={b.title} className="space-y-1.5">
          <h3 className="flex items-center gap-2 text-16 font-semibold"><Icon name={b.icon} className="h-4 w-4 text-muted" />{b.title} when</h3>
          <ul className="list-disc space-y-1 pl-5 text-14">
            {b.when.map((w) => <li key={w}>{w}</li>)}
          </ul>
          <p className="text-14 text-muted">Now: {b.now}</p>
        </section>
      ))}
      <p className="text-12 text-muted">Change these in Profile → My rules.</p>
    </div>
  );
}
