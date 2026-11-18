import Link from "next/link";
import { prisma } from "@/lib/db";
import { Avatar } from "@/components/Avatar";
import { ago, compact, num } from "@/lib/format";
import { AddStreamer, AddYouTubeChannel } from "@/components/AddStreamer";
import { creatorUrl } from "@/lib/social";
import { SuggestionActions } from "@/components/SuggestionActions";
import { getStatuses, soft, type AgentStatus } from "@/lib/queues";
import { approveStreamer, removeStreamer, resetFacecamAuto, saveStreamer, scanSuggestionsNow } from "../actions";
import { BulkAddCreators } from "@/components/BulkAddCreators";

export const dynamic = "force-dynamic";

export default async function StreamersPage({ searchParams }: { searchParams: Promise<{ add?: string; sg?: string }> }) {
  const { add, sg } = await searchParams;
  const [approved, discovered, twitchSuggestions, ytSuggestions, statuses] = await Promise.all([
    prisma.streamer.findMany({ where: { approved: true }, orderBy: [{ isLive: "desc" }, { viewers: "desc" }, { name: "asc" }], include: { _count: { select: { moments: true } } } }),
    prisma.streamer.findMany({ where: { approved: false, platform: "twitch" }, orderBy: [{ isLive: "desc" }, { peakViewers: "desc" }], take: 40 }),
    prisma.suggestion.findMany({ where: { status: "pending", platform: "twitch", streamer: { approved: false, platform: "twitch" } }, orderBy: { score: "desc" }, include: { streamer: true } }),
    prisma.suggestion.findMany({ where: { status: "pending", platform: "youtube", streamer: { approved: false, platform: "youtube" } }, orderBy: { score: "desc" }, include: { streamer: true } }),
    soft(getStatuses(), {} as Record<string, AgentStatus>),
  ]);
  const tab: "twitch" | "youtube" = sg === "youtube" ? "youtube" : "twitch";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black">Streamers</h1>
        <p className="text-sm text-zinc-400">The Grabber only pulls from this list.</p>
      </div>
      <Suggestions tab={tab} twitch={twitchSuggestions} youtube={ytSuggestions}
        twitchStatus={statuses.suggest_twitch ?? statuses.suggest} youtubeStatus={statuses.suggest_youtube} hasYouTubeKey={Boolean(process.env.YOUTUBE_API_KEY)} />
      <BulkAddCreators />
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
                    {s.paused && <span title="Paused on the Creators page: no new clips" className="rounded bg-sun/15 px-1.5 text-[10px] font-black uppercase text-sun">Paused</span>}
                  </div>
                  <div className="text-xs text-zinc-400">{s.platform === "youtube" ? `@${s.login}` : s.isLive ? <span className="text-red-400">● live · {num(s.viewers)}</span> : `seen ${ago(s.lastSeenAt)}`} · {s._count.moments} clips</div>
                </div>
                <input name="note" defaultValue={s.approvalNote ?? ""} placeholder="Note (optional)" className="field min-w-48 flex-1" />
                <input name="facecam" defaultValue={s.facecam ?? ""} placeholder={s.facecamAuto ? `Webcam (found: ${s.facecamAuto})` : "Webcam x,y,w,h (optional, found automatically)"} title="Where their webcam sits, as fractions of the frame (0–1): x,y,width,height. Leave empty and Clip Factory finds it by itself. A box typed here always wins." className="field w-72" />
                {s.facecamAuto && !s.facecam && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-300" data-testid="facecam-auto">
                    webcam spot found automatically
                    <button formAction={resetFacecamAuto.bind(null, s.id)} className="btn-ghost px-2 py-0.5 text-xs" title="Forget it; the next clip looks for the webcam again">reset</button>
                  </span>
                )}
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
              <form action={approveStreamer.bind(null, s.id)}><button className="btn-ghost text-xs">Approve</button></form>
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

function Suggestions({ tab, twitch, youtube, twitchStatus, youtubeStatus, hasYouTubeKey }: {
  tab: "twitch" | "youtube"; twitch: SuggestionRow[]; youtube: SuggestionRow[];
  twitchStatus?: AgentStatus; youtubeStatus?: AgentStatus; hasYouTubeKey: boolean;
}) {
  const items = tab === "youtube" ? youtube : twitch;
  const status = tab === "youtube" ? youtubeStatus : twitchStatus;
  // YouTube's line is worth showing even when "ok" if it's a note (quota used up, key rejected…), not a count.
  const note = status && (!status.ok || (tab === "youtube" && !/^\d+ suggestions/.test(status.msg))) ? status.msg : null;
  const tabCls = (on: boolean) => `rounded-lg px-3 py-1.5 text-sm font-semibold transition ${on ? "bg-panel text-white border border-line" : "text-zinc-400 hover:text-white"}`;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-black">Suggested for you {twitch.length + youtube.length > 0 && <span className="text-zinc-500">({twitch.length + youtube.length})</span>}</h2>
          <p className="text-xs text-zinc-400">
            {tab === "youtube" ? "Big YouTube channels trending right now." : "Big streamers whose viewers clip a lot."} Nobody is approved until you press Approve.
            {status && <> · last scan {ago(status.at)}</>}
            {note && <span className={status?.ok ? "text-amber-200" : "text-red-300"}> ({status?.ok ? note : `failed: ${note}`})</span>}
          </p>
        </div>
        <form action={scanSuggestionsNow}><button className="btn-ghost text-xs">Scan now</button></form>
      </div>
      <div className="flex gap-1" role="tablist">
        <Link href="/streamers" scroll={false} role="tab" aria-selected={tab === "twitch"} className={tabCls(tab === "twitch")}>
          Twitch <span className="text-zinc-500">({twitch.length})</span>
        </Link>
        <Link href="/streamers?sg=youtube" scroll={false} role="tab" aria-selected={tab === "youtube"} className={tabCls(tab === "youtube")}>
          YouTube <span className="text-zinc-500">({youtube.length})</span>
        </Link>
      </div>
      {tab === "youtube" && !hasYouTubeKey ? <YouTubeKeySetup /> : items.length === 0 ? (
        <div className="card p-6 text-sm text-zinc-400">
          No suggestions yet. The first scan runs about a minute after Clip Factory starts, then every hour.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((sg) => tab === "youtube" ? <YouTubeCard key={sg.id} sg={sg} /> : <TwitchCard key={sg.id} sg={sg} />)}
        </div>
      )}
    </section>
  );
}

