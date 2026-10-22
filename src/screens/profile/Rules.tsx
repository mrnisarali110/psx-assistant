import type { Settings } from '../../../shared/types.ts';
import { Toggle } from '../../components/ui.tsx';
import { Note, NumberInput, Row, RowCard, SectionPage, type SectionProps } from './controls.tsx';

/** Rules that are switched on: caps always count; the others count when set above 0 or toggled on. */
export function activeRules(s: Settings): number {
  return [
    s.max_position_pct > 0, s.max_sector_pct > 0, s.buy_more_below_pct > 0, s.drop_alert_pct > 0, s.shariah_only,
    s.hard_stock_cap_pct > 0, s.hard_sector_cap_pct > 0, s.review_after_loss_quarters > 0, s.sell_after_loss_quarters > 0,
    s.trim_pe_over_sector_pct > 0, s.trim_on_dividend_cut,
  ].filter(Boolean).length;
}

export function RulesSection({ data, save }: SectionProps) {
  const s = data.settings;
  return (
    <SectionPage title="My rules">
      <h2 className="px-1 text-16 font-semibold">Buying</h2>
      <RowCard>
        <Row icon="scale" label="Max per stock" hint="Soft cap: no new money above this share of the portfolio.">
          <NumberInput label="Max per stock" suffix="%" value={s.max_position_pct} min={1} max={100} width="w-24" onSave={(v) => save({ max_position_pct: v })} />
        </Row>
        <Row icon="scale" label="Max per sector" hint="Soft cap: no new money into a sector above this share.">
          <NumberInput label="Max per sector" suffix="%" value={s.max_sector_pct} min={1} max={100} width="w-24" onSave={(v) => save({ max_sector_pct: v })} />
        </Row>
        <Row icon="bag" label="Buy more below" hint="Mark Buy more this far below my last buy, only when its P/E is at or under its sector's and profit is not falling.">
          <NumberInput label="Buy more below last buy" suffix="%" value={s.buy_more_below_pct} min={1} max={99} width="w-24" onSave={(v) => save({ buy_more_below_pct: v })} />
        </Row>
        <Row icon="bag" label="Opportunity alert" hint="Tell me when a stock is this far below my last buy, with the same value check.">
          <NumberInput label="Opportunity alert" suffix="%" value={s.drop_alert_pct} min={1} max={99} width="w-24" onSave={(v) => save({ drop_alert_pct: v })} />
        </Row>
        <Row icon="shield" label="Shariah-compliant only" hint="Discover and AI suggest only KMI All Share stocks.">
          <Toggle label="Shariah-compliant only" checked={s.shariah_only} onChange={(v) => save({ shariah_only: v })} />
        </Row>
      </RowCard>

      <h2 className="px-1 pt-2 text-16 font-semibold">Selling and trimming</h2>
      <Note>A holding over its hard cap or at its target price is always marked Trim, with the reason; a review date reached marks it Review.</Note>
      <RowCard>
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
        <Row icon="up" label="Trim when P/E runs ahead of its sector by" hint="Compared with the sector's typical P/E on the KSE-100 screen. 0 turns it off.">
          <NumberInput label="Trim when P/E is this much above its sector" suffix="%" value={s.trim_pe_over_sector_pct} min={0} max={500} width="w-24" onSave={(v) => save({ trim_pe_over_sector_pct: v })} />
        </Row>
        <Row icon="coins" label="Trim on a dividend cut" hint="The latest declared dividend is more than 10% below the previous one of its kind.">
          <Toggle label="Trim on a dividend cut" checked={s.trim_on_dividend_cut} onChange={(v) => save({ trim_on_dividend_cut: v })} />
        </Row>
      </RowCard>
    </SectionPage>
  );
}
