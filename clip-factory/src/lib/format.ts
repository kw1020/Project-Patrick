export function ago(d: Date | string | null | undefined) {
  if (!d) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export function liveFor(d: Date | null) {
  if (!d) return "";
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function num(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n);
}
/** 18200 → "18.2K", 52000 → "52K", 1250000 → "1.3M". */
export function compact(n: number) {
  const f = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${unit}`;
  if (n >= 1_000_000) return f(n / 1_000_000, "M");
  if (n >= 1000) return f(n / 1000, "K");
  return String(Math.round(n));
}
