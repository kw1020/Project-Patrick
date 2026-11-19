import Link from "next/link";
import { prisma } from "@/lib/db";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ClipCard, type ClipView } from "@/components/ClipCard";
import { parseQa } from "@/lib/qa";
import { parseQueueParams, QUEUE_CATS, QUEUE_TABS, queueHref, queueWhere } from "@/lib/queue-filter";
import { funnelCounts, funnelLine } from "@/lib/funnel";
import { FINDER_PREFIX } from "@/lib/rank";

export const dynamic = "force-dynamic";

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ tab?: string; cat?: string; creator?: string }> }) {
  const f = parseQueueParams(await searchParams);
  const { tab, cat } = f;
  const accounts = (await prisma.account.findMany({ where: { error: null, mode: "api", disabled: false, platform: { in: ["youtube", "tiktok", "instagram"] } }, orderBy: [{ platform: "asc" }, { createdAt: "asc" }] }))
    .map((a) => ({ id: a.id, platform: a.platform, label: a.channelTitle ?? a.platform, autoPost: a.autoPost, privacy: a.privacy }));
  const autoCount = accounts.filter((a) => a.autoPost).length;
  const channels = await prisma.channel.findMany({ select: { id: true, name: true } });
  const [clips, counts, catCounts, creator, recent] = await Promise.all([
    prisma.clip.findMany({
      where: queueWhere(f),
      include: { posts: true, moment: { include: { streamer: { include: { campaign: true } } } } },
      // Best first: Judge score, then how big the moment was.
      orderBy: tab === "pending" ? [{ supremePick: "desc" }, { score: { sort: "desc", nulls: "last" } }, { moment: { spikeScore: "desc" } }] : [{ updatedAt: "desc" }],
      take: 60,
    }),
    prisma.clip.groupBy({ by: ["status"], where: queueWhere(f, "tab"), _count: true }),
    prisma.clip.groupBy({ by: ["category"], where: queueWhere(f, "cat"), _count: true }),
    f.creator ? prisma.streamer.findUnique({ where: { id: f.creator }, select: { name: true, platform: true } }) : null,
    // v1.9.8: "X found, Y kept" so Krew sees the filtering (last 24h).
    prisma.clip.findMany({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } }, select: { status: true, judgeReason: true } }),
  ]);
  const c = Object.fromEntries(counts.map((x) => [x.status, x._count])) as Record<string, number>;
  const cc: Record<string, number> = { all: catCounts.reduce((a, x) => a + x._count, 0) };
  for (const x of catCounts) if (x.category) cc[x.category] = x._count;

  const views: ClipView[] = clips.map((k) => ({
    id: k.id, status: k.status, stage: k.stage, error: k.error, title: k.title ?? "", caption: k.caption ?? "",
    duration: k.duration, score: k.score, hook: k.hookText, judgeReason: k.judgeReason, hasVideo: Boolean(k.finalPath),
    canRecut: Boolean(k.rawPath), editStyle: k.editStyle, editNote: k.editNote, layout: k.layout, version: k.updatedAt.getTime(),
    // Cut once, then removed by the retention job to save disk.
    // v1.9.4: also approved-but-never-posted after retainApprovedDays, and unreviewed clips (status "expired").
    expired: k.status === "expired" || (!k.finalPath && k.duration != null && ["rejected", "posted", "failed", "approved"].includes(k.status) && !k.stage),
    observations: k.judgeObservations, judgeFrames: k.judgeFrames, hookOk: k.judgeHookOk, payoffIn: k.judgePayoffIn, platformInfo: k.platformInfo,
    streamer: { name: k.moment.streamer.name, login: k.moment.streamer.login, platform: k.moment.streamer.platform },
    source: k.moment.source, vodOffset: k.moment.vodOffset, spikeScore: k.moment.spikeScore, sourceUrl: k.moment.sourceUrl, sourceViews: k.moment.sourceViews,
    category: k.category ?? k.moment.category,
    campaign: k.moment.streamer.campaign?.active ? (({ name, requiredText, bannedWords, maxCaptionChars }) => ({ name, requiredText, bannedWords, maxCaptionChars }))(k.moment.streamer.campaign) : null,
    posts: k.posts.map((p) => ({ platform: p.platform, accountId: p.accountId, status: p.status, url: p.url, error: p.error })), postError: k.postError,
    supreme: k.supremePick ? { rank: k.supremeRank, reason: k.supremeReason, channel: channels.find((c) => c.id === k.supremeChannelId)?.name ?? null } : null,
    qa: parseQa(k.qa),
  }));

  const pill = (on: boolean) => `rounded-md px-3 py-1 ${on ? "bg-panel font-bold" : "text-zinc-400 hover:text-white"}`;
  return (
    <div className="space-y-5">
      <AutoRefresh seconds={tab === "processing" || tab === "approved" ? 8 : 30} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black">Queue <Link href="/upload" className="ml-2 align-middle text-sm font-semibold text-emerald-300 hover:underline" data-testid="to-post-link">Ready to post → Upload</Link></h1>
          <p className="text-sm font-semibold text-zinc-300" data-testid="funnel">{funnelLine(funnelCounts(recent, FINDER_PREFIX))}</p>
          <p className="text-sm text-zinc-400">Nothing posts without your OK. {autoCount ? `Approve also sends the clip to ${autoCount} account${autoCount > 1 ? "s" : ""} (set in Settings). TikTok drafts are finished in the TikTok app.` : "Approve, then post with the account buttons, or download and post by hand."}</p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg border border-line p-1 text-sm">
          {QUEUE_TABS.map((x) => (
            <Link key={x.key} href={queueHref(f, { tab: x.key })} className={pill(tab === x.key)}>
              {x.label} <span className="text-zinc-500">{c[x.key] ?? 0}</span>
            </Link>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-line p-1 text-sm" role="tablist" aria-label="Type of clip" data-testid="cat-tabs">
          {QUEUE_CATS.map((x) => (
            <Link key={x.key} href={queueHref(f, { cat: x.key })} role="tab" aria-selected={cat === x.key} className={pill(cat === x.key)}>
              {x.label} <span className="text-zinc-500">{cc[x.key] ?? 0}</span>
            </Link>
          ))}
        </div>
        {f.creator && (
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
            <span className="min-w-0 truncate">Only <b>{creator?.name ?? "this creator"}</b>{creator?.platform === "youtube" ? " (YouTube)" : ""}</span>
            <Link href={queueHref(f, { creator: null })} className="shrink-0 text-xs text-hot hover:underline">Show everyone</Link>
          </div>
        )}
      </div>
      {views.length === 0 ? (
        <div className="card p-10 text-center text-zinc-400">
          {tab === "pending" && cat === "all" && !f.creator ? "Nothing to review yet. New clips from approved streamers show up here within a few minutes."
            : tab === "expired" ? "Nothing expired. Clips nobody reviews in time end up here (their video is deleted to save space, see Settings → Storage)." : "Nothing here."}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {views.map((v) => <ClipCard key={v.id} clip={v} accounts={accounts} />)}
        </div>
      )}
    </div>
  );
}
