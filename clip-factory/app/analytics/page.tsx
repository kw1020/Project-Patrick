import Link from "next/link";
import { getSettings, prisma } from "@/lib/db";
import { breakdown, judgeCorrelation, lengthBucket, performance, scoreBucket, sourceLabel, typeLabel } from "@/lib/analytics";
import { buildLessons, MIN_POSTS_TO_LEARN } from "@/lib/learning";
import { getStatuses, soft, type AgentStatus } from "@/lib/queues";
import { ago, num } from "@/lib/format";
import { Bars, Spark } from "@/components/Bars";
import { ScoreHistogram } from "@/components/ScoreHistogram";

export const dynamic = "force-dynamic";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

const hourBucket = (d: Date) => { const h = d.getHours(); return h < 6 ? "Night (0–6)" : h < 12 ? "Morning (6–12)" : h < 18 ? "Afternoon (12–18)" : "Evening (18–24)"; };

export default async function AnalyticsPage() {
  const [rows, allPosts, settings, lessons, statuses, scored] = await Promise.all([
    performance(24),
    prisma.post.findMany({ where: { status: { in: ["live", "draft"] } }, include: { stats: { orderBy: { at: "asc" } }, account: true, clip: true }, orderBy: { postedAt: "desc" }, take: 300 }),
    getSettings(),
    buildLessons(),
    soft(getStatuses(), {} as Record<string, AgentStatus>),
    prisma.clip.findMany({ where: { score: { not: null } }, orderBy: { createdAt: "desc" }, take: 50, select: { score: true } }),
  ]);
  const live = allPosts.filter((p) => p.status === "live");
  const totalViews = live.reduce((a, p) => a + (p.views ?? 0), 0);
  const drafts = allPosts.length - live.length;
  const rho = judgeCorrelation(rows);
  const top = [...rows].sort((a, b) => b.perf - a.perf).slice(0, 5);
  const statsById = new Map(allPosts.map((p) => [p.id, p.stats.map((s) => s.views)]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-black">Analytics</h1>
          <p className="text-sm text-zinc-400">What works on your accounts. Posts count once they&apos;re a day old; each is compared with its own account&apos;s typical post.</p>
        </div>
        <div className="text-xs text-zinc-500">Stats synced {statuses.stats ? ago(statuses.stats.at) : "not yet"}{statuses.stats && !statuses.stats.ok ? ` (error: ${statuses.stats.msg})` : ""}</div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Total views" value={num(totalViews)} sub={`${live.length} live posts${drafts ? ` · ${drafts} TikTok drafts waiting` : ""}`} />
        <Tile label="Posts a day old (used for learning)" value={String(rows.length)} sub={rows.length < MIN_POSTS_TO_LEARN ? `Judge starts learning at ${MIN_POSTS_TO_LEARN}` : "Judge is learning from these"} />
        <Tile label="Best post" value={top[0] ? `${top[0].perf}×` : "—"} sub={top[0] ? `${top[0].title ?? "Untitled"} · ${top[0].account}` : "No settled posts yet"} />
        <Tile label="Does the Judge's score predict views?" value={rho == null ? "—" : String(rho)} sub={rho == null ? "Needs 5 scored posts" : rho >= 0.4 ? "Yes, fairly well" : rho >= 0.15 ? "A little" : "Not yet"} />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ScoreHistogram scores={scored.map((c) => c.score!)} minScore={settings.minScore} />
        <Bars title="By Judge score" rows={breakdown(rows, scoreBucket)} note="If 8–10 isn't on top, the Judge needs more examples (it's learning from these)." />
        <Bars title="By type" rows={breakdown(rows, typeLabel)} note="Funny moments vs gaming moments. Clips from before v1.7.2 have no type and are left out." />
        <Bars title="By how the moment was found" rows={breakdown(rows, sourceLabel)} />
        <Bars title="By streamer" rows={breakdown(rows, (r) => r.streamer).slice(0, 10)} />
        <Bars title="By account" rows={breakdown(rows, (r) => r.account)} />
        <Bars title="By length" rows={breakdown(rows, lengthBucket)} />
        <Bars title="By time posted" rows={breakdown(rows, (r) => hourBucket(r.postedAt))} note="Your computer's time zone." />
      </section>

      <section className="space-y-2">
        <h2 className="font-bold">Every post</h2>
        {allPosts.length === 0 ? <div className="card p-8 text-center text-sm text-zinc-400">Nothing posted through a connected account yet. Connect YouTube or TikTok on <Link href="/settings" className="text-hot">Settings</Link>.</div> : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr><th className="px-4 py-2 font-medium">Post</th><th className="px-2 py-2 font-medium">Account</th><th className="px-2 py-2 text-right font-medium">Judge</th><th className="px-2 py-2 text-right font-medium">Views</th><th className="px-2 py-2 text-right font-medium">vs typical</th><th className="px-4 py-2 font-medium">Trend</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {allPosts.map((p) => {
                  const perf = rows.find((r) => r.postId === p.id)?.perf;
                  return (
                    <tr key={p.id}>
                      <td className="max-w-72 truncate px-4 py-2">{p.url ? <a href={p.url} target="_blank" className="hover:text-hot">{p.clip.title}</a> : p.clip.title} <span className="text-xs text-zinc-500">· {ago(p.postedAt)}</span></td>
                      <td className="px-2 py-2 text-xs text-zinc-400">{p.account?.channelTitle ?? p.platform}{p.status === "draft" && <span className="ml-1 text-sun">draft</span>}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.clip.score ?? "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.views?.toLocaleString() ?? "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{perf != null ? `${perf}×` : <span className="text-xs text-zinc-600">under a day</span>}</td>
                      <td className="px-4 py-2"><Spark points={statsById.get(p.id) ?? []} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-bold">What the Judge is learning</h2>
        <p className="text-xs text-zinc-500">
          {!settings.judgeLearns ? "Switched off in Settings." : lessons ? `This is added to the Judge's instructions for every new clip (from ${lessons.posts} posts). It updates as views come in.` : `Nothing yet: the Judge starts learning once ${MIN_POSTS_TO_LEARN} posts are at least a day old (now ${rows.length}).`}
        </p>
        {lessons && settings.judgeLearns && <pre className="card overflow-x-auto whitespace-pre-wrap p-4 text-xs leading-relaxed text-zinc-300">{lessons.text}</pre>}
      </section>
    </div>
  );
}
