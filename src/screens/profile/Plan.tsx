import { useMemo } from 'react';
import { latest } from '../../../shared/compass.ts';
import { buildPortfolio, screenSectors } from '../../../shared/portfolio.ts';
import { pktDate } from '../../../shared/time.ts';
import { DEFAULT_RULES } from '../../../shared/types.ts';
import { GrowthCard } from '../../components/Growth.tsx';
import { Card } from '../../components/ui.tsx';
import { NumberInput, Row, RowCard, SectionPage, type SectionProps } from './controls.tsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** CPI readings are monthly (dated the 1st): "Sep 2026". */
const monthOf = (isoDate: string) => `${MONTHS[Number(isoDate.slice(5, 7)) - 1]} ${isoDate.slice(0, 4)}`;

export function PlanSection({ data, save }: SectionProps) {
  const s = data.settings;
  const value = useMemo(() => buildPortfolio(data.holdings, data.prices, s, DEFAULT_RULES, screenSectors(data.screen)).total_value, [data, s]);
  const cpi = latest(data.macro, 'cpi_yoy', pktDate(new Date()));
  const cpiHint = cpi ? ` Latest CPI ${cpi.value.toFixed(1)}% (${monthOf(cpi.as_of)}, PBS${cpi.stale ? ', older figure' : ''}).` : '';

  return (
    <SectionPage title="My plan">
      <RowCard>
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
      </RowCard>

      <h2 className="px-1 pt-2 text-20 font-semibold">Goals & projection</h2>
      <Card><GrowthCard start={value} monthly={s.monthly_budget_pkr} stepUpPct={s.sip_step_up_pct} inflationPct={s.inflation_pct} /></Card>
      <RowCard>
        <Row icon="growth" label="Inflation" hint={`Turns future rupees into today's money.${cpiHint}`}>
          <NumberInput label="Inflation" suffix="%" value={s.inflation_pct} min={0} max={50} width="w-24" onSave={(v) => save({ inflation_pct: v })} />
        </Row>
      </RowCard>
    </SectionPage>
  );
}
