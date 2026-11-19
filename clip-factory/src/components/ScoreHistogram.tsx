import { scoreHistogram, scoreSummary } from "@/lib/judge-stats";

/** v1.9.4: how the Judge's last scores spread over 1-10 (one column per whole score). */
export function ScoreHistogram({ scores, minScore }: { scores: number[]; minScore: number }) {
  const h = scoreHistogram(scores), max = Math.max(1, ...h), sum = scoreSummary(scores);
  return (
    <div className="card p-4" data-testid="score-histogram">
      <div className="text-sm font-bold">Judge scores (last {scores.length || 50} clips)</div>
      <div className="text-xs text-zinc-500">{sum ? `Average ${sum.avg}, range ${Math.round(sum.min * 10) / 10}–${Math.round(sum.max * 10) / 10}. A healthy Judge spreads out: lots of 3–5s, a few 8+.` : "No scored clips yet."}</div>
      {sum && (
        <div className="mt-3 flex h-32 items-end gap-1.5" role="img" aria-label={`Score counts: ${h.map((n, i) => `${i + 1}: ${n}`).join(", ")}`}>
          {h.map((n, i) => (
            <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${n} clip${n === 1 ? "" : "s"} scored ${i + 1}`}>
              <div className="text-[10px] tabular-nums text-zinc-400">{n || ""}</div>
              <div className={`w-full rounded-t ${i + 1 < minScore ? "bg-zinc-600" : "bg-hot"}`} style={{ height: `${(n / max) * 100}%`, minHeight: n ? 3 : 0 }} />
              <div className="text-[11px] tabular-nums text-zinc-300">{i + 1}</div>
            </div>
          ))}
        </div>
      )}
      {sum && <div className="mt-2 text-[11px] text-zinc-500">Grey = below your min score ({minScore}), set aside automatically.</div>}
    </div>
  );
}