function Chips({ reasons }: { reasons: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {parseReasons(reasons).map((r, i) => (
        <span key={i} className="max-w-full truncate rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">{r}</span>
      ))}
    </div>
  );
}

function Permission({ sg, aboutUrl, aboutLabel, where }: { sg: SuggestionRow; aboutUrl: string; aboutLabel: string; where: string }) {
  const src = sg.evidenceSource === "title" ? "stream title" : sg.evidenceSource === "description" ? "channel description" : "bio";
  return sg.evidence ? (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 [overflow-wrap:anywhere]">
      <b>Clipping allowed?</b> Their {src} says: &lsquo;{sg.evidence}&rsquo;
    </div>
  ) : (
    <div className="rounded-lg border border-sun/30 bg-sun/10 px-3 py-2 text-xs text-amber-200">
      No public permission found. Check their{" "}
      <a href={aboutUrl} target="_blank" className="font-bold underline hover:text-white">{aboutLabel}</a>{" "}
      {where} before approving.
    </div>
  );
}

function TwitchCard({ sg }: { sg: SuggestionRow }) {
  const s = sg.streamer;
  return (
    <div className="card flex min-w-0 flex-col gap-3 p-4">
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
      <Chips reasons={sg.reasons} />
      <Permission sg={sg} aboutUrl={`https://www.twitch.tv/${s.login}/about`} aboutLabel="About panels" where="or Discord" />
      <div className="mt-auto"><SuggestionActions id={sg.id} name={s.name} /></div>
    </div>
  );
}

function YouTubeCard({ sg }: { sg: SuggestionRow }) {
  const s = sg.streamer;
  return (
    <div className="card flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <Avatar src={s.profileImage} name={s.name} size={44} />
        <div className="min-w-0 flex-1">
          <a href={creatorUrl(s)} target="_blank" className="block truncate font-bold hover:text-hot">{s.name}</a>
          <div className="truncate text-xs text-zinc-400">@{s.login}</div>
        </div>
        <div className="text-right">
          <div className="font-bold tabular-nums">{sg.subscribers == null ? "hidden" : compact(sg.subscribers)}</div>
          <div className="text-[11px] text-zinc-500">subscribers</div>
        </div>
      </div>
      {sg.videoTitle && (
        <div className="min-w-0 text-xs text-zinc-300">
          <span className="text-zinc-500">Trending: </span>
          {sg.videoId
            ? <a href={`https://www.youtube.com/watch?v=${sg.videoId}`} target="_blank" className="font-semibold [overflow-wrap:anywhere] hover:text-hot">{sg.videoTitle}</a>
            : <span className="font-semibold [overflow-wrap:anywhere]">{sg.videoTitle}</span>}
          {sg.videoViews != null && <span className="text-zinc-500"> · {compact(sg.videoViews)} views</span>}
        </div>
      )}
      <Chips reasons={sg.reasons} />
      <Permission sg={sg} aboutUrl={`https://www.youtube.com/@${s.login}/about`} aboutLabel="channel About page" where="(links, business email) or their clipping-campaign page" />
      <div className="mt-auto"><SuggestionActions id={sg.id} name={s.name} /></div>
    </div>
  );
}

function YouTubeKeySetup() {
  return (
    <div className="card space-y-3 p-5 text-sm">
      <div className="font-bold">Add a free YouTube API key to get YouTube suggestions</div>
      <ol className="list-decimal space-y-1 pl-5 text-zinc-300 [overflow-wrap:anywhere]">
        <li>Open <a href="https://console.cloud.google.com" target="_blank" className="font-semibold underline hover:text-white">console.cloud.google.com</a> and create or select a project.</li>
        <li>APIs &amp; Services → Library → search <b>YouTube Data API v3</b> → <b>Enable</b>.</li>
        <li>APIs &amp; Services → Credentials → <b>Create credentials</b> → <b>API key</b>.</li>
        <li>(Optional) <b>Restrict key</b> → API restrictions → YouTube Data API v3 → Save.</li>
        <li>Copy the key into <code className="rounded bg-zinc-800 px-1">.env</code> as <code className="rounded bg-zinc-800 px-1">YOUTUBE_API_KEY=your-key</code></li>
        <li>Restart Clip Factory (Stop, then open it again).</li>
      </ol>
      <p className="text-xs text-zinc-500">Free: each hourly scan uses about 6 of the 10,000 daily quota units. Twitch suggestions work without it.</p>
    </div>
  );
}
