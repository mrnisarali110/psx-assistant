/** The three short sections: AI, Appearance and Data. */
import { useState } from 'react';
import { dayTime } from '../../../shared/format.ts';
import { getThemePref, setThemePref, type ThemePref } from '../../lib/theme.ts';
import { RefreshLatest } from '../../components/RefreshLatest.tsx';
import { Card, Segmented, Toggle } from '../../components/ui.tsx';
import { Note, Row, RowCard, SectionPage, type SectionProps } from './controls.tsx';

export function AiSection({ data, save }: SectionProps) {
  return (
    <SectionPage title="AI">
      <RowCard>
        <Row icon="sparkles" label="AI suggestions" hint="Reads filings and suggests what to look at.">
          <Toggle label="AI suggestions" checked={!!data.settings.ai_enabled} onChange={(v) => save({ ai_enabled: v })} />
        </Row>
      </RowCard>
      <Note>Uses the Groq, Google Gemini and OpenRouter free tiers, which may use what they receive to improve their products. They get symbols, share counts and costs, never your name or email.</Note>
    </SectionPage>
  );
}

export const THEME_LABEL: Record<ThemePref, string> = { system: 'Same as this device', light: 'Light', dark: 'Dark' };

export function AppearanceSection({ theme, setTheme }: { theme: ThemePref; setTheme: (t: ThemePref) => void }) {
  return (
    <SectionPage title="Appearance">
      <Segmented label="Appearance" value={theme} onChange={(v) => { setTheme(v); setThemePref(v); }}
        options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      <Note>System follows your phone's light or dark setting.</Note>
    </SectionPage>
  );
}
export const useThemePref = () => useState<ThemePref>(getThemePref);

export function DataSection({ data, source, reload }: SectionProps) {
  const run = data.lastRun;
  return (
    <SectionPage title="Data">
      <Card className="py-0">
        {source.kind === 'demo'
          ? <p className="py-3 text-14 text-muted">Refresh latest needs an account: the demo uses saved prices from Oct 5.</p>
          : <RefreshLatest source={source} last={data.lastRefresh} reload={reload} />}
      </Card>
      <Note>
        Last market check {run ? `${dayTime(run.started_at)}${run.ok === false ? ' (PSX unavailable)' : ''}` : 'not yet'}.
        Prices are checked every half hour while PSX is open, and filings every night.
      </Note>
    </SectionPage>
  );
}
