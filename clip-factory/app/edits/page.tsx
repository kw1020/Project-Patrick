import { getSettings, prisma } from "@/lib/db";
import { AutoRefresh } from "@/components/AutoRefresh";
import { MakeEditForm } from "@/components/MakeEditForm";
import { EditCard, type EditView } from "@/components/EditCard";
import { listMusic, songTime } from "@/lib/beats";
import { channelForClip } from "@/lib/channels";
import { usableByCreator } from "../../src/workers/edit";
import { top5ThemeCounts } from "../../src/workers/top5";
import { formatLabel, themeLabel } from "@/lib/edit-vibes";

export const dynamic = "force-dynamic";

export default async function EditsPage() {
  const [settings, creators, usable, edits, channels, themeCounts] = await Promise.all([
    getSettings(),
    prisma.streamer.findMany({ where: { approved: true }, orderBy: { name: "asc" }, select: { id: true, name: true, platform: true } }),
    usableByCreator(),
    prisma.edit.findMany({ orderBy: { createdAt: "desc" }, take: 40, include: { streamer: true, posts: true } }),
    prisma.channel.findMany({ orderBy: { createdAt: "asc" } }),
    top5ThemeCounts(),
  ]);
  const songs = listMusic();
  const opts = creators.map((c) => ({ ...c, usable: usable.get(c.id) ?? 0 })).sort((a, b) => b.usable - a.usable || a.name.localeCompare(b.name));
  const editChannel = channelForClip(channels, { category: "edits" }); // v1.9.5: the channel whose types include Edits
  const views: EditView[] = edits.map((e) => {
    let slices: number | null = null;
    try { slices = JSON.parse(e.slices ?? "{}").slices?.length ?? null; } catch { /* old */ }
    let creatorsIn: { login: string; name: string; platform: string }[] = [];
    try { creatorsIn = JSON.parse(e.creators ?? "[]"); } catch { /* old */ }
    return {
      id: e.id, status: e.status, stage: e.stage, error: e.error, postError: e.postError, format: e.format, vibe: e.vibe, lengthSec: e.lengthSec,
      duration: e.duration, bpm: e.bpm, timingTrack: e.timingTrack, startAt: e.timingTrack ? songTime(e.beatOffset) : null, creatorAudio: e.creatorAudio,
      theme: e.format === "top5" ? themeLabel(e.theme) : null, creators: creatorsIn,
      title: e.title ?? (e.format === "top5" ? themeLabel(e.theme) : `${e.streamer.name} ${formatLabel(e.format).toLowerCase()}`), caption: e.caption ?? "", hasVideo: Boolean(e.finalPath), hasBeat: Boolean(e.finalWithBeatPath),
      version: e.updatedAt.getTime(), slices, streamer: { name: e.streamer.name, login: e.streamer.login, platform: e.streamer.platform },
      posts: e.posts.map((p) => ({ platform: p.platform, accountId: p.accountId, status: p.status, url: p.url, error: p.error })),
    };
  });
  const working = views.some((v) => v.status === "processing" || v.stage === "post");
  return (
    <div className="space-y-5">
      <AutoRefresh seconds={working ? 5 : 30} />
      <div>
        <h1 className="text-2xl font-black">Edits</h1>
        <p className="text-sm text-zinc-400">Top 5 countdowns of the best moments (or beat-synced edits of one creator), for your edit channel. No music is put in: add the sound in TikTok/Reels when you post. Nothing posts without your Approve; approved edits wait on the Upload page in the edit channel's column.</p>
      </div>
      <MakeEditForm creators={opts} songs={songs} defaults={{ vibe: settings.editVibe, length: settings.editLength, bpm: settings.editBpm, creatorAudio: settings.editCreatorAudio }} themeCounts={themeCounts} />
      {views.length === 0 ? (
        <div className="card p-10 text-center text-zinc-400">No edits yet. Make one above, or press &ldquo;Make an edit from this clip&rdquo; on a clip in the Queue.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {views.map((v) => <EditCard key={v.id} edit={v} channelName={editChannel?.name ?? null} />)}
        </div>
      )}
    </div>
  );
}
