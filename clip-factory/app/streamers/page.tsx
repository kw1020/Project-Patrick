import Link from "next/link";
import { prisma } from "@/lib/db";
import { Avatar } from "@/components/Avatar";
import { ago, num } from "@/lib/format";
import { AddStreamer } from "@/components/AddStreamer";
import { removeStreamer, saveStreamer } from "../actions";

export const dynamic = "force-dynamic";

export default async function StreamersPage({ searchParams }: { searchParams: Promise<{ add?: string }> }) {
  const { add } = await searchParams;
  const [approved, discovered] = await Promise.all([
    prisma.streamer.findMany({ where: { approved: true }, orderBy: [{ isLive: "desc" }, { viewers: "desc" }, { name: "asc" }], include: { _count: { select: { moments: true } } } }),
    prisma.streamer.findMany({ where: { approved: false }, orderBy: [{ isLive: "desc" }, { peakViewers: "desc" }], take: 40 }),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black">Streamers</h1>
        <p className="text-sm text-zinc-400">The Grabber only pulls from this list.</p>
      </div>
      <AddStreamer key={add} prefill={add} />

      <section className="space-y-2">
        <h2 className="font-bold">Approved ({approved.length})</h2>
        {approved.length === 0 ? <div className="card p-6 text-sm text-zinc-400">No one yet.</div> : (
          <div className="card divide-y divide-line">
            {approved.map((s) => (
              <form key={s.id} action={saveStreamer.bind(null, s.id)} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Avatar src={s.profileImage} name={s.name} size={40} />
                <div className="w-44">
                  <a href={`https://twitch.tv/${s.login}`} target="_blank" className="font-bold hover:text-hot">{s.name}</a>
                  <div className="text-xs text-zinc-400">{s.isLive ? <span className="text-red-400">● live · {num(s.viewers)}</span> : `seen ${ago(s.lastSeenAt)}`} · {s._count.moments} clips</div>
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
              <a href={`https://twitch.tv/${s.login}`} target="_blank" className="flex-1 font-semibold hover:text-hot">{s.name}</a>
              <span className="text-xs text-zinc-400">{s.isLive ? <span className="text-red-400">● live · {num(s.viewers)}</span> : `peak ${num(s.peakViewers)}`}</span>
              <Link href={`/streamers?add=${s.login}`} className="btn-ghost text-xs">Approve…</Link>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
