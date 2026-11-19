// v1.9.4: is the Judge using the whole 1-10 scale? Pure helpers for the calibration guard (src/workers/judge.ts),
// the Analytics histogram and the Live page line. No Node imports (pages use it too).

/** How many recent scores the calibration guard looks at (Redis list cf:judge:recent). */
export const CALIBRATION_WINDOW = 30;
/** Below this many scores the guard stays quiet (a handful of 6s isn't a pattern yet). */
export const CALIBRATION_MIN = 10;
/** Standard deviation under which the recent scores count as "all the same". */
export const CALIBRATION_MIN_SD = 0.8;

export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

/** The most common whole score (ties → the higher count first, then the lower score). */
export function modeScore(xs: number[]): number | null {
  if (!xs.length) return null;
  const n = new Map<number, number>();
  for (const x of xs) { const k = Math.round(x); n.set(k, (n.get(k) ?? 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/** One line for the Judge's message when its last scores barely vary, else null. `scores` newest first or any order. */
export function calibrationNudge(scores: number[], o: { window?: number; min?: number; minSd?: number } = {}): string | null {
  const recent = scores.filter((x) => Number.isFinite(x)).slice(0, o.window ?? CALIBRATION_WINDOW);
  if (recent.length < (o.min ?? CALIBRATION_MIN)) return null;
  if (stdDev(recent) >= (o.minSd ?? CALIBRATION_MIN_SD)) return null;
  return `Your recent scores have been very similar (mostly ${modeScore(recent)}). Use the full range.`;
}

/** Counts per whole score 1..10 (index 0 = score 1). Scores are rounded and clamped to 1..10. */
export function scoreHistogram(scores: number[]): number[] {
  const h = new Array(10).fill(0);
  for (const x of scores) if (Number.isFinite(x)) h[Math.min(10, Math.max(1, Math.round(x))) - 1]++;
  return h;
}

/** "last 50 clips scored avg 5.4, range 2–9", or null with no scores. */
export function scoreSummary(scores: number[]): { n: number; avg: number; min: number; max: number; text: string } | null {
  const xs = scores.filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  const avg = Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 10) / 10;
  const min = Math.min(...xs), max = Math.max(...xs);
  const f = (x: number) => String(Math.round(x * 10) / 10);
  return { n: xs.length, avg, min, max, text: `last ${xs.length} clip${xs.length === 1 ? "" : "s"} scored avg ${avg}, range ${f(min)}–${f(max)}` };
}
