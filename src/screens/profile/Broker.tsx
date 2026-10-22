import { previousTaxYears, taxYear } from '../../../shared/tax.ts';
import { pktDate } from '../../../shared/time.ts';
import { DEFAULT_RULES } from '../../../shared/types.ts';
import { Segmented, Toggle } from '../../components/ui.tsx';
import { Note, NumberInput, Row, RowCard, SectionPage, TextInput, type SectionProps } from './controls.tsx';

export function BrokerSection({ data, save }: SectionProps) {
  const s = data.settings;
  const year = taxYear(pktDate(new Date()));
  const priorYears = previousTaxYears(year, DEFAULT_RULES.tax.loss_carry_forward_years);
  return (
    <SectionPage title="Broker & tax">
      <RowCard>
        <Row icon="briefcase" label="Broker">
          <TextInput label="Broker" value={s.broker} onSave={(v) => save({ broker: v })} />
        </Row>
        <Row icon="coins" label="Commission" hint="Per side, % of trade value. PSX minimum 0.15%.">
          <NumberInput label="Commission" suffix="%" value={s.commission_pct} min={0} max={5} width="w-24" decimals={3} onSave={(v) => save({ commission_pct: v })} />
        </Row>
        <Row icon="coins" label="Minimum per share" hint="Whichever is higher applies: cheap shares cost more per rupee.">
          <NumberInput label="Minimum commission per share" prefix="Rs" value={s.min_commission_per_share} min={0} max={100} width="w-28" decimals={3} onSave={(v) => save({ min_commission_per_share: v })} />
        </Row>
        <Row icon="scale" label="Sales tax on commission" hint="Sindh 15%; some brokers show 13%.">
          <NumberInput label="Sales tax on commission" suffix="%" value={s.sales_tax_pct} min={0} max={100} width="w-24" onSave={(v) => save({ sales_tax_pct: v })} />
        </Row>
      </RowCard>
      <RowCard>
        <div className="space-y-2 py-3">
          <p className="text-16 font-medium">Tax status</p>
          <Segmented label="Tax status" value={s.tax_filer ? 'filer' : 'non'} onChange={(v) => save({ tax_filer: v === 'filer' })}
            options={[{ value: 'filer', label: 'Filer' }, { value: 'non', label: 'Non-filer' }]} />
          <p className="text-14 text-muted">On the Active Taxpayer List (filer): 15% capital gains tax and 15% dividend tax. Non-filer: 30% on dividends.</p>
        </div>
        <Row icon="check" label="Match NCCPL statement" hint="Count gains without broker charges, the way NCCPL's monthly CGT statement does.">
          <Toggle label="Match NCCPL statement" checked={s.match_nccpl} onChange={(v) => save({ match_nccpl: v })} />
        </Row>
        <Row icon="receipt" label={`CGT deducted in ${year}`} hint="From your monthly NCCPL statements, so Tax shows what is still due or refundable.">
          <NumberInput label={`CGT deducted in ${year}`} prefix="Rs" value={s.cgt_paid[year] ?? 0} min={0} max={100_000_000} width="w-32" decimals={0} onSave={(v) => save({ cgt_paid: { ...s.cgt_paid, [year]: v } })} />
        </Row>
        {priorYears.map((y) => (
          <Row key={y} icon="down" label={`Loss carried from ${y}`} hint={y === priorYears[0] ? 'Net loss of that tax year still unused (filers only, 3 years).' : undefined}>
            <NumberInput label={`Loss carried forward from ${y}`} prefix="Rs" value={s.loss_carry_forward[y] ?? 0} min={0} max={100_000_000} width="w-32" decimals={0}
              onSave={(v) => save({ loss_carry_forward: { ...s.loss_carry_forward, [y]: v } })} />
          </Row>
        ))}
      </RowCard>
      <Note>Defaults come from PSX notice N-1026 and the FY 2026-27 tax rates; check them once against a real contract note and NCCPL statement. Nothing here is tax advice.</Note>
    </SectionPage>
  );
}
