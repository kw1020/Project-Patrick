import Link from "next/link";
import { prisma } from "@/lib/db";
import { Avatar } from "@/components/Avatar";
import { ago, num } from "@/lib/format";
import { AddStreamer, AddYouTubeChannel } from "@/components/AddStreamer";
import { creatorUrl } from "@/lib/social";
import { SuggestionActions } from "@/components/SuggestionActions";
import { approvalReasonFromEvidence } from "@/lib/permission";
import { getStatuses, soft, type AgentStatus } from "@/lib/queues";
import { removeStreamer, saveStreamer, scanSuggestionsNow } from "../actions";

export const dynamic = "force-dynamic";

export default async function StreamersPage({ searchParams }: { searchParams: Promise<{ add?: string }> }) {
  const { add } = await searchParams;
  const [approved, discovered, suggestions, statuses] = await Promise.all([
    prisma.streamer.findMany({ where: { approved: true }, orderBy: [{ isLive: "desc" }, { viewers: "desc" }, { name: "asc" }], include: { _count: { select: { moments: true } } } }),
    prisma.streamer.findMany({ where: { approved: false, platform: "twitch" }, orderBy: [{ isLive: "desc" }, { peakViewers: "desc" }], take: 40 }),
    prisma.suggestion.findMany({ where: { status: "pending", streamer: { approved: false, platform: "twitch" } }, orderBy: { score: "desc" }, include: { streamer: true } }),
    soft(getStatuses(), {} as Record<string, AgentStatus>),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black">Streamers</h1>
        <p className="text-sm text-zinc-400">The Grabber only pulls from this list.</p>
      </div>
      <Suggestions items={suggestions} status={statuses.suggest} />
      <AddStreamer key={add} prefill={add} />
      <AddYouTubeChannel />

      <section className="space-y-2">
        <h2 className="font-bold">Approved ({approved.length})</h2>
        {approved.length === 0 ? <div className="card p-6 text-sm text-zinc-400">No one yet.</div> : (
          <div className="card divide-y divide-line">
            {approved.map((s) => (
              <form key={s.id} action={saveStreamer.bind(null, s.id)} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Avatar src={s.profileImage} name={s.name} size={40} />
                <div className="w-44">
                  <div className="flex items-center gap-1.5">
                    <a href={creatorUrl(s)} target="_blank" className="font-bold hover:text-hot">{s.name}</a>
                    {s.platform === "youtube" && <span className="rounded bg-red-600/20 px-1.5 text-[10px] font-black uppercase text-red-300">YouTube</span>}
                  </div>
                  <div className="text-xs text-zinc-400">{s.platform === "youtube" ? `@${s.login}` : s.isLive ? <span className="text-red-400">● live · {num(s.viewers)}</span> : `seen ${ago(s.lastSeenAt)}`} · {s._count.moments} clips</div>
                </div>
                <input name="note" defaultValue={s.approvalNote ?? ""} placeholder="Why approved" className="field min-w-48 flex-1" />
                <input name="facecam" defaultValue={s.facecam ?? ""} placeholder="Facecam x,y,w,h e.g. 0.72,0.04,0.26,0.3" title="Where their webcam sits, as fractions of the frame (0–1). Used when Settings → Layout is “Facecam on top”." className="field w-72" />
                <button className="btn-ghost">Save</button>
                <button formAction={removeStreamer.bind(null, s.id)} className="btn-bad">Remove</button>
              </form>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-bold">Found by the Scout, not approved</h2>
        <p className="text-xs text-zinc-500">Check their panels / Discord / clipping-campaign sites before approving.</p>
        <div className="card divide-y divide-line">
          {discovered.length === 0 && <div className="p-6 text-sm text-zinc-400">The Scout hasn&apos;t found anyone yet.</div>}
          {discovered.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <a href={creatorUrl(s)} target="_blank" className="min-w-0 flex-1 truncate font-semibold hover:text-hot">{s.name}</a>
              <span className="text-xs text-zinc-400">{s.isLive ? <span className="text-red-400">● live · {num(s.viewers)}</span> : `peak ${num(s.peakViewers)}`}</span>
              <Link href={`/streamers?add=${s.login}`} className="btn-ghost text-xs">Approve…</Link>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

type SuggestionRow = Awaited<ReturnType<typeof prisma.suggestion.findMany<{ include: { streamer: true } }>>>[number];

function parseReasons(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

function Suggestions({ items, status }: { items: SuggestionRow[]; status?: AgentStatus }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-black">Suggested for you {items.length > 0 && <span className="text-zinc-500">({items.length})</span>}</h2>
          <p className="text-xs text-zinc-400">
            Big streamers whose viewers clip a lot. Nobody is approved until you approve them with a reason.
            {status && <> · last scan {ago(status.at)}{!status.ok && <span className="text-red-300"> (failed: {status.msg})</span>}</>}
          </p>
        </div>
        <form action={scanSuggestionsNow}><button className="btn-ghost text-xs">Scan now</button></form>
      </div>
      {items.length === 0 ? (
        <div className="card p-6 text-sm text-zinc-400">
          No suggestions yet. The first scan runs about a minute after Clip Factory starts, then every hour.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((sg) => {
            const s = sg.streamer;
            const prefill = approvalReasonFromEvidence(sg);
            return (
              <div key={sg.id} className="card flex min-w-0 flex-col gap-3 p-4">
                <div className="flex items-center gap-3">
                  <Avatar src={s.profileImage} name={s.name} size={44} />
                  <div className="min-w-0 flex-1">
                    <a href={`https://www.twitch.tv/${s.login}`} target="_blank" className="block truncate font-bold hover:text-hot">{s.name}</a>
                    <div className="truncate text-xs text-zinc-400">{sg.gameName ?? s.gameName ?? "—"}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold tabular-nums">{num(sg.viewers)}</div>
                    <div className="text-[11px] text-zinc-500">viewers</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {parseReasons(sg.reasons).map((r, i) => (
                    <span key={i} className="max-w-full truncate rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">{r}</span>
                  ))}
                </div>
                {sg.evidence ? (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                    <b>Clipping allowed?</b> Their {sg.evidenceSource === "title" ? "stream title" : "bio"} says: &lsquo;{sg.evidence}&rsquo;
                  </div>
                ) : (
                  <div className="rounded-lg border border-sun/30 bg-sun/10 px-3 py-2 text-xs text-amber-200">
                    No public permission found. Check their{" "}
                    <a href={`https://www.twitch.tv/${s.login}/about`} target="_blank" className="font-bold underline hover:text-white">About panels</a>{" "}
                    or Discord before approving.
                  </div>
                )}
                <div className="mt-auto"><SuggestionActions id={sg.id} name={s.name} prefill={prefill} /></div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
