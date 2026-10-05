/**
 * Telegram linking. The app shows a one-time code and a t.me deep link; the user taps Start,
 * the bot receives "/start CODE", and this job (run every 20 minutes) links the chat.
 * Uses getUpdates polling, so no server or webhook is needed.
 */
import { telegramApi } from './notify.ts';
import type { Store } from './store.ts';

export async function processTelegramUpdates(token: string, store: Store, log: (m: string) => void = console.log) {
  const updates = (await telegramApi(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] })) as any[];
  let linked = 0;
  let maxId = -1;
  for (const u of updates) {
    maxId = Math.max(maxId, u.update_id);
    const msg = u.message;
    if (!msg?.chat?.id || typeof msg.text !== 'string') continue;
    const m = /^\/start(?:\s+([A-Za-z0-9]{8}))?\s*$/.exec(msg.text.trim()) ?? /^([A-Za-z0-9]{8})$/.exec(msg.text.trim());
    let reply: string;
    if (m?.[1]) {
      const userId = await store.consumeLinkCode(m[1]);
      if (userId) {
        await store.setTelegramChat(userId, msg.chat.id);
        linked++;
        reply = "Linked. You'll get your PSX alerts here as a backup to app notifications.";
      } else {
        reply = 'That code is wrong or expired. Open the app, Settings, Link Telegram, and try again.';
      }
    } else {
      reply = 'Hi! To get alerts here, open the PSX app, go to Settings and tap "Link Telegram".';
    }
    await telegramApi(token, 'sendMessage', { chat_id: msg.chat.id, text: reply }).catch((e) => log(`reply failed: ${e.message}`));
  }
  // Confirm everything we processed so Telegram stops resending it.
  if (maxId >= 0) await telegramApi(token, 'getUpdates', { offset: maxId + 1, timeout: 0 });
  log(`telegram: ${updates.length} updates, ${linked} linked`);
  return { updates: updates.length, linked };
}
