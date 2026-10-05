/**
 * Delivery channels: Web Push (VAPID) and a Telegram bot as backup.
 * A push subscription that the browser has expired (404/410) is deleted, and Telegram carries the alert.
 */
import webpush from 'web-push';
import type { Notification } from '../shared/signals.ts';
import type { Store, UserCtx } from './store.ts';

export type Channel = 'push' | 'telegram' | 'both' | 'none';

export interface Notifier {
  send(user: UserCtx, n: Notification): Promise<Channel>;
}

export interface NotifyEnv {
  vapidPublic?: string;
  vapidPrivate?: string;
  vapidSubject?: string;
  telegramToken?: string;
  appUrl?: string;
}

export async function telegramApi(token: string, method: string, body: unknown): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? r.status}`);
  return j.result;
}

export class RealNotifier implements Notifier {
  private pushReady: boolean;

  constructor(private env: NotifyEnv, private store: Store, private log: (m: string) => void = console.log) {
    this.pushReady = !!(env.vapidPublic && env.vapidPrivate);
    if (this.pushReady) {
      webpush.setVapidDetails(env.vapidSubject || env.appUrl || 'mailto:owner@example.invalid', env.vapidPublic!, env.vapidPrivate!);
    }
  }

  async send(user: UserCtx, n: Notification): Promise<Channel> {
    let pushed = false;
    if (this.pushReady) {
      const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.urgent ? 'crash' : 'update' });
      for (const s of user.subs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
            TTL: n.urgent ? 24 * 3600 : 6 * 3600,
            urgency: n.urgent ? 'high' : 'normal',
          });
          pushed = true;
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            this.log(`push subscription expired for user ${user.id.slice(0, 8)}, removing it`);
            await this.store.deleteSubscription(s.id);
          } else {
            this.log(`push failed for user ${user.id.slice(0, 8)}: ${e?.statusCode ?? ''} ${e?.body ?? e?.message ?? e}`);
          }
        }
      }
    }
    let telegrammed = false;
    if (this.env.telegramToken && user.telegram_chat_id) {
      const link = this.env.appUrl ? `\n${this.env.appUrl.replace(/\/$/, '')}${n.url}` : '';
      try {
        await telegramApi(this.env.telegramToken, 'sendMessage', {
          chat_id: user.telegram_chat_id,
          text: `${n.urgent ? '🚨 ' : ''}${n.title}\n${n.body}${link}`,
          disable_web_page_preview: true,
        });
        telegrammed = true;
      } catch (e) {
        this.log(`telegram failed for user ${user.id.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
    return pushed && telegrammed ? 'both' : pushed ? 'push' : telegrammed ? 'telegram' : 'none';
  }
}

/** Prints instead of sending (dry runs) and records what would have gone out (tests). */
export class ConsoleNotifier implements Notifier {
  sent: { userId: string; n: Notification }[] = [];
  constructor(private log: (m: string) => void = console.log) {}
  async send(user: UserCtx, n: Notification): Promise<Channel> {
    this.sent.push({ userId: user.id, n });
    this.log(`\n[would notify ${user.id.slice(0, 8)}${n.urgent ? ' URGENT' : ''}] ${n.title}\n${n.body}\n(opens ${n.url})`);
    return 'push';
  }
}
