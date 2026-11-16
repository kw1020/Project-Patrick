// Post performance: how each post did compared with what's normal for its account.
import { prisma } from "./db";

export type PerfRow = {
  postId: string; clipId: string; platform: string; account: string; views: number; likes: number | null; postedAt: Date;
  perf: number; // views ÷ the account's median views (1 = typical, 3 = three times typical)
  streamer: string; source: string; score: number | null; hook: string | null; title: string | null;
  transcript: string | null; duration: number | null;
};

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Live posts that have views and are at least `minAgeHrs` old (young posts haven't settled). */
export async function performance(minAgeHrs = 24): Promise<PerfRow[]> {
  const posts = await prisma.post.findMany({
    where: { status: "live", views: { not: null }, postedAt: { lt: new Date(Date.now() - minAgeHrs * 3600_000) } },
    include: { account: true, clip: { include: { moment: { include: { streamer: true } } } } },
  });
  const group = (p: (typeof posts)[number]) => p.accountId ?? `manual:${p.platform}`;
  const medians = new Map<string, number>();
  for (const key of new Set(posts.map(group))) medians.set(key, median(posts.filter((p) => group(p) === key).map((p) => p.views!)));
  return posts.map((p) => {
    const med = medians.get(group(p)) || 1;
    return {
      postId: p.id, clipId: p.clipId, platform: p.platform, account: p.account?.channelTitle ?? p.platform, views: p.views!, likes: p.likes, postedAt: p.postedAt,
      perf: Math.round((p.views! / Math.max(1, med)) * 100) / 100,
      streamer: p.clip.moment.streamer.name, source: p.clip.moment.source, score: p.clip.score, hook: p.clip.hookText, title: p.clip.title,
      transcript: p.clip.transcript, duration: p.clip.duration,
    };
  });
}

export type Breakdown = { label: string; posts: number; avgPerf: number; views: number };

export function breakdown(rows: PerfRow[], keyOf: (r: PerfRow) => string | null): Breakdown[] {
  const m = new Map<string, PerfRow[]>();
  for (const r of rows) { const k = keyOf(r); if (k == null) continue; m.set(k, [...(m.get(k) ?? []), r]); }
  return [...m.entries()]
    .map(([label, rs]) => ({ label, posts: rs.length, views: rs.reduce((a, r) => a + r.views, 0), avgPerf: Math.round((rs.reduce((a, r) => a + r.perf, 0) / rs.length) * 100) / 100 }))
    .sort((a, b) => b.avgPerf - a.avgPerf);
}

export const scoreBucket = (r: PerfRow) => (r.score == null ? "Not scored" : r.score >= 8 ? "Judge 8–10" : r.score >= 6 ? "Judge 6–7.9" : "Judge under 6");
export const lengthBucket = (r: PerfRow) => (r.duration == null ? null : r.duration < 25 ? "Under 25s" : r.duration < 35 ? "25–35s" : "35s+");
export const sourceLabel = (r: PerfRow) => (r.source === "chat" ? "Chat spike" : "Twitch clip");

/** Spearman rank correlation between Judge score and performance (-1..1), or null with too few scored posts. */
export function judgeCorrelation(rows: PerfRow[]) {
  const xs = rows.filter((r) => r.score != null);
  if (xs.length < 5) return null;
  const rank = (vals: number[]) => {
    const idx = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array(vals.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r as number[];
  };
  const a = rank(xs.map((r) => r.score!)), b = rank(xs.map((r) => r.perf));
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? Math.round((num / Math.sqrt(da * db)) * 100) / 100 : null;
}
