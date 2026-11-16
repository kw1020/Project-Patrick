// What the Judge learns from Krew's own results: a short evidence block added to its instructions.
import { breakdown, judgeCorrelation, lengthBucket, performance, scoreBucket, sourceLabel, type PerfRow } from "./analytics";

export const MIN_POSTS_TO_LEARN = 6;

function example(r: PerfRow) {
  const said = (r.transcript ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  return [
    `- ${r.perf}x typical views (${r.views.toLocaleString("en-US")} on ${r.account}), ${sourceLabel(r).toLowerCase()}, ${r.streamer}, ${Math.round(r.duration ?? 0)}s, you scored it ${r.score ?? "—"}`,
    `  title: ${r.title ?? "—"} | hook: ${r.hook ?? "—"}${said ? ` | said: "${said}"` : ""}`,
  ].join("\n");
}

/** Returns null until there are enough settled posts to say anything. */
export async function buildLessons(): Promise<{ text: string; posts: number } | null> {
  const rows = await performance(24);
  if (rows.length < MIN_POSTS_TO_LEARN) return null;
  const sorted = [...rows].sort((a, b) => b.perf - a.perf);
  const n = Math.min(4, Math.floor(rows.length / 2));
  const lines = [
    `Results so far from Krew's own accounts (${rows.length} posts at least a day old). "Typical" means the median views for that account, so 2x is twice its usual. Small numbers are noisy: treat this as evidence about what this audience responds to, weigh it against the clip in front of you, and don't copy titles.`,
    "",
    "Best performers:",
    ...sorted.slice(0, n).map(example),
    "",
    "Weakest performers:",
    ...sorted.slice(-n).reverse().map(example),
  ];
  const groups: string[] = [];
  for (const [name, fn] of [["Source", sourceLabel], ["Your score", scoreBucket], ["Length", lengthBucket], ["Hook on video", (r: PerfRow) => (r.hook ? "with hook" : "no hook")]] as const) {
    const b = breakdown(rows, fn).filter((g) => g.posts >= 3);
    if (b.length >= 2) groups.push(`- ${name}: ${b.map((g) => `${g.label} ${g.avgPerf}x (${g.posts} posts)`).join(", ")}`);
  }
  if (groups.length) lines.push("", "Averages by group (only groups with 3+ posts):", ...groups);
  const rho = judgeCorrelation(rows);
  if (rho != null) lines.push("", `How well your past scores predicted results: rank correlation ${rho} (1 = perfect, 0 = no relation).${rho < 0.2 ? " Your scores haven't tracked results well yet, so lean harder on the examples above." : ""}`);
  return { text: lines.join("\n"), posts: rows.length };
}
