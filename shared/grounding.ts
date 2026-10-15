/**
 * Number grounding: the AI may only quote numbers that exist in the facts it was given. Shared by the
 * worker's guardrails (worker/ai.ts) and the app, which re-checks an AI sentence against the numbers it
 * shows next to it (a nightly pick must not quote yesterday's P/E beside today's chip).
 */
const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;

export function numbersIn(text: string): number[] {
  return (text.match(NUM_RE) ?? []).map((s) => Number(s.replace(/,/g, ''))).filter(Number.isFinite);
}

/** Every number found anywhere in `facts` (JSON or text), plus rounded variants. */
export function numberSet(facts: unknown): number[] {
  const out = new Set<number>();
  const add = (n: number) => {
    for (const v of [n, Math.abs(n)]) for (const k of [1, 10, 100]) out.add(Math.round(v * k) / k);
    out.add(n);
  };
  const walk = (x: unknown) => {
    if (typeof x === 'number') add(x);
    else if (typeof x === 'string') numbersIn(x).forEach(add);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(facts);
  return [...out];
}

/** True if every number in `text` matches a known number (small integers like dates and counts are allowed). */
export function numbersGrounded(text: string, known: number[]): { ok: boolean; unknown: number[] } {
  const unknown = numbersIn(text).filter((n) => {
    if (Number.isInteger(n) && n <= 31) return false; // dates, counts
    if (Number.isInteger(n) && n >= 2020 && n <= 2035) return false; // years
    return !known.some((k) => Math.abs(k - n) <= Math.max(0.05, Math.abs(k) * 0.005));
  });
  return { ok: unknown.length === 0, unknown };
}
