import { prisma } from "@/lib/db";
import { ago } from "@/lib/format";
import { updatePost } from "../actions";

export const dynamic = "force-dynamic";
const LABEL: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube Shorts", instagram: "Reels" };

export default async function PostedPage() {
  const posts = await prisma.post.findMany({ include: { account: true, clip: { include: { moment: { include: { streamer: true } } } } }, orderBy: { postedAt: "desc" }, take: 200 });
  const total = posts.reduce((a, p) => a + (p.views ?? 0), 0);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-black">Posted</h1>
          <p className="text-sm text-zinc-400">What went out and where. Views from connected accounts update every 15 minutes. Type in views for posts you made by hand.</p>
        </div>
        <div className="card px-4 py-2 text-right"><div className="text-xl font-black">{total.toLocaleString()}</div><div className="text-xs text-zinc-400">total views · {posts.length} posts</div></div>
      </div>
      {posts.length === 0 ? <div className="card p-10 text-center text-zinc-400">Nothing posted yet.</div> : (
        <div className="card divide-y divide-line">
          {posts.map((p) => (
            <form key={p.id} action={updatePost.bind(null, p.id)} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 basis-60">
                <div className="truncate font-semibold">{p.clip.title}</div>
                <div className="text-xs text-zinc-400">{p.clip.moment.streamer.name} · {LABEL[p.platform] ?? p.platform}{p.account ? ` (${p.account.channelTitle})` : ""} · {ago(p.postedAt)}{p.status === "draft" ? " · draft waiting in TikTok" : p.status === "failed" ? ` · failed: ${p.error}` : ""}{p.likes != null ? ` · ${p.likes.toLocaleString()} likes` : ""}</div>
              </div>
              <input name="url" defaultValue={p.url ?? ""} placeholder="Post link" className="field w-64" />
              {p.url && <a href={p.url} target="_blank" className="text-xs text-hot">open ↗</a>}
              <input name="views" defaultValue={p.views ?? ""} placeholder="Views" inputMode="numeric" className="field w-28 text-right" />
              <button className="btn-ghost">Save</button>
            </form>
          ))}
        </div>
      )}
    </div>
  );
}
