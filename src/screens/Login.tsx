import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/data.ts';
import { Button, ErrorNote, Field, inputCls } from '../components/ui.tsx';
import { LogoMark } from '../components/Splash.tsx';

/** Text links stay 44px tall so they are easy to tap. */
const linkCls = 'min-h-11 cursor-pointer px-2 font-semibold text-brand underline underline-offset-2';
const quietLinkCls = 'min-h-11 cursor-pointer px-2 text-muted underline underline-offset-2';

export function Login({ onDemo }: { onDemo: () => void }) {
  const [mode, setMode] = useState<'in' | 'up' | 'reset'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const auth = supabase().auth;
      if (mode === 'in') {
        const { error } = await auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === 'up') {
        const { data, error } = await auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
        if (error) throw error;
        if (!data.session) setInfo('Check your email and tap the confirmation link, then sign in here.');
      } else {
        const { error } = await auth.resetPasswordForEmail(email, { redirectTo: location.origin });
        if (error) throw error;
        setInfo('If that email has an account, a reset link is on its way.');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="safe-top mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
      <div className="space-y-2 text-center">
        <LogoMark className="mx-auto h-16 w-16" />
        <h1 className="text-28 font-bold tracking-tight">PSX Assist</h1>
        <p className="text-14 text-muted">Buy, hold or wait, in five seconds. You place the trades.</p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <input className={inputCls} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {mode !== 'reset' && (
          <Field label="Password" hint={mode === 'up' ? 'At least 8 characters.' : undefined}>
            <input className={inputCls} type="password" autoComplete={mode === 'up' ? 'new-password' : 'current-password'} required minLength={mode === 'up' ? 8 : undefined}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        <ErrorNote error={error} />
        {info && <p className="rounded-control bg-brand/10 p-3 text-14 text-ink">{info}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create free account' : 'Send reset link'}
        </Button>
      </form>
      <div className="flex flex-col items-center gap-1 text-14">
        {mode !== 'in' && <button type="button" className={linkCls} onClick={() => setMode('in')}>I have an account</button>}
        {mode !== 'up' && <button type="button" className={linkCls} onClick={() => setMode('up')}>Create a free account</button>}
        {mode !== 'reset' && <button type="button" className={quietLinkCls} onClick={() => setMode('reset')}>Forgot password</button>}
        <button type="button" className={`mt-2 ${quietLinkCls}`} onClick={onDemo}>Try the demo without an account</button>
      </div>
    </div>
  );
}

export function NewPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase().auth.updateUser({ password });
    setBusy(false);
    if (error) setError(error.message);
    else onDone();
  }
  return (
    <form onSubmit={submit} className="safe-top mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-20 font-bold">Choose a new password</h1>
      <Field label="New password" hint="At least 8 characters.">
        <input className={inputCls} type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      <Button type="submit" disabled={busy}>Save password</Button>
    </form>
  );
}
