import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ToPostCard, type ToPostView } from "@/components/ToPostCard";
import { PLATFORM_LABEL, POST_PLATFORMS, accountAction, isGtaFocus, parseKinds } from "@/lib/channels";
import { toPostItems } from "@/lib/to-post";

export const dynamic = "force-dynamic";

type Data = Awaited<ReturnType<typeof toPostItems>>;
type Item = Data["items"][number];
type Acct = Data["accounts"][number];

function view(x: Item): ToPostView {
  const k = x.clip, s = k.moment.streamer, camp = s.campaign?.active ? s.campaign : null;
  return {
    id: k.id, title: k.title ?? "", caption: k.caption ?? "", score: k.score, judgeReason: k.judgeReason, hasVideo: Boolean(k.finalPath),
    version: k.updatedAt.getTime(), stage: k.stage, postError: k.postError, category: k.category ?? k.moment.category, duration: k.duration,
    streamer: { name: s.name, login: s.login },
    campaign: camp ? { name: camp.name, link: camp.link, requiredText: camp.requiredText, bannedWords: camp.bannedWords, maxCaptionChars: camp.maxCaptionChars } : null,
    channelId: x.channel?.id ?? null, chosenChannelId: k.channelId, channelName: x.channel?.name ?? null,
    rows: x.rows.map(({ account: a, post }) => ({
      accountId: a.id, platform: a.platform, label: a.handle ?? a.channelTitle ?? a.platform, action: accountAction(a), error: a.error, disabled: a.disabled,
      done: post ? { status: post.status, url: post.url } : null,
    })),
    supreme: null,
  };
}

/** Green = connected (posts for you), amber = by hand (download + copy caption), grey = switched off or no account. */
function Slot({ platform, a }: { platform: string; a: Acct | undefined }) {
  const state = !a ? "none" : a.disabled ? "off" : a.mode === "api" && a.platform !== "instagram" && !a.error ? "api" : "hand";
  const dot = { api: "bg-emerald-400", hand: "bg-amber-400", off: "bg-zinc-600", none: "border border-zinc-600" }[state];
  const why = { api: "connected: Clip Factory posts it", hand: "by hand: download + copy caption", off: `switched off${a?.error ? `: ${a.error}` : ""}`, none: "no account yet" }[state];
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px]" title={`${PLATFORM_LABEL[platform]}: ${why}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span className="w-14 shrink-0 text-zinc-500">{PLATFORM_LABEL[platform]}</span>
      <span className={`min-w-0 truncate ${state === "off" ? "text-zinc-500 line-through" : "text-zinc-300"}`}>{a ? a.handle ?? a.channelTitle : "—"}</span>
    </div>
  );
}

export default async function UploadPage() {
  const { channels, accounts, items } = await toPostItems();
  const chans = channels.map((c) => ({ id: c.id, name: c.name }));
  const noChannel = items.filter((x) => !x.channel);
  const cols = [
    ...channels.map((c) => ({ id: c.id, name: c.name, sub: isGtaFocus(c) ? "GTA 6 · every type" : parseKinds(c.kinds).join(" + ") || "no types ticked", items: items.filter((x) => x.channel?.id === c.id), channel: c })),
    ...(noChannel.length ? [{ id: "none", name: "No channel", sub: "Use Move to… on each clip", items: noChannel, channel: null }] : []),
  ];
  return (
    <div className="space-y-4">
      <AutoRefresh seconds={20} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black">Upload</h1>
          <p className="text-sm text-zinc-400">Approved clips, in the column of the channel they go to. <b>Post to all</b> uploads to the channel&apos;s connected YouTube and TikTok; Instagram and by-hand accounts: Download + copy caption, post it, then Mark posted. Done clips move to Posted.</p>
        </div>
        <Link href="/queue" className="btn-ghost text-sm">Review more in the Queue</Link>
      </div>
      {channels.length === 0 ? (
        <div className="card p-10 text-center text-zinc-400">No channels yet. Add them in <Link href="/settings#channels" className="text-hot">Settings → Channels</Link>.</div>
      ) : (
        <div className="grid gap-4 md:flex md:items-start md:overflow-x-auto md:pb-2" data-testid="upload-columns">
          {cols.map((col) => (
            <section key={col.id} className="min-w-0 space-y-3 md:w-80 md:shrink-0 xl:w-auto xl:min-w-[16rem] xl:flex-1" data-testid="upload-column">
              <div className="card space-y-1.5 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="min-w-0 truncate font-black">{col.name}</h2>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${col.items.length ? "bg-emerald-500 text-black" : "bg-zinc-800 text-zinc-400"}`}>{col.items.length} waiting</span>
                </div>
                <div className="text-[11px] text-zinc-500">{col.sub}</div>
                {col.channel && POST_PLATFORMS.map((p) => <Slot key={p} platform={p} a={accounts.find((a) => a.homeChannelId === col.channel!.id && a.platform === p)} />)}
              </div>
              {col.items.length === 0
                ? <div className="rounded-xl border border-dashed border-line p-6 text-center text-xs text-zinc-500">Nothing waiting. Approve clips in the <Link href="/queue" className="text-hot">Queue</Link>.</div>
                : col.items.map((x) => <ToPostCard key={x.clip.id} clip={view(x)} channels={chans} />)}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
