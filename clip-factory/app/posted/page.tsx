import Link from "next/link";
import { prisma } from "@/lib/db";
import { ago } from "@/lib/format";
import { updatePost } from "../actions";

export const dynamic = "force-dynamic";
const LABEL: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube Shorts", instagram: "Reels" };

export default async function PostedPage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  const { campaign: cf } = await searchParams;
  const campaigns = await prisma.campaign.findMany({ orderBy: [{ active: "desc" }, { createdAt: "asc" }], select: { id: true, name: true } });
  // v1.9.1: ?campaign=<id> | none (posts without a campaign) | all (default).
  const filter = cf === "none" ? "none" : cf && campaigns.some((c) => c.id === cf) ? cf : "all";
  const where = filter === "all" ? {} : filter === "none" ? { campaignId: null } : { campaignId: filter };
  const posts = await prisma.post.findMany({ where, include: { account: true, clip: { include: { moment: { include: { streamer: true } } } } }, orderBy: { postedAt: "desc" }, take: 200 });
  const total = posts.reduce((a, p) => a + (p.views ?? 0), 0);
  const campaignName = (id: string | null) => campaigns.find((c) => c.id === id)?.name;
  const pill = (on: boolean) => `rounded-md px-3 py-1 ${on ? "bg-panel font-bold" : "text-zinc-400 hover:text-white"}`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-black">Posted</h1>
          <p className="text-sm text-zinc-400">What went out and where. Views from connected accounts update every 15 minutes. Type in views for posts you made by hand.</p>
        </div>
        <div className="card px-4 py-2 text-right"><div className="text-xl font-black">{total.toLocaleString()}</div><div className="text-xs text-zinc-400">total views · {posts.length} posts</div></div>
      </div>
      {campaigns.length > 0 && (
        <div className="flex flex-wrap gap-1 rounded-lg border border-line p-1 text-sm" role="tablist" aria-label="Campaign" data-testid="posted-campaign-filter">
          <Link href="/posted" role="tab" aria-selected={filter === "all"} className={pill(filter === "all")}>All</Link>
          {campaigns.map((c) => <Link key={c.id} href={`/posted?campaign=${c.id}`} role="tab" aria-selected={filter === c.id} className={pill(filter === c.id)}>{c.name}</Link>)}
          <Link href="/posted?campaign=none" role="tab" aria-selected={filter === "none"} className={pill(filter === "none")}>No campaign</Link>
        </div>
      )}
      {posts.length === 0 ? <div className="card p-10 text-center text-zinc-400">{filter === "all" ? "Nothing posted yet." : "Nothing posted for this campaign yet."}</div> : (
        <div className="card divide-y divide-line">
          {posts.map((p) => (
            <form key={p.id} action={updatePost.bind(null, p.id)} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 basis-60">
                <div className="truncate font-semibold">{p.clip.title}</div>
                <div className="text-xs text-zinc-400 [overflow-wrap:anywhere]">{p.clip.moment.streamer.name} · {LABEL[p.platform] ?? p.platform}{p.account ? ` (${p.account.channelTitle})` : ""} · {ago(p.postedAt)}{p.status === "draft" ? " · draft waiting in TikTok" : p.status === "failed" ? ` · failed: ${p.error}` : ""}{p.likes != null ? ` · ${p.likes.toLocaleString()} likes` : ""}</div>
              </div>
              <input name="url" defaultValue={p.url ?? ""} placeholder="Post link" className="field w-64 min-w-0 max-w-full" />
              {p.url && <a href={p.url} target="_blank" className="text-xs text-hot">open ↗</a>}
              <input name="views" defaultValue={p.views ?? ""} placeholder="Views" inputMode="numeric" className="field w-28 text-right" />
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
          ))}
        </div>
      )}
    </div>
  );
}
