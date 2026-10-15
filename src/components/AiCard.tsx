import type { AiInsight, AiSuggestion } from '../../shared/types.ts';
import { ago } from '../../shared/format.ts';
import type { BcState } from '../../shared/bluechip.ts';
import { Icon } from './Icon.tsx';
import { Card, Tag, type Tone } from './ui.tsx';

const ACTION: Record<AiSuggestion['action'], { label: string; tone: Tone }> = {
  buy: { label: 'Buy', tone: 'green' }, add: { label: 'Buy more', tone: 'green' }, hold: { label: 'Hold', tone: 'slate' },
  trim: { label: 'Trim', tone: 'amber' }, sell: { label: 'Sell', tone: 'red' }, watch: { label: 'Watch', tone: 'teal' },
  review: { label: 'Review', tone: 'amber' },
};

export function AiBadge() {
  return <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-300"><Icon name="sparkles" className="h-3 w-3" />AI</span>;
}

/** "AI Assistant suggests": suggestions plus the monthly cash note. */
export function AiCard({ insight, aiEnabled, demo, bc = {} }: { insight: AiInsight | null; aiEnabled: boolean; demo: boolean; bc?: Record<string, BcState> }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 font-semibold"><Icon name="sparkles" className="h-5 w-5 text-violet-500" />AI Assistant suggests</p>
        {insight && <span className="text-xs text-slate-500 dark:text-slate-400">{ago(insight.created_at)}</span>}
      </div>
      {!insight ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {demo ? 'Sign in to get AI suggestions on your own portfolio.'
            : aiEnabled ? 'Suggestions arrive with the next market check (every 30 minutes while PSX is open).'
            : 'AI suggestions are off. Turn them on in Profile.'}
        </p>
      ) : (
        <>
          {insight.suggestions.length === 0 && <p className="text-sm">{insight.headline}</p>}
          <ul className="space-y-3">
            {insight.suggestions.map((s, i) => (
              <li key={i} className="flex gap-3">
                <Tag tone={ACTION[s.action]?.tone ?? 'slate'}>{ACTION[s.action]?.label ?? s.action}</Tag>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{s.symbol && <span className="font-bold">{s.symbol} · </span>}{s.text}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{s.why}</p>
                  {s.symbol && (s.action === 'buy' || s.action === 'add' || s.action === 'watch') && bc[s.symbol]?.status === 'not_bc' && (
                    <p className="mt-0.5 text-xs font-medium text-rose-700 dark:text-rose-300">Not a blue chip — higher risk</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {insight.cash_note && <p className="flex gap-2 rounded-2xl bg-teal-50 p-3 text-sm dark:bg-teal-950/40"><Icon name="coins" className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />{insight.cash_note}</p>}
          {insight.risks && <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-400"><Icon name="alert" className="h-4 w-4 shrink-0" />{insight.risks}</p>}
          <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">Built only from PSX data and your rules; anything that breaks your rules or quotes an unknown number is removed. It can still be wrong. Not financial advice.</p>
        </>
      )}
    </Card>
  );
}
