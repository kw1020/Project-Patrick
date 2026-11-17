import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { CreatorActions } from "@/components/CreatorActions";
import { ago, compact } from "@/lib/format";
import { creatorUrl } from "@/lib/social";
import { CREATOR_FILTERS, getCreators, parseCreatorFilter, summaryLine, type CreatorFilter, type CreatorRow } from "@/lib/creators";

export const dynamic = "force-dynamic";

const href = (q: string, f: CreatorFilter) => {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (f !== "all") p.set("f", f);
  const s = p.toString();
  return s ? `/creators?${s}` : "/creators";
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-ink px-2 py-1.5">
      <div className="truncate text-[11px] text-zinc-500">{label}</div>
      <div className="text-sm font-bold tabular-nums">{value}</div>
    </div>
  );
}

function Card({ c }: { c: CreatorRow }) {
  const yt = c.platform === "youtube";
  const url = creatorUrl(c);
  return (
    <article className={`card flex min-w-0 flex-col gap-3 p-4 ${c.paused ? "opacity-75" : ""}`} data-testid="creator-card">
      <div className="flex min-w-0 items-start gap-3">
        <div className="relative shrink-0">
          <Avatar src={c.avatar} name={c.name} size={48} />
          {c.live && <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-panel bg-red-500" title="Live now" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <a href={url} target="_blank" className="min-w-0 truncate font-bold hover:text-hot">{c.name}</a>
            <span className={`shrink-0 rounded px-1.5 text-[10px] font-black uppercase ${yt ? "bg-red-600/20 text-red-300" : "bg-violet-500/20 text-violet-200"}`}>{yt ? "YouTube" : "Twitch"}</span>
            {c.paused && <span className="shrink-0 rounded bg-sun/15 px-1.5 text-[10px] font-black uppercase text-sun">Paused</span>}
          </div>
          <div className="truncate text-xs text-zinc-400">
            {c.live ? <span className="text-red-400">● Live{c.gameName ? ` · ${c.gameName}` : ""} · {compact(c.viewers)} watching</span> : yt ? `youtube.com/@${c.login}` : `twitch.tv/${c.login}`}
          </div>
        </div>
      </div>

      <div className="text-xs text-zinc-500 [overflow-wrap:anywhere]">
        Approved {ago(c.approvedAt)}{c.approvalNote ? <> · <span className="text-zinc-400">&ldquo;{c.approvalNote}&rdquo;</span></> : null}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Moments found" value={compact(c.moments)} />
        <Stat label="Clips made" value={compact(c.clips)} />
        <Stat label="You approved" value={compact(c.approved)} />
        <Stat label="Posted" value={compact(c.posted)} />
        <Stat label="Views" value={compact(c.views)} />
        <Stat label="Last clip" value={c.lastClipAt ? ago(c.lastClipAt) : "none yet"} />
      </div>

      <div className="mt-auto flex flex-wrap gap-2">
        <a href={url} target="_blank" className="btn-ghost px-2.5 py-1 text-xs">Open channel ↗</a>
        <Link href={`/queue?creator=${c.id}`} className="btn-ghost px-2.5 py-1 text-xs">See clips</Link>
        <CreatorActions id={c.id} name={c.name} paused={c.paused} />
      </div>
    </article>
  );
}

export default async function CreatorsPage({ searchParams }: { searchParams: Promise<{ q?: string; f?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 60);
  const f = parseCreatorFilter(sp.f);
  const { summary, creators } = await getCreators({ q, filter: f });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black">Creators</h1>
          <p className="text-sm text-zinc-400" data-testid="creators-summary">{summaryLine(summary)}</p>
        </div>
        <Link href="/streamers" className="btn-ghost text-xs">+ Add creators</Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form action="/creators" className="flex min-w-0 flex-1 basis-60 gap-2">
          {f !== "all" && <input type="hidden" name="f" value={f} />}
          <input name="q" defaultValue={q} placeholder="Search by name" aria-label="Search creators by name" className="field min-w-0" />
          <button className="btn-ghost shrink-0">Search</button>
        </form>
        <div className="flex flex-wrap gap-1 rounded-lg border border-line p-1 text-sm" role="tablist" aria-label="Show">
          {CREATOR_FILTERS.map((x) => {
            const n = x.key === "all" ? summary.total : x.key === "live" ? summary.live : summary[x.key];
            return (
              <Link key={x.key} href={href(q, x.key)} role="tab" aria-selected={f === x.key}
                className={`rounded-md px-3 py-1 ${f === x.key ? "bg-panel font-bold" : "text-zinc-400 hover:text-white"}`}>
                {x.label} <span className="text-zinc-500">{n}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {summary.total === 0 ? (
        <div className="card p-10 text-center text-sm text-zinc-400">
          No approved creators yet. Add some on <Link href="/streamers" className="text-hot">Streamers</Link>.
        </div>
      ) : creators.length === 0 ? (
        <div className="card p-8 text-center text-sm text-zinc-400">
          Nobody matches{q ? <> &ldquo;{q}&rdquo;</> : null}. <Link href="/creators" className="text-hot">Show everyone</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {creators.map((c) => <Card key={c.id} c={c} />)}
        </div>
      )}
      <p className="text-xs text-zinc-500">Pause stops new clips from a creator but keeps them approved. Remove takes them off the approved list (clips already made stay).</p>
    </div>
  );
}
