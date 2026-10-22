/**
 * First-run setup for a signed-in account with no holdings: Import holdings → Monthly investment → Your rules.
 * Every step can be skipped; finishing or skipping saves settings.onboarded so it never comes back.
 */
import { useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import type { Settings } from '../../shared/types.ts';
import { rs } from '../../shared/format.ts';
import { screenSectors } from '../../shared/portfolio.ts';
import { ImportSheet } from '../components/ImportSheet.tsx';
import { Icon } from '../components/Icon.tsx';
import { LogoMark } from '../components/Splash.tsx';
import { useToast } from '../components/Toast.tsx';
import { Button, Card, Field, Toggle, inputCls } from '../components/ui.tsx';

const STEPS = ['Import holdings', 'Monthly investment', 'Your rules'] as const;

export function FirstRun({ data, source, reload, onDone }: ScreenProps & { onDone: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = data.settings;
  const [budget, setBudget] = useState(String(s.monthly_budget_pkr));
  const [maxStock, setMaxStock] = useState(String(s.max_position_pct));
  const [maxSector, setMaxSector] = useState(String(s.max_sector_pct));
  const [shariah, setShariah] = useState(s.shariah_only);

  const save = async (patch: Partial<Settings>) => {
    setBusy(true);
    try { await source.saveSettings(patch); await reload(); return true; } catch (e) { toast((e as Error).message); return false; } finally { setBusy(false); }
  };
  const finish = async (patch: Partial<Settings> = {}) => { if (await save({ ...patch, onboarded: true })) onDone(); };
  const positive = (v: string) => Number.isFinite(Number(v)) && Number(v) > 0;
  const pctOk = (v: string) => positive(v) && Number(v) <= 100;

  return (
    <div className="mx-auto max-w-lg space-y-5 pt-2">
      <div className="space-y-2">
        <LogoMark className="h-12 w-12" />
        <h1 className="text-28 font-bold tracking-tight">Set up PSX Assist</h1>
        <p className="text-14 text-muted">Three quick steps. Skip any of them and change it later in Profile.</p>
      </div>

      <ol className="flex gap-2" aria-label="Setup steps">
        {STEPS.map((t, i) => (
          <li key={t} className="flex-1" aria-current={i === step ? 'step' : undefined}>
            <span className={`block h-1.5 rounded-full ${i <= step ? 'bg-brand' : 'bg-surface-2'}`} />
            <span className={`mt-1.5 block text-12 ${i === step ? 'font-semibold text-ink' : 'text-muted'}`}>{t}</span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-20 font-semibold">Import your holdings</h2>
            <p className="text-14 text-muted">Take screenshots of your holdings in your broker app; the AI reads the symbols, shares and average cost, and you check every row before saving.</p>
          </div>
          {data.holdings.length > 0 && (
            <p className="flex items-center gap-2 text-14"><Icon name="check" className="h-4 w-4 text-brand" />{data.holdings.length} holdings saved</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={() => setImporting(true)} className="flex-1"><Icon name="camera" />Import from screenshots</Button>
            <Button kind="secondary" onClick={() => setStep(1)} className="flex-1">{data.holdings.length ? 'Next' : 'Add them later'}</Button>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-20 font-semibold">How much do you invest each month?</h2>
            <p className="text-14 text-muted">Home tracks this month's buys against it, and only says Add while money is left.</p>
          </div>
          <Field label="Monthly investment (Rs)" hint={positive(budget) ? rs(Number(budget)) : 'Enter an amount above zero'}>
            <input className={inputCls} type="number" inputMode="numeric" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} />
          </Field>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="flex-1" disabled={busy || !positive(budget)}
              onClick={async () => { if (await save({ monthly_budget_pkr: Math.round(Number(budget)) })) setStep(2); }}>Save and continue</Button>
            <Button kind="secondary" className="flex-1" onClick={() => setStep(2)}>Skip</Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-20 font-semibold">Your rules</h2>
            <p className="text-14 text-muted">Limits that stop new money going into one stock or sector. More rules are in Profile → My rules.</p>
          </div>
          <Field label="Most in one stock (% of portfolio)" hint={pctOk(maxStock) ? undefined : 'Between 1 and 100'}>
            <input className={inputCls} type="number" inputMode="decimal" min={1} max={100} value={maxStock} onChange={(e) => setMaxStock(e.target.value)} />
          </Field>
          <Field label="Most in one sector (% of portfolio)" hint={pctOk(maxSector) ? undefined : 'Between 1 and 100'}>
            <input className={inputCls} type="number" inputMode="decimal" min={1} max={100} value={maxSector} onChange={(e) => setMaxSector(e.target.value)} />
          </Field>
          <div className="flex min-h-11 items-center justify-between gap-3">
            <span className="text-14 font-medium">Shariah-compliant stocks only</span>
            <Toggle checked={shariah} onChange={setShariah} label="Shariah-compliant stocks only" />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="flex-1" disabled={busy || !pctOk(maxStock) || !pctOk(maxSector)}
              onClick={() => finish({ max_position_pct: Number(maxStock), max_sector_pct: Number(maxSector), shariah_only: shariah })}>Finish</Button>
            <Button kind="secondary" className="flex-1" disabled={busy} onClick={() => finish()}>Keep the defaults</Button>
          </div>
        </Card>
      )}

      <div className="text-center">
        <button type="button" disabled={busy} onClick={() => finish()} className="min-h-11 cursor-pointer px-3 text-14 text-muted underline underline-offset-2">
          Skip setup
        </button>
      </div>

      <ImportSheet open={importing} onClose={() => setImporting(false)} source={source} holdings={data.holdings} prices={data.prices}
        sectors={screenSectors(data.screen)} screen={data.screen}
        onApplied={async (summary) => { setImporting(false); toast(summary); await reload(); setStep(1); }} />
    </div>
  );
}
