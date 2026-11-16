import Link from "next/link";
import { prisma } from "@/lib/db";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ClipCard, type ClipView } from "@/components/ClipCard";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "pending", label: "To review" },
  { key: "approved", label: "Approved" },
  { key: "processing", label: "In the line" },
  { key: "rejected", label: "Rejected" },
  { key: "failed", label: "Failed" },
] as const;

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: t } = await searchParams;
  const tab = TABS.find((x) => x.key === t)?.key ?? "pending";
  const [clips, counts] = await Promise.all([
    prisma.clip.findMany({
      where: { status: tab },
      include: { moment: { include: { streamer: true } } },
      orderBy: tab === "pending" ? [{ moment: { sourceViews: "desc" } }] : [{ updatedAt: "desc" }],
      take: 60,
    }),
    prisma.clip.groupBy({ by: ["status"], _count: true }),
  ]);
  const c = Object.fromEntries(counts.map((x) => [x.status, x._count])) as Record<string, number>;

  const views: ClipView[] = clips.map((k) => ({
    id: k.id, status: k.status, stage: k.stage, error: k.error, title: k.title ?? "", caption: k.caption ?? "",
    duration: k.duration, score: k.score, transcript: k.transcript, hasVideo: Boolean(k.finalPath),
    streamer: { name: k.moment.streamer.name, login: k.moment.streamer.login },
    sourceUrl: k.moment.sourceUrl, sourceViews: k.moment.sourceViews, createdAt: k.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={tab === "processing" ? 8 : 30} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black">Queue</h1>
          <p className="text-sm text-zinc-400">Nothing posts without your OK. Approve, download, post, then hit “Posted”.</p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg border border-line p-1 text-sm">
          {TABS.map((x) => (
            <Link key={x.key} href={`/queue?tab=${x.key}`} className={`rounded-md px-3 py-1 ${tab === x.key ? "bg-panel font-bold" : "text-zinc-400 hover:text-white"}`}>
              {x.label} <span className="text-zinc-500">{c[x.key] ?? 0}</span>
            </Link>
          ))}
        </div>
      </div>
      {views.length === 0 ? (
        <div className="card p-10 text-center text-zinc-400">
          {tab === "pending" ? "Nothing to review yet. New clips from approved streamers show up here within a few minutes." : "Nothing here."}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {views.map((v) => <ClipCard key={v.id} clip={v} />)}
        </div>
      )}
    </div>
  );
}
