import { config, isIOS, isStandalone } from './config.ts';
import type { DataSource } from './data.ts';

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

export async function pushState(): Promise<PushState> {
  if (isIOS() && !isStandalone()) return 'needs-install'; // iOS only allows web push from the Home Screen app
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Must be called from a tap (iOS requirement). */
export async function enablePush(source: DataSource): Promise<void> {
  if (!config.vapidPublicKey) throw new Error('Push is not configured (missing VAPID public key).');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. You can allow them in your phone settings.');
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerServiceWorker());
  if (!reg) throw new Error('Could not start the background service.');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey) });
  await source.savePushSubscription(sub.toJSON());
}

export async function disablePush(source: DataSource): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await source.deletePushSubscription(sub.endpoint);
    await sub.unsubscribe();
  }
}

/** Re-save the current subscription on app open, in case the database lost it (or it rotated). */
export async function resyncPush(source: DataSource): Promise<void> {
  if (source.kind !== 'live' || !('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await source.savePushSubscription(sub.toJSON()).catch(() => {});
}
