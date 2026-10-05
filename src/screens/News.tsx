import { useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { asOfLabel, dateLabel } from '../../shared/format.ts';
import { Card, Tag } from '../components/ui.tsx';

const KIND_TONE = { dividend: 'green', results: 'teal', board_meeting: 'amber', other: 'slate' } as const;
const KIND_LABEL = { dividend: 'Dividend', results: 'Results', board_meeting: 'Board meeting', other: 'Notice' };

export function News({ data }: ScreenProps) {
  const [tab, setTab] = useState<'news' | 'alerts'>('news');
  const [onlyKey, setOnlyKey] = useState(true);
  const mine = new Set([...data.holdings.map((h) => h.symbol), ...data.watchlist.map((w) => w.symbol)]);
  const anns = data.announcements
    .filter((a) => mine.has(a.symbol) && (!onlyKey || a.kind !== 'other'))
    .sort((a, b) => b.published_at.localeCompare(a.published_at));

  return (
    <>
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">News</h1>
        <div className="flex rounded-xl bg-slate-100 p-1 text-sm dark:bg-slate-800" role="tablist">
          {(['news', 'alerts'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 font-medium ${tab === t ? 'bg-white shadow-sm dark:bg-slate-950' : 'text-slate-500'}`}>
              {t === 'news' ? 'Announcements' : 'Alert history'}
            </button>
          ))}
        </div>
      </header>

      {tab === 'news' ? (
        <>
          <label className="flex items-center gap-2 px-1 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-teal-700" checked={onlyKey} onChange={(e) => setOnlyKey(e.target.checked)} />
            Only dividends, results and board meetings
          </label>
          <div className="space-y-2">
            {anns.map((a) => (
              <Card key={a.id}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold">{a.symbol}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">{dateLabel(a.published_at)}</span>
                </div>
                <p className="mt-1 text-sm">{a.title}</p>
                <div className="mt-2 flex items-center justify-between">
                  <Tag tone={KIND_TONE[a.kind]}>{KIND_LABEL[a.kind]}</Tag>
                  {a.pdf_url && <a href={a.pdf_url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-teal-700 dark:text-teal-400">PSX PDF ↗</a>}
                </div>
              </Card>
            ))}
            {!anns.length && <Card><p className="text-sm text-slate-500">No announcements yet for your stocks. They’re refreshed every weekday morning.</p></Card>}
          </div>
        </>
      ) : (
        <div className="space-y-2">
          {data.alerts.map((a) => (
            <Card key={a.dedupe_key}>
              <p className="text-sm">{a.message}</p>
              <div className="mt-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>{asOfLabel(a.sent_at)}</span>
                <span>{a.channel === 'none' ? 'Shown here only (daily limit or quiet hours)' : a.channel === 'both' ? 'Push + Telegram' : a.channel === 'telegram' ? 'Telegram' : 'Push'}</span>
              </div>
            </Card>
          ))}
          {!data.alerts.length && <Card><p className="text-sm text-slate-500">No alerts yet.</p></Card>}
        </div>
      )}
    </>
  );
}
