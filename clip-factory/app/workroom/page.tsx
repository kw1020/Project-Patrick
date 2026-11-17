import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Avatar } from "@/components/Avatar";
import { COLUMNS, getWorkroom, stageAge, type ColumnKey, type WorkItem } from "@/lib/workroom";
import { retryClip } from "../actions";

export const dynamic = "force-dynamic";

const SOURCE_CLS: Record<string, string> = {
  twitch_clip: "bg-violet-500/20 text-violet-200",
  chat: "bg-hot/20 text-pink-200",
  youtube: "bg-red-600/20 text-red-200",
};
const COLUMN_HINT: Record<ColumnKey, string> = {
  finding: "new moments, last 10 min",
  downloading: "grabbing the video",
  captions: "writing captions",
  judge: "Claude scores it",
  cutting: "vertical + captions",
  ready: "waiting for your OK",
  posting: "uploading / drafts",
  posted: "last 24 hours",
};

function Card({ item, now, col }: { item: WorkItem; now: Date; col: ColumnKey }) {
  const scoreCls = item.score == null ? "" : item.score >= 8 ? "text-emerald-300" : item.score >= 6 ? "text-sun" : "text-red-300";
  const body = (
    <>
      <div className="flex items-center gap-2">
        <Avatar src={item.creator.avatar} name={item.creator.name} size={24} />
        <span className="min-w-0 flex-1 truncate text-xs font-bold">{item.creator.name}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-zinc-400" title="Time in this step">{stageAge(item.since, now)}</span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-xs text-zinc-300 [overflow-wrap:anywhere]">{item.title}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${SOURCE_CLS[item.source] ?? "bg-zinc-800 text-zinc-300"}`}>{item.sourceLabel}</span>
        {item.score != null && <span className={`rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-black ${scoreCls}`}>{item.score}/10</span>}
        {item.where && <span className="truncate text-[10px] text-zinc-500">{item.where}</span>}
      </div>
    </>
  );
  const cls = "block rounded-xl border border-line bg-ink p-2.5";
  if (col === "ready") return <Link href="/queue" className={`${cls} hover:border-zinc-500`}>{body}</Link>;
  if (col === "posted" && item.url) return <a href={item.url} target="_blank" className={`${cls} hover:border-zinc-500`}>{body}</a>;
  return <div className={cls}>{body}</div>;
}

export default async function WorkroomPage() {
  const now = new Date();
  const w = await getWorkroom(now);
  const s = w.summary;
  return (
    <div className="min-w-0 space-y-4">
      <AutoRefresh seconds={3} />
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-black">Workroom</h1>
          <p className="text-sm text-zinc-400">Every clip on its way through the line, live.</p>
        </div>
      </div>

      <div className="card flex flex-wrap gap-x-6 gap-y-2 px-4 py-3 text-sm">
        <span>In the line <b className="tabular-nums">{s.inLine}</b></span>
        <Link href="/queue" className="hover:text-hot">Ready for you <b className="tabular-nums text-hot">{s.ready}</b></Link>
        <span>Posted today <b className="tabular-nums">{s.postedToday}</b></span>
        <span>Clips per hour (last 3h) <b className="tabular-nums">{s.perHour}</b></span>
        {s.lineFull && <span className="font-semibold text-sun">Line full ({s.inLine}/{s.backlogMax}) — new moments wait</span>}
      </div>

      {w.problems.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-red-300">Problems ({w.problems.length})</h2>
          <div className="card divide-y divide-line border-red-500/40">
            {w.problems.map((p) => (
              <div key={p.key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <Avatar src={p.creator.avatar} name={p.creator.name} size={28} />
                <div className="min-w-0 flex-1 basis-48">
                  <div className="truncate text-sm font-bold">{p.creator.name} <span className="font-normal text-zinc-400">· {p.title}</span></div>
                  <div className="text-xs text-red-300 [overflow-wrap:anywhere]">{p.error || "Failed"} <span className="text-zinc-500">· {stageAge(p.since, now)} ago</span></div>
                </div>
                {p.clipId && <form action={retryClip.bind(null, p.clipId)}><button className="btn-ghost text-xs">Retry</button></form>}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="overflow-x-auto pb-2" data-testid="workroom-columns">
        <div className="flex w-max gap-3">
          {COLUMNS.map((c) => {
            const items = w.columns[c.key];
            return (
              <section key={c.key} className="card flex w-56 shrink-0 flex-col p-2.5">
                <div className="mb-2 px-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-black">{c.label}</h2>
                    <span className="rounded-full bg-zinc-800 px-2 text-xs font-bold tabular-nums text-zinc-300">{w.counts[c.key]}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500">{COLUMN_HINT[c.key]}</div>
                </div>
                <div className="flex flex-col gap-2">
                  {items.length === 0 ? <div className="rounded-xl border border-dashed border-line p-3 text-center text-xs text-zinc-600">Empty</div>
                    : items.map((it) => <Card key={it.key} item={it} now={now} col={c.key} />)}
                  {c.key === "ready" && w.counts.ready > items.length && <Link href="/queue" className="text-center text-xs text-hot">+{w.counts.ready - items.length} more in the Queue</Link>}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
