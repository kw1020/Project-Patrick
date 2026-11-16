import { getSettings } from "@/lib/db";
import { judgeConfigured, JUDGE_MODEL } from "@/lib/judge";
import { getYouTubeAccount, redirectUri, youtubeConfigured } from "@/lib/youtube";
import { disconnectYouTube, saveSettings } from "../actions";

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

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ yt?: string }> }) {
  const [{ yt: ytMsg }, s, yt] = await Promise.all([searchParams, getSettings(), getYouTubeAccount()]);
  const justConnected = ytMsg?.startsWith("connected:");
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-black">Settings</h1>
        <p className="text-sm text-zinc-400">Changes apply to the next clips the line makes.</p>
      </div>

      <div className="card space-y-3 p-5">
        <Head>YouTube</Head>
        {ytMsg && <div className={`rounded-lg px-3 py-2 text-sm ${justConnected ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{justConnected ? `Connected to ${ytMsg.slice(10)}.` : ytMsg}</div>}
        {yt ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Connected: {yt.channelTitle}</div>
              {yt.error ? <div className="text-sm text-red-300">{yt.error}</div> : <div className="text-xs text-zinc-500">Up to 100 uploads a day (Google&apos;s limit per project).</div>}
            </div>
            <div className="flex gap-2">
              {yt.error && <a href="/api/youtube/connect" className="btn-hot">Reconnect</a>}
              <form action={disconnectYouTube}><button className="btn-bad">Disconnect</button></form>
            </div>
          </div>
        ) : youtubeConfigured() ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-zinc-300">Not connected. Sign in with the YouTube channel you want clips posted to.</div>
            <a href="/api/youtube/connect" className="btn-hot">Connect YouTube</a>
          </div>
        ) : (
          <div className="text-sm text-zinc-300">
            Add <code className="rounded bg-black/40 px-1">YOUTUBE_CLIENT_ID</code> and <code className="rounded bg-black/40 px-1">YOUTUBE_CLIENT_SECRET</code> to <code>.env</code> and restart (steps in the README).
            The redirect URL to give Google is <code className="rounded bg-black/40 px-1">{redirectUri()}</code>.
          </div>
        )}
      </div>

      <form action={saveSettings} className="space-y-6">
        <div className="card space-y-4 p-5">
          <Head>Posting</Head>
          <Row label="Post to YouTube when I approve" hint="Off: Approve only marks the clip, and you upload with a button."><input name="ytAutoUpload" type="checkbox" defaultChecked={s.ytAutoUpload} className={check} /></Row>
          <Row label="YouTube visibility" hint="Private or unlisted lets you check it on YouTube before it goes live.">
            <select name="ytPrivacy" defaultValue={s.ytPrivacy} className="field w-56"><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select>
          </Row>
        </div>

        <div className="card space-y-4 p-5">
          <Head>Spike detector</Head>
          <Row label="Detect chat spikes" hint="Makes clips from live moments when an approved streamer's chat blows up."><input name="spikeEnabled" type="checkbox" defaultChecked={s.spikeEnabled} className={check} /></Row>
          <Row label="Spike sensitivity" hint="Flag when chat msgs/sec hits this many × the 5-min average. Lower = more clips."><input name="spikeMultiplier" type="number" step="0.1" defaultValue={s.spikeMultiplier} className="field w-32" /></Row>
        </div>

        <div className="card space-y-4 p-5">
          <Head>Judge</Head>
          {!judgeConfigured() && <div className="rounded-lg bg-sun/10 px-3 py-2 text-sm text-sun">No <code>ANTHROPIC_API_KEY</code> in <code>.env</code>, so clips go to review unscored.</div>}
          <Row label="Score clips with Claude" hint={`Uses ${JUDGE_MODEL}. Writes the hook, title and hashtags too.`}><input name="judgeEnabled" type="checkbox" defaultChecked={s.judgeEnabled} className={check} /></Row>
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
          <Row label="Pause the Scout" hint="Stops new clips. The queue still works."><input name="scoutPaused" type="checkbox" defaultChecked={s.scoutPaused} className={check} /></Row>
        </div>
        <button className="btn-hot">Save settings</button>
      </form>
    </div>
  );
}
