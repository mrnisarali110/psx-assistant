/**
 * Screenshot import, client side: shrink each picture in the browser, send it once to /api/import
 * (our Cloudflare Worker reads it with AI), get holdings back. Nothing is saved anywhere.
 */
import type { ImportedRow } from '../../shared/changes.ts';

const MAX_SIDE = 1600;

async function shrink(file: File): Promise<{ mime: string; base64: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { mime: 'image/jpeg', base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

export async function readScreenshots(files: File[], accessToken: string): Promise<{ holdings: ImportedRow[]; dropped: string[] }> {
  if (!files.length) throw new Error('Pick at least one screenshot.');
  if (files.length > 4) throw new Error('Up to 4 screenshots at a time.');
  const images = await Promise.all(files.map(shrink));
  const r = await fetch('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ images }),
  });
  const body = (await r.json().catch(() => ({}))) as { holdings?: ImportedRow[]; dropped?: string[]; error?: string };
  if (!r.ok || !body.holdings) throw new Error(body.error ?? `Import failed (${r.status}).`);
  return { holdings: body.holdings, dropped: body.dropped ?? [] };
}
