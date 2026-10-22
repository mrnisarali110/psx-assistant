import { useEffect, useState } from 'react';
import { config, isIOS } from '../../lib/config.ts';
import { disablePush, enablePush, pushState, type PushState } from '../../lib/push.ts';
import { Icon } from '../../components/Icon.tsx';
import { Button, ErrorNote, Toggle, inputCls } from '../../components/ui.tsx';
import { Row, RowCard, RowIcon, SectionPage, type SectionProps } from './controls.tsx';

export function AlertsSection({ data, source, reload, save }: SectionProps) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => { pushState().then(setState); }, []);
  const s = data.settings;

  async function togglePush() {
    setBusy(true);
    setError(null);
    try {
      if (state === 'on') await disablePush(source); else await enablePush(source);
      setState(await pushState());
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function linkTelegram() {
    setError(null);
    try { setCode(await source.createTelegramCode()); } catch (e) { setError((e as Error).message); }
  }
  const pushHint = {
    unsupported: 'Not supported in this browser', 'needs-install': 'Add the app to your Home Screen first',
    denied: isIOS() ? 'Blocked: iPhone Settings → Notifications → PSX Assist' : 'Blocked: site settings → Notifications → Allow', off: 'Off on this phone', on: 'On for this phone',
  };

  return (
    <SectionPage title="Alerts">
      <RowCard>
        <Row icon="bell" label="Push on this phone" hint={state ? pushHint[state] : '…'}>
          {(state === 'on' || state === 'off') && <Toggle label="Push on this phone" checked={state === 'on'} onChange={() => !busy && togglePush()} />}
        </Row>
        <Row icon="alert" label="Send me alerts" hint="Market-hours alerts (max 3 a day) and the 9 PM digest. Crash alerts always come through.">
          <Toggle label="Send me alerts" checked={s.notifications_enabled} onChange={(v) => save({ notifications_enabled: v })} />
        </Row>
        <div className="flex items-start gap-3 py-3">
          <RowIcon icon="moon" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex min-h-11 flex-col justify-center">
              <p className="text-16 font-medium">Quiet hours</p>
              <p className="text-14 text-muted">{s.quiet_hours.start} to {s.quiet_hours.end}, except crash alerts</p>
            </div>
            <div className="flex gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="text-14 text-muted">From</span>
              <input aria-label="Quiet from" type="time" className={`${inputCls} px-2`} defaultValue={s.quiet_hours.start}
                onBlur={(e) => e.target.value !== s.quiet_hours.start && save({ quiet_hours: { ...s.quiet_hours, start: e.target.value } })} />
            </label>
            <label className="min-w-0 flex-1 space-y-1">
              <span className="text-14 text-muted">Until</span>
              <input aria-label="Quiet until" type="time" className={`${inputCls} px-2`} defaultValue={s.quiet_hours.end}
                onBlur={(e) => e.target.value !== s.quiet_hours.end && save({ quiet_hours: { ...s.quiet_hours, end: e.target.value } })} />
            </label>
            </div>
          </div>
        </div>
        <Row icon="send" label="Telegram backup" hint={data.telegramLinked ? 'Linked' : 'Same alerts in Telegram'}>
          {!data.telegramLinked && !code && <Button kind="secondary" onClick={linkTelegram}>Link</Button>}
          {data.telegramLinked && <Icon name="check" className="h-5 w-5 text-brand" label="Linked" />}
        </Row>
        {code && (
          <div className="space-y-1 py-3 text-14">
            {config.telegramBot
              ? <a className="inline-flex min-h-11 items-center font-semibold text-brand underline" href={`https://t.me/${config.telegramBot}?start=${code}`} target="_blank" rel="noopener noreferrer">Open @{config.telegramBot} and tap Start</a>
              : <p>Send this code to the bot: <span className="font-mono font-bold">{code}</span></p>}
            <p className="text-muted">The code works for 15 minutes; linking finishes within about 20. <button type="button" className="min-h-11 cursor-pointer font-semibold text-brand underline" onClick={reload}>Check</button></p>
          </div>
        )}
      </RowCard>
      <ErrorNote error={error} />
    </SectionPage>
  );
}
