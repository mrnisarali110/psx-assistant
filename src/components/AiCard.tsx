import type { AiInsight, AiSuggestion } from '../../shared/types.ts';
import { asOfLabel } from '../../shared/format.ts';
import { Card, Tag } from './ui.tsx';

const ACTION: Record<AiSuggestion['action'], { label: string; tone: 'green' | 'red' | 'amber' | 'slate' | 'teal' }> = {
  buy: { label: 'Buy', tone: 'green' }, add: { label: 'Add', tone: 'green' }, hold: { label: 'Hold', tone: 'slate' },
  trim: { label: 'Trim', tone: 'amber' }, sell: { label: 'Sell', tone: 'red' }, watch: { label: 'Watch', tone: 'teal' },
  review: { label: 'Review', tone: 'amber' },
};

export function AiCard({ insight, aiEnabled, demo, mode = 'today' }: {
  insight: AiInsight | null; aiEnabled: boolean; demo: boolean; mode?: 'today' | 'plan';
}) {
  const header = (
    <div className="flex items-center gap-2">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-100 text-sm dark:bg-violet-950" aria-hidden="true">✦</span>
      <p className="font-semibold">AI Assistant suggests</p>
    </div>
  );
  if (!insight) {
    return (
      <Card className="space-y-2">
        {header}
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {demo ? 'Sign in to get AI suggestions on your real portfolio.'
            : aiEnabled ? 'Your first AI suggestions arrive with the next scheduled run (weekdays 9:00, 12:30, 15:00, 17:00).'
            : 'AI suggestions are off. Turn them on in Settings.'}
        </p>
      </Card>
    );
  }
  if (mode === 'plan' && !insight.plan_note) return null;
  return (
    <Card className="space-y-3 ring-1 ring-violet-200 dark:ring-violet-900">
      {header}
      {mode === 'plan' ? (
        <p className="text-sm">{insight.plan_note}</p>
      ) : (
        <>
          <p className="text-base font-medium leading-snug">{insight.headline}</p>
          {insight.suggestions.length > 0 && (
            <ul className="space-y-2.5">
              {insight.suggestions.map((s, i) => (
                <li key={i} className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Tag tone={ACTION[s.action]?.tone ?? 'slate'}>{ACTION[s.action]?.label ?? s.action}</Tag>
                    {s.symbol && <span className="font-semibold">{s.symbol}</span>}
                    <span className="text-xs text-slate-500 dark:text-slate-400">{s.confidence} confidence</span>
                  </div>
                  <p className="text-sm">{s.text}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{s.why}</p>
                </li>
              ))}
            </ul>
          )}
          {insight.risks && <p className="text-xs text-amber-700 dark:text-amber-400">Risk: {insight.risks}</p>}
        </>
      )}
      <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
        AI ({insight.model ?? 'Gemini'}) · {asOfLabel(insight.created_at)} · built only from PSX data and your rules; suggestions that break
        your rules or cite unknown numbers are removed. It can still be wrong. Not financial advice.
      </p>
    </Card>
  );
}
