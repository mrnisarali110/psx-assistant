import { Button } from '../components/ui.tsx';

/** iPhone first run: web push only works from the Home Screen app (iOS 16.4+). */
export function Onboarding({ onSkip }: { onSkip: () => void }) {
  const steps = [
    { t: 'Open this page in Safari', d: 'Other iPhone browsers cannot install apps.' },
    { t: 'Tap Share', d: 'The square with an arrow, at the bottom of Safari.' },
    { t: 'Tap "Add to Home Screen"', d: 'Scroll the share sheet if you don’t see it, then tap Add.' },
    { t: 'Open PSX Assist from your Home Screen', d: 'Sign in there, not in Safari.' },
    { t: 'Settings → Enable notifications', d: 'iPhone only asks for permission after you tap the button.' },
  ];
  return (
    <div className="safe-top mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
      <div className="space-y-2">
        <img src="/icons/icon-192.png" alt="" className="h-14 w-14 rounded-2xl" />
        <h1 className="text-2xl font-bold">Install on your iPhone</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Alerts reach your locked phone only from the installed app. It takes 30 seconds.</p>
      </div>
      <ol className="space-y-4">
        {steps.map((s, i) => (
          <li key={s.t} className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-700 text-sm font-bold text-white">{i + 1}</span>
            <div>
              <p className="font-semibold">{s.t}</p>
              <p className="text-sm text-slate-500 dark:text-slate-400">{s.d}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-xs text-slate-500 dark:text-slate-400">Needs iOS 16.4 or later. Telegram alerts work too, as a backup.</p>
      <Button kind="secondary" onClick={onSkip}>Continue in the browser for now</Button>
    </div>
  );
}
