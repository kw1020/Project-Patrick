import Link from "next/link";
import { prisma } from "@/lib/db";
import { ago } from "@/lib/format";
import { PLATFORM_LABEL, POST_PLATFORMS } from "@/lib/channels";
import { youtubeIdFromUrl } from "@/lib/youtube";
import { updatePost } from "../actions";

export const dynamic = "force-dynamic";
const LABEL: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube Shorts", instagram: "Reels" };

type Q = { campaign?: string; channel?: string; platform?: string };

export default async function PostedPage({ searchParams }: { searchParams: Promise<Q> }) {
  const sp = await searchParams;
  const [campaigns, channels] = await Promise.all([
    prisma.campaign.findMany({ orderBy: [{ active: "desc" }, { createdAt: "asc" }], select: { id: true, name: true } }),
    prisma.channel.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  // v1.9.1: ?campaign=<id> | none | all. v1.9.5: ?channel=<id> | none, ?platform=youtube|tiktok|instagram.
  const filter = sp.campaign === "none" ? "none" : sp.campaign && campaigns.some((c) => c.id === sp.campaign) ? sp.campaign : "all";
  const chan = sp.channel === "none" ? "none" : sp.channel && channels.some((c) => c.id === sp.channel) ? sp.channel : "all";
  const plat = (POST_PLATFORMS as readonly string[]).includes(sp.platform ?? "") ? sp.platform! : "all";
  const where = {
    ...(filter === "all" ? {} : filter === "none" ? { campaignId: null } : { campaignId: filter }),
    ...(chan === "all" ? {} : chan === "none" ? { channelId: null } : { channelId: chan }),
    ...(plat === "all" ? {} : { platform: plat }),
  };
  const posts = await prisma.post.findMany({ where, include: { account: true, clip: { include: { moment: { include: { streamer: true } } } } }, orderBy: { postedAt: "desc" }, take: 300 });
  const total = posts.reduce((a, p) => a + (p.views ?? 0), 0);
  const campaignName = (id: string | null) => campaigns.find((c) => c.id === id)?.name;
  const channelName = (id: string | null) => (id ? channels.find((c) => c.id === id)?.name ?? "(deleted channel)" : "No channel");
  const ytKey = Boolean(process.env.YOUTUBE_API_KEY);
  const pill = (on: boolean) => `whitespace-nowrap rounded-md px-3 py-1 ${on ? "bg-panel font-bold" : "text-zinc-400 hover:text-white"}`;
  const href = (o: Partial<Q>) => {
    const q = new URLSearchParams();
    const v = { campaign: filter, channel: chan, platform: plat, ...o };
    for (const [k, x] of Object.entries(v)) if (x && x !== "all") q.set(k, x);
    const s = q.toString();
    return s ? `/posted?${s}` : "/posted";
  };
  // Grouped by channel (in channel order, then posts with no channel).
  const groups = [...channels.map((c) => c.id), null].map((id) => ({ id, posts: posts.filter((p) => (p.channelId ?? null) === id || (id === null && p.channelId && !channels.some((c) => c.id === p.channelId))) })).filter((g) => g.posts.length);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-black">Posted</h1>
          <p className="text-sm text-zinc-400">What went out and where. Connected accounts update their views every 15 minutes{ytKey ? ", and so do YouTube posts you made by hand (from the post link)" : ""}. TikTok and Instagram posts you made by hand: type the views in.</p>
        </div>
        <div className="card px-4 py-2 text-right"><div className="text-xl font-black">{total.toLocaleString()}</div><div className="text-xs text-zinc-400">total views · {posts.length} posts</div></div>
      </div>
      <div className="flex flex-wrap gap-2">
        {channels.length > 0 && (
          <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-line p-1 text-sm" role="tablist" aria-label="Channel" data-testid="posted-channel-filter">
            <Link href={href({ channel: "all" })} role="tab" aria-selected={chan === "all"} className={pill(chan === "all")}>All channels</Link>
            {channels.map((c) => <Link key={c.id} href={href({ channel: c.id })} role="tab" aria-selected={chan === c.id} className={pill(chan === c.id)}>{c.name}</Link>)}
            <Link href={href({ channel: "none" })} role="tab" aria-selected={chan === "none"} className={pill(chan === "none")}>No channel</Link>
          </div>
        )}
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-line p-1 text-sm" role="tablist" aria-label="Platform" data-testid="posted-platform-filter">
          <Link href={href({ platform: "all" })} role="tab" aria-selected={plat === "all"} className={pill(plat === "all")}>All</Link>
          {POST_PLATFORMS.map((p) => <Link key={p} href={href({ platform: p })} role="tab" aria-selected={plat === p} className={pill(plat === p)}>{PLATFORM_LABEL[p]}</Link>)}
        </div>
      </div>
      {campaigns.length > 0 && (
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-line p-1 text-sm" role="tablist" aria-label="Campaign" data-testid="posted-campaign-filter">
          <Link href={href({ campaign: "all" })} role="tab" aria-selected={filter === "all"} className={pill(filter === "all")}>All</Link>
          {campaigns.map((c) => <Link key={c.id} href={href({ campaign: c.id })} role="tab" aria-selected={filter === c.id} className={pill(filter === c.id)}>{c.name}</Link>)}
          <Link href={href({ campaign: "none" })} role="tab" aria-selected={filter === "none"} className={pill(filter === "none")}>No campaign</Link>
        </div>
      )}
      {posts.length === 0 ? <div className="card p-10 text-center text-zinc-400">{filter === "all" && chan === "all" && plat === "all" ? "Nothing posted yet." : "Nothing posted here yet."}</div> : groups.map((g) => (
        <section key={g.id ?? "none"} className="space-y-2">
          <h2 className="font-bold">{channelName(g.id)} <span className="text-sm font-normal text-zinc-500">· {g.posts.length} posts · {g.posts.reduce((a, p) => a + (p.views ?? 0), 0).toLocaleString()} views</span></h2>
          <div className="card divide-y divide-line">
            {g.posts.map((p) => {
              const byHand = !p.account || p.account.mode === "manual";
              const autoYt = byHand && ytKey && Boolean(youtubeIdFromUrl(p.url));
              return (
                <form key={p.id} action={updatePost.bind(null, p.id)} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-60">
                    <div className="truncate font-semibold">{p.clip.title}</div>
                    <div className="text-xs text-zinc-400 [overflow-wrap:anywhere]">{p.clip.moment.streamer.name} · {LABEL[p.platform] ?? p.platform}{p.account ? ` (${p.account.handle ?? p.account.channelTitle})` : ""} · {ago(p.postedAt)}{p.status === "draft" ? " · draft waiting in TikTok" : p.status === "processing" ? " · Instagram is still posting it" : p.status === "failed" ? ` · failed: ${p.error}` : ""}{p.likes != null ? ` · ${p.likes.toLocaleString()} likes` : ""}</div>
                  </div>
                  <input name="url" defaultValue={p.url ?? ""} placeholder="Post link" className="field w-64 min-w-0 max-w-full" />
                  {p.url && <a href={p.url} target="_blank" className="text-xs text-hot">open ↗</a>}
                  {byHand && !autoYt
                    ? <input name="views" defaultValue={p.views ?? ""} placeholder="Views" inputMode="numeric" className="field w-28 text-right" aria-label="Views (typed in)" />
                    : <span className="w-28 text-right text-sm tabular-nums" title={autoYt ? "Read from the YouTube link every 15 minutes" : "Synced from the account every 15 minutes"}>{p.views != null ? p.views.toLocaleString() : "—"} <span className="text-[10px] text-zinc-500">views · auto</span></span>}
                  {campaigns.length > 0 && (
                    <select name="campaignId" defaultValue={p.campaignId ?? ""} aria-label="Campaign" className="field w-44 py-1.5 text-sm">
                      <option value="">No campaign</option>
                      {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      {p.campaignId && !campaignName(p.campaignId) && <option value={p.campaignId}>(deleted campaign)</option>}
                    </select>
                  )}
                  <input name="campaignLink" defaultValue={p.campaignLink ?? ""} placeholder="Campaign link (where you submitted it on Whop)" className="field w-72 min-w-0 max-w-full" data-testid="post-campaign-link" />
                  {p.campaignLink && <a href={p.campaignLink} target="_blank" className="text-xs text-hot">Whop ↗</a>}
                  <button className="btn-ghost">Save</button>
                </form>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
