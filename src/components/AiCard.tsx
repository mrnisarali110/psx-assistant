import type { ReactNode } from 'react';
import type { AiInsight, AiSuggestion } from '../../shared/types.ts';
import { dayTime } from '../../shared/format.ts';
import type { BcState } from '../../shared/bluechip.ts';
import { stockHref } from '../lib/nav.ts';
import { Icon } from './Icon.tsx';
import { Card, Chip } from './ui.tsx';

/**
 * Action words are labels, not price moves: buying words in ink, selling and checking words as caution (they ask you
 * to look at a holding), hold quiet. Never red / green.
 */
const ACTION: Record<AiSuggestion['action'], { label: string; cls: string }> = {
  buy: { label: 'Buy', cls: 'bg-surface-2 text-ink' }, add: { label: 'Buy more', cls: 'bg-surface-2 text-ink' },
  watch: { label: 'Watch', cls: 'bg-surface-2 text-ink' }, hold: { label: 'Hold', cls: 'bg-surface-2 text-muted' },
  trim: { label: 'Trim', cls: 'bg-caution/10 text-caution' }, sell: { label: 'Sell', cls: 'bg-caution/10 text-caution' },
  review: { label: 'Review', cls: 'bg-caution/10 text-caution' },
};

export function AiBadge() {
  return <Chip kind="ai" />;
}

/** A link to the stock page, sized for a finger even inside a sentence. */
function SymbolLink({ symbol }: { symbol: string }) {
  return <a href={stockHref(symbol)} className="relative font-bold text-brand underline-offset-2 hover:underline after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']">{symbol}</a>;
}

/** The AI's text with every known ticker in it turned into a link to that stock's page. */
function withLinks(text: string, known: Set<string>): ReactNode[] {
  return text.split(/(\b[A-Z][A-Z0-9]{1,7}\b)/).map((part, i) => (i % 2 === 1 && known.has(part) ? <SymbolLink key={i} symbol={part} /> : part));
}

/** "AI suggests": suggestions plus the monthly cash note. Carries the AI panel's one disclaimer line. */
export function AiCard({ insight, aiEnabled, demo, bc = {} }: { insight: AiInsight | null; aiEnabled: boolean; demo: boolean; bc?: Record<string, BcState> }) {
  const known = new Set([...Object.keys(bc), ...(insight?.suggestions ?? []).flatMap((s) => (s.symbol ? [s.symbol] : []))]);
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-16 font-semibold text-ink"><Icon name="sparkles" className="h-5 w-5 text-violet-600 dark:text-violet-300" />AI suggests</p>
        {insight && <span className="text-12 text-muted">{dayTime(insight.created_at)}</span>}
      </div>
      {!insight ? (
        <p className="text-14 text-muted">
          {demo ? 'Sign in to get AI suggestions on your own portfolio.'
            : aiEnabled ? 'Suggestions arrive with the next market check (every 30 minutes while PSX is open).'
            : 'AI suggestions are off. Turn them on in Profile.'}
        </p>
      ) : (
        <>
          {insight.suggestions.length === 0 && <p className="text-14 text-ink">{withLinks(insight.headline, known)}</p>}
          <ul className="space-y-3">
            {insight.suggestions.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className={`inline-flex h-fit shrink-0 items-center whitespace-nowrap rounded-chip px-2 py-0.5 text-12 font-semibold ${ACTION[s.action]?.cls ?? 'bg-surface-2 text-muted'}`}>
                  {ACTION[s.action]?.label ?? s.action}
                </span>
                <div className="min-w-0 space-y-0.5">
                  <p className="text-14 font-medium text-ink">{s.symbol && <><SymbolLink symbol={s.symbol} /> · </>}{withLinks(s.text, known)}</p>
                  <p className="text-12 text-muted">{withLinks(s.why, known)}</p>
                  {s.symbol && (s.action === 'buy' || s.action === 'add' || s.action === 'watch') && bc[s.symbol]?.status === 'not_bc' && <Chip kind="not_bluechip" />}
                </div>
              </li>
            ))}
          </ul>
          {insight.cash_note && <p className="flex gap-2 rounded-control bg-surface-2 p-3 text-14 text-ink"><Icon name="coins" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />{withLinks(insight.cash_note, known)}</p>}
          {insight.risks && <p className="flex gap-2 text-12 text-caution"><Icon name="alert" className="h-4 w-4 shrink-0" />{withLinks(insight.risks, known)}</p>}
          <p className="text-12 leading-snug text-muted">From PSX data and your rules; anything that breaks them or quotes an unknown number is removed. It can still be wrong. Not financial advice.</p>
        </>
      )}
    </Card>
  );
}
