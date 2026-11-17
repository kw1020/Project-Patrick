import Link from "next/link";
import { prisma } from "@/lib/db";
import { Avatar } from "@/components/Avatar";
import { getStatuses, soft, type AgentStatus } from "@/lib/queues";
import { twitchConfigured } from "@/lib/twitch";
import { ago, liveFor, num } from "@/lib/format";
import { creatorUrl, isGta6 } from "@/lib/social";
import { AutoRefresh } from "@/components/AutoRefresh";
import { runScoutNow } from "./actions";

export const dynamic = "force-dynamic";

function Heat({ rate, avg }: { rate: number; avg: number }) {
  const ratio = avg > 0 ? rate / avg : rate > 0 ? 1 : 0;
  const pct = Math.min(100, (ratio / 3) * 100); // full bar = 3x average = spike territory
  const color = ratio >= 3 ? "bg-hot" : ratio >= 1.8 ? "bg-sun" : "bg-emerald-500";
  return (
    <div className="w-36">
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800"><div className={`h-full ${color}`} style={{ width: `${pct}%` }} /></div>
      <div className="mt-1 text-[11px] text-zinc-400">{rate.toFixed(1)} msg/s · {ratio ? `${ratio.toFixed(1)}x avg` : "warming up"}</div>
    </div>
  );
}

function AgentCard({ name, s, idle }: { name: string; s?: AgentStatus; idle?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-zinc-400">
        <span className={`h-2 w-2 rounded-full ${!s ? "bg-zinc-600" : s.ok ? "bg-emerald-400" : "bg-red-500"}`} />{name}
        <span className="ml-auto font-normal normal-case">{s ? ago(s.at) : "not run yet"}</span>
      </div>
      <div className={`mt-1 text-sm ${s && !s.ok ? "text-red-300" : "text-zinc-200"}`}>{s?.msg ?? idle ?? "Waiting for the worker…"}</div>
    </div>
  );
}

