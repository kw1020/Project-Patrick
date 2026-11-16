import type { Breakdown } from "@/lib/analytics";

/** One-series horizontal bars: "× typical views" per group. 1× is marked so above/below average reads at a glance. */
export function Bars({ title, rows, note }: { title: string; rows: Breakdown[]; note?: string }) {
  const max = Math.max(1.5, ...rows.map((r) => r.avgPerf));
  const one = (1 / max) * 100;
  return (
    <div className="card p-4">
      <div className="text-sm font-bold">{title}</div>
      {note && <div className="text-xs text-zinc-500">{note}</div>}
      {rows.length === 0 ? <div className="mt-3 text-xs text-zinc-500">Not enough posts yet.</div> : (
        <table className="mt-3 w-full text-xs">
          <caption className="sr-only">{title}: average views compared with each account&apos;s typical post</caption>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="group" title={`${r.label}: ${r.avgPerf}× typical views, ${r.posts} posts, ${r.views.toLocaleString()} views total`}>
                <th scope="row" className="w-32 truncate py-1.5 pr-3 text-left font-medium text-zinc-300">{r.label}</th>
                <td className="py-1.5">
                  <div className="relative h-5">
                    <div className="absolute inset-y-0 border-l border-zinc-600" style={{ left: `${one}%` }} aria-hidden />
                    <div className="absolute inset-y-0.5 left-0 rounded-r bg-hot group-hover:brightness-125" style={{ width: `${Math.max(1, (r.avgPerf / max) * 100)}%`, maxHeight: 24 }} />
                  </div>
                </td>
                <td className="w-24 py-1.5 pl-3 text-right tabular-nums text-zinc-200">{r.avgPerf}× <span className="text-zinc-500">· {r.posts}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && <div className="mt-2 text-[11px] text-zinc-500">Bar = average views ÷ that account&apos;s typical post. Line = 1× (typical). Number after the dot = posts.</div>}
    </div>
  );
}

/** Views over time for one post (2px line, end dot). */
export function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="text-[11px] text-zinc-600">—</span>;
  const w = 96, h = 24, max = Math.max(...points), min = Math.min(...points);
  const xy = points.map((v, i) => [(i / (points.length - 1)) * (w - 6) + 2, h - 3 - ((v - min) / Math.max(1, max - min)) * (h - 6)]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [ex, ey] = xy[xy.length - 1];
  return (
    <svg width={w} height={h} role="img" aria-label={`Views went from ${points[0]} to ${points[points.length - 1]}`}>
      <title>{points.map((p) => p.toLocaleString()).join(" → ")}</title>
      <path d={d} fill="none" stroke="#ff3d81" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={ex} cy={ey} r={4} fill="#ff3d81" stroke="#15151d" strokeWidth={2} />
    </svg>
  );
}
