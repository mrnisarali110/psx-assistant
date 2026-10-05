/**
 * Generate the Web Push (VAPID) key pair once.
 *   public key  -> .env as VITE_VAPID_PUBLIC_KEY (the app needs it; it is not secret)
 *   private key -> .secrets/github-secrets.txt (paste into GitHub Actions secrets, never commit)
 * Refuses to overwrite existing keys, because that would break every existing phone subscription.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import webpush from 'web-push';

const envPath = '.env';
const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
if (/^VITE_VAPID_PUBLIC_KEY=.+/m.test(env)) {
  console.log('VAPID keys already exist; not regenerating (it would invalidate subscriptions).');
  process.exit(0);
}
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
writeFileSync(envPath, env.trimEnd() + `\nVITE_VAPID_PUBLIC_KEY=${publicKey}\n`);
mkdirSync('.secrets', { recursive: true });
writeFileSync('.secrets/github-secrets.txt', [
  '# Paste each line into GitHub > repo > Settings > Secrets and variables > Actions > New repository secret.',
  '# Name = left of "=", Secret = right of "=". Delete this file once done if you like (keep a backup somewhere safe).',
  `VAPID_PUBLIC_KEY=${publicKey}`,
  `VAPID_PRIVATE_KEY=${privateKey}`,
  '',
].join('\n'));
console.log('VAPID public key written to .env; private key written to .secrets/github-secrets.txt');
