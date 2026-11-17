import { getSettings, prisma } from "@/lib/db";
import { judgeConfigured, JUDGE_MODEL } from "@/lib/judge";
import { MIN_POSTS_TO_LEARN } from "@/lib/learning";
import { tiktokConfigured, tiktokRedirectUri } from "@/lib/tiktok";
import { redirectUri, youtubeConfigured } from "@/lib/youtube";
import { disconnectAccount, saveAccount, saveSettings } from "../actions";

export const dynamic = "force-dynamic";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 sm:grid-cols-[16rem_1fr] sm:items-center sm:gap-4">
      <div><div className="text-sm font-semibold">{label}</div>{hint && <div className="text-xs text-zinc-500">{hint}</div>}</div>
      <div>{children}</div>
    </label>
  );
}
const check = "h-5 w-5 accent-[#ff3d81]";
const Head = ({ children }: { children: React.ReactNode }) => <div className="text-xs font-bold uppercase tracking-wide text-zinc-400">{children}</div>;
const Code = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-black/40 px-1">{children}</code>;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const [{ msg }, s, accounts] = await Promise.all([searchParams, getSettings(), prisma.account.findMany({ orderBy: [{ platform: "asc" }, { createdAt: "asc" }], include: { _count: { select: { posts: true } } } })]);
  const justConnected = msg?.startsWith("connected:");
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-black">Settings</h1>
        <p className="text-sm text-zinc-400">Changes apply to the next clips the line makes.</p>
      </div>

      <div className="card space-y-4 p-5">
        <Head>Posting accounts</Head>
        {msg && <div className={`rounded-lg px-3 py-2 text-sm ${justConnected ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{justConnected ? `Connected ${msg.slice(10)}.` : msg}</div>}
        {accounts.length === 0 && <div className="text-sm text-zinc-400">Nothing connected yet. Approved clips can still be downloaded and posted by hand.</div>}
        <div className="divide-y divide-line">
          {accounts.map((a) => (
            <form key={a.id} action={saveAccount.bind(null, a.id)} className="flex flex-wrap items-center gap-3 py-3">
              <span className={`rounded-md px-2 py-1 text-[11px] font-black uppercase ${a.platform === "youtube" ? "bg-red-600/20 text-red-300" : "bg-cyan-500/15 text-cyan-300"}`}>{a.platform === "youtube" ? "YouTube" : "TikTok"}</span>
              <div className="min-w-40 flex-1">
                <div className="font-semibold">{a.channelTitle}</div>
                {a.error ? <div className="text-xs text-red-300">{a.error}</div> : <div className="text-xs text-zinc-500">{a._count.posts} posts{a.platform === "tiktok" ? " · sends drafts to your TikTok inbox" : ""}</div>}
              </div>
              <label className="flex items-center gap-2 text-sm"><input name="autoPost" type="checkbox" defaultChecked={a.autoPost} className={check} />{a.platform === "tiktok" ? "Send draft when I approve" : "Post when I approve"}</label>
              {a.platform === "youtube" && (
                <select name="privacy" defaultValue={a.privacy} className="field w-28"><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select>
              )}
              <button className="btn-ghost">Save</button>
              {a.error && <a href={`/api/${a.platform}/connect`} className="btn-hot">Reconnect</a>}
              <button formAction={disconnectAccount.bind(null, a.id)} className="btn-bad">Disconnect</button>
            </form>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          {youtubeConfigured() ? <a href="/api/youtube/connect" className="btn-hot">+ Connect a YouTube channel</a>
            : <div className="text-xs text-zinc-400">YouTube: add <Code>YOUTUBE_CLIENT_ID</Code> / <Code>YOUTUBE_CLIENT_SECRET</Code> to <Code>.env</Code> (redirect URL <Code>{redirectUri()}</Code>).</div>}
          {tiktokConfigured() ? <a href="/api/tiktok/connect" className="btn-hot">+ Connect a TikTok account</a>
            : <div className="text-xs text-zinc-400">TikTok: add <Code>TIKTOK_CLIENT_KEY</Code> / <Code>TIKTOK_CLIENT_SECRET</Code> to <Code>.env</Code> (redirect URL <Code>{tiktokRedirectUri()}</Code>).</div>}
        </div>
        <p className="text-xs text-zinc-500">To add a second channel or account, connect again and pick a different one when Google or TikTok asks. TikTok drafts land in that account&apos;s inbox: open TikTok, paste the caption, post. TikTok allows 5 waiting drafts per account per day.</p>
      </div>

      <form action={saveSettings} className="space-y-6">
        <div className="card space-y-4 p-5">
          <Head>Spike detector</Head>
          <Row label="Detect chat spikes" hint="Makes clips from live moments when an approved streamer's chat blows up."><input name="spikeEnabled" type="checkbox" defaultChecked={s.spikeEnabled} className={check} /></Row>
          <Row label="Spike sensitivity" hint="Flag when chat msgs/sec hits this many × the 5-min average. Lower = more clips."><input name="spikeMultiplier" type="number" step="0.1" defaultValue={s.spikeMultiplier} className="field w-32" /></Row>
        </div>

        <div className="card space-y-4 p-5">
          <Head>Judge</Head>
          {!judgeConfigured() && <div className="rounded-lg bg-sun/10 px-3 py-2 text-sm text-sun">No <Code>ANTHROPIC_API_KEY</Code> in <Code>.env</Code>, so clips go to review unscored.</div>}
          <Row label="Score clips with Claude" hint={`Uses ${JUDGE_MODEL}. Writes the hook, title and hashtags too.`}><input name="judgeEnabled" type="checkbox" defaultChecked={s.judgeEnabled} className={check} /></Row>
          <Row label="Learn from my results" hint={`Shows the Judge which of your posts did best and worst. Starts once ${MIN_POSTS_TO_LEARN} posts are a day old. See Analytics.`}><input name="judgeLearns" type="checkbox" defaultChecked={s.judgeLearns} className={check} /></Row>
          <Row label="Min score" hint="Clips the Judge scores below this go straight to Rejected (you can still rescue them)."><input name="minScore" type="number" step="0.5" defaultValue={s.minScore} className="field w-32" /></Row>
        </div>

        <div className="card space-y-4 p-5">
          <Head>Clips</Head>
          <Row label="Clip length (seconds)" hint="Shorter sources are kept whole."><div className="flex items-center gap-2"><input name="clipMinSec" type="number" defaultValue={s.clipMinSec} className="field w-24" /> to <input name="clipMaxSec" type="number" defaultValue={s.clipMaxSec} className="field w-24" /></div></Row>
          <Row label="Min Twitch clip views" hint="Only grab viewer clips with at least this many views."><input name="minClipViews" type="number" defaultValue={s.minClipViews} className="field w-32" /></Row>
          <Row label="Look back (hours)" hint="How old a Twitch clip can be."><input name="clipLookbackHrs" type="number" defaultValue={s.clipLookbackHrs} className="field w-32" /></Row>
          <Row label="Vertical layout" hint="Facecam needs the box set per streamer; falls back to blur.">
            <select name="layout" defaultValue={s.layout} className="field w-56"><option value="blur">Blurred background</option><option value="facecam">Facecam on top</option></select>
          </Row>
          <Row label="Burn captions"><input name="captions" type="checkbox" defaultChecked={s.captions} className={check} /></Row>
        </div>

        <div className="card space-y-4 p-5">
          <Row label="Which games" hint="Any game: approved streamers are clipped whatever they play. The GTA 6 scan still runs either way.">
            <select name="gameMode" defaultValue={s.gameMode} className="field w-72"><option value="gta6">GTA 6 only</option><option value="any">Any game (approved streamers)</option></select>
          </Row>
          <Row label="Pause the Scout" hint="Stops new clips. The queue still works."><input name="scoutPaused" type="checkbox" defaultChecked={s.scoutPaused} className={check} /></Row>
        </div>
        <button className="btn-hot">Save settings</button>
      </form>
    </div>
  );
}