export default async function LivePage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const { all } = await searchParams;
  const [streams, statuses, counts, suggestionCount] = await Promise.all([
    prisma.streamer.findMany({ where: { platform: "twitch", isLive: true, ...(all ? {} : { approved: true }) }, orderBy: [{ viewers: "desc" }], take: 200 }),
    soft(getStatuses(), {} as Record<string, AgentStatus>),
    prisma.clip.groupBy({ by: ["status"], _count: true }),
    prisma.suggestion.count({ where: { status: "pending", streamer: { approved: false } } }),
  ]);
  const totalLive = await prisma.streamer.count({ where: { platform: "twitch", isLive: true } });
  const c = Object.fromEntries(counts.map((x) => [x.status, x._count])) as Record<string, number>;

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={15} />
      {!twitchConfigured() && (
        <div className="card border-sun/50 bg-sun/10 p-4 text-sm">
          <b className="text-sun">Twitch keys missing.</b> Make a free app at dev.twitch.tv/console/apps, then put
          <code className="mx-1 rounded bg-black/40 px-1">TWITCH_CLIENT_ID</code> and
          <code className="mx-1 rounded bg-black/40 px-1">TWITCH_CLIENT_SECRET</code> in <code>.env</code> and restart.
        </div>
      )}

      {statuses.disk && !statuses.disk.ok && (
        <div className="card border-red-500/50 bg-red-500/10 p-4 text-sm">
          <b className="text-red-300">Disk almost full.</b> {statuses.disk.msg}. Clips wait in the line until space frees up
          (old videos are cleaned up hourly) — delete files or free space on the storage disk to resume now.
          <span className="ml-1 text-xs text-zinc-400">{ago(statuses.disk.at)}</span>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <AgentCard name="Scout" s={statuses.scout} />
        <AgentCard name="Clips poller" s={statuses.clips} />
        <AgentCard name="Spike detector" s={statuses.spike} idle="Watching chat. No spikes yet." />
        <AgentCard name="YouTube scanner" s={statuses.youtube} idle="Runs every 30 min for approved YouTube channels." />
        <Link href="/streamers" className="card block px-4 py-3 hover:border-zinc-500">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-zinc-400">
            <span className={`h-2 w-2 rounded-full ${!statuses.suggest ? "bg-zinc-600" : statuses.suggest.ok ? "bg-emerald-400" : "bg-red-500"}`} />Suggestions
          </div>
          <div className={`mt-1 text-sm ${statuses.suggest && !statuses.suggest.ok ? "text-red-300" : "text-zinc-200"}`}>
            {statuses.suggest && !statuses.suggest.ok ? statuses.suggest.msg
              : `${suggestionCount} new suggestion${suggestionCount === 1 ? "" : "s"} · ${statuses.suggest ? `last scan ${ago(statuses.suggest.at)}` : "first scan ~1 min after start"}`}
          </div>
        </Link>
        <div className="card px-4 py-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-400">Production line</div>
          <div className="mt-1 text-sm">{c.processing ?? 0} in the line · <Link href="/queue" className="font-bold text-hot">{c.pending ?? 0} to review</Link></div>
          <div className="text-xs text-zinc-400">{c.approved ?? 0} approved · {c.posted ?? 0} posted · {c.rejected ?? 0} rejected · {c.failed ?? 0} failed</div>
          {statuses.judge && <div className="mt-1 truncate text-xs text-zinc-500">Judge: {statuses.judge.msg}</div>}
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-2xl font-black">Live in GTA 6</h1>
            <p className="text-sm text-zinc-400">{totalLive} streamers live right now. Only approved streamers get clipped.</p>
          </div>
          <div className="flex items-center gap-2">
          <form action={runScoutNow}><button className="btn-hot">Scan now</button></form>
          <div className="flex gap-1 rounded-lg border border-line p-1 text-sm">
            <Link href="/" className={`rounded-md px-3 py-1 ${!all ? "bg-panel font-bold" : "text-zinc-400"}`}>Approved</Link>
            <Link href="/?all=1" className={`rounded-md px-3 py-1 ${all ? "bg-panel font-bold" : "text-zinc-400"}`}>Everyone</Link>
          </div>
          </div>
        </div>

        {streams.length === 0 ? (
          <div className="card p-8 text-center text-zinc-400">
            {all ? "Nobody live yet — the Scout checks every 2 minutes." : <>No approved streamers are live. Switch to <Link className="text-hot" href="/?all=1">Everyone</Link> to find some, or add them on <Link className="text-hot" href="/streamers">Streamers</Link>.</>}
          </div>
        ) : (
          <div className="card divide-y divide-line overflow-hidden">
            {streams.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                <Avatar src={s.profileImage} name={s.name} size={44} />
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex items-center gap-2">
                    <a href={creatorUrl(s)} target="_blank" className="font-bold hover:text-hot">{s.name}</a>
                    <span className="rounded bg-red-600 px-1.5 text-[10px] font-black uppercase">Live</span>
                    <span className="text-xs text-zinc-500">{liveFor(s.liveSince)}</span>
                    {s.gameName && !isGta6(s.gameName) && <span className="rounded bg-zinc-800 px-1.5 text-[11px] font-semibold text-zinc-300">{s.gameName}</span>}
                  </div>
                  <div className="truncate text-sm text-zinc-400">{s.streamTitle}</div>
                </div>
                <div className="w-20 text-right">
                  <div className="font-bold tabular-nums">{num(s.viewers)}</div>
                  <div className="text-[11px] text-zinc-500">viewers</div>
                </div>
                {s.approved ? <Heat rate={s.chatRate} avg={s.chatAvg} /> : <div className="w-36 text-xs text-zinc-600">chat not tracked</div>}
                {s.approved ? (
                  <span className="w-28 text-center text-xs font-bold text-emerald-400">✓ Approved</span>
                ) : (
                  <Link href={`/streamers?add=${s.login}`} className="btn-ghost w-28 text-xs">Approve…</Link>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
