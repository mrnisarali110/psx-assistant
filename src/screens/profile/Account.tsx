import { supabase } from '../../lib/data.ts';
import { Icon } from '../../components/Icon.tsx';
import { Card } from '../../components/ui.tsx';
import { Note, SectionPage, type SectionProps } from './controls.tsx';

/** The round initial used on Profile (and its summary row). */
export function Avatar({ data, source, size = 'h-14 w-14 text-20' }: Pick<SectionProps, 'data' | 'source'> & { size?: string }) {
  const letter = source.kind === 'demo' ? 'D' : (data.email ?? '?').slice(0, 1).toUpperCase();
  return <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-full bg-brand font-bold text-canvas ${size}`}>{letter}</span>;
}

export function AccountSection({ data, source, onExitDemo }: SectionProps & { onExitDemo: () => void }) {
  const demo = source.kind === 'demo';
  return (
    <SectionPage title="Account">
      <Card className="flex items-center gap-4">
        <Avatar data={data} source={source} />
        <div className="min-w-0">
          <p className="truncate text-16 font-semibold">{demo ? 'Demo account' : data.email}</p>
          <p className="text-14 text-muted">{demo ? 'Changes last until you close the app' : 'Signed in'}</p>
        </div>
      </Card>
      <Card className="py-1">
        {demo
          ? <button type="button" onClick={onExitDemo} className="flex min-h-12 w-full cursor-pointer items-center gap-3 text-16 font-semibold text-brand"><Icon name="user" />Sign in or create an account</button>
          : <button type="button" onClick={() => supabase().auth.signOut()} className="flex min-h-12 w-full cursor-pointer items-center gap-3 text-16 font-semibold text-ink"><Icon name="logout" />Sign out</button>}
      </Card>
      {!demo && <Note>Signing out keeps everything saved on your account; sign in again on any device.</Note>}
    </SectionPage>
  );
}
