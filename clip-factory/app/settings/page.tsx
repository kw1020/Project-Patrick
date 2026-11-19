import { getSettings, prisma } from "@/lib/db";
import { judgeConfigured, JUDGE_MODEL } from "@/lib/judge";
import { MIN_POSTS_TO_LEARN } from "@/lib/learning";
import { tiktokConfigured, tiktokRedirectUri } from "@/lib/tiktok";
import { redirectUri, youtubeConfigured } from "@/lib/youtube";
import { EDIT_STYLES, JUMP_CUT_MODES, LAYOUTS, parseEditStyle, parseJumpCuts, parseLayoutSetting } from "@/lib/edit-styles";
import { disconnectAccount, saveAccount, saveSettings } from "../actions";
import { freeUpSpaceNow, saveStorageSettings } from "../storage-actions";
import { avgCostCents } from "@/lib/pricing";
import { fmtBytes, storageUsage } from "@/lib/storage";
import { minFreeGb } from "@/lib/guards";

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

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ msg?: string; storage?: string }> }) {
  const [{ msg, storage: storageMsg }, s, accounts, costRows, usage] = await Promise.all([searchParams, getSettings(), prisma.account.findMany({ orderBy: [{ platform: "asc" }, { createdAt: "asc" }], include: { _count: { select: { posts: true } } } }),
    // v1.9.4: what the Judge costs (tokens logged per clip) and what the clips take up on disk.
    prisma.clip.findMany({ where: { judgeTokensIn: { not: null } }, orderBy: { updatedAt: "desc" }, take: 20, select: { judgeTokensIn: true, judgeTokensOut: true } }),
    storageUsage(),
  ]);
  const cents = avgCostCents(costRows, JUDGE_MODEL);
  const low = usage.freeGb != null && usage.freeGb < 2 * minFreeGb();
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

      <div id="storage" className="card space-y-4 p-5" data-testid="storage-card">
        <Head>Storage</Head>
        {storageMsg && <div className="rounded-lg bg-emerald-500/15 px-3 py-2 text-sm text-emerald-300">{storageMsg}</div>}
        {low && <div className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">Only {usage.freeGb!.toFixed(1)} GB free. Old clips are being deleted early (every time below is halved) until there&apos;s {2 * minFreeGb()} GB.</div>}
        <div className="grid gap-1 text-sm">
          <div><span className="text-zinc-400">Clips folder on your PC:</span> <Code>{usage.hostDir ?? usage.dir}</Code></div>
          {usage.hostDir && <div className="text-xs text-zinc-500">Inside Clip Factory it&apos;s <Code>{usage.dir}</Code>. To use another drive, set <Code>CLIP_STORAGE_DIR</Code> in <Code>.env</Code> (README: Storage) and restart.</div>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-300" data-testid="storage-usage">
            <span>Raw downloads {fmtBytes(usage.byKind.raw)}</span>
            <span>Finished clips {fmtBytes(usage.byKind.final)}</span>
            <span>Edits {fmtBytes(usage.byKind.edits)}</span>
            <span>Work files {fmtBytes(usage.byKind.work)}</span>
            {usage.byKind.other > 0 && <span>Other {fmtBytes(usage.byKind.other)}</span>}
            <span className="font-bold">Total {fmtBytes(usage.total)}</span>
            <span className={low ? "font-bold text-red-300" : "text-emerald-300"}>{usage.freeGb != null ? `${usage.freeGb.toFixed(1)} GB free on that drive` : "free space unknown"}</span>
          </div>
        </div>
        <form action={saveStorageSettings} className="space-y-3">
          <p className="text-xs text-zinc-500">Clips you don&apos;t use delete themselves so they don&apos;t take space. A deleted video can&apos;t be played or re-cut; its card says &ldquo;video expired&rdquo;.</p>
          <Row label="Rejected clips" hint="Includes clips the Judge scored below the min score."><div className="flex items-center gap-2 text-sm">delete after <input name="retainRejectedHrs" type="number" min="1" defaultValue={s.retainRejectedHrs} className="field w-24" /> hours</div></Row>
          <Row label="Clips nobody reviewed" hint="The video is deleted and the clip moves to Queue → Expired."><div className="flex items-center gap-2 text-sm">delete after <input name="retainPendingHrs" type="number" min="1" defaultValue={s.retainPendingHrs} className="field w-24" /> hours</div></Row>
          <Row label="Approved but never posted"><div className="flex items-center gap-2 text-sm">delete the video after <input name="retainApprovedDays" type="number" min="1" defaultValue={s.retainApprovedDays} className="field w-24" /> days</div></Row>
          <Row label="Posted clips" hint="They're on the platform already."><div className="flex items-center gap-2 text-sm">delete the video after <input name="retainPostedDays" type="number" min="1" defaultValue={s.retainPostedDays} className="field w-24" /> days</div></Row>
          <Row label="Raw downloads" hint="Deleted as soon as you approve or reject the clip. Re-cut needs them."><div className="flex items-center gap-2 text-sm">at most <input name="retainRawHrs" type="number" min="1" defaultValue={s.retainRawHrs} className="field w-24" /> hours after the cut</div></Row>
          <Row label="Forget rejected / expired clips" hint="Removes them from the Queue entirely. Clips you posted are kept."><div className="flex items-center gap-2 text-sm">after <input name="retainRowsDays" type="number" min="1" defaultValue={s.retainRowsDays} className="field w-24" /> days</div></Row>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost">Save storage settings</button>
            <button formAction={freeUpSpaceNow} className="btn-hot" title="Runs the clean-up now with every time halved, and deletes the oldest unreviewed videos if space is still short">Free up space now</button>
          </div>
        </form>
      </div>

      <form action={saveSettings} className="space-y-6">
        <div className="card space-y-4 p-5" data-testid="branding">
          <Head>Your channel</Head>
          <Row label="Channel name" hint="Shown in the header and used for the watermark."><input name="channelName" defaultValue={s.channelName} maxLength={30} className="field" /></Row>
          <Row label="Watermark on new clips" hint={`A small, see-through "@${s.channelName}" in the bottom-right corner. Re-cuts get it too.`}><input name="watermark" type="checkbox" defaultChecked={s.watermark} className={check} /></Row>
        </div>
        <div className="card space-y-4 p-5" data-testid="what-to-clip">
          <Head>What to clip</Head>
          <Row label="Funny moments (doesn't have to be gaming)" hint="Laughing chat, banter, reactions, funny fails. Just Chatting, IRL and podcasts count."><input name="clipFunny" type="checkbox" defaultChecked={s.clipFunny} className={check} /></Row>
          <Row label="Gaming moments" hint="Big plays, clutches, chases and other game moments."><input name="clipGaming" type="checkbox" defaultChecked={s.clipGaming} className={check} /></Row>
          <p className="text-xs text-zinc-500">
            Every clip gets a Funny or Gaming label (the Judge decides when it&apos;s on). Switching one off stops new moments of that kind and sets aside clips already in the line that turn out to be that kind.
            &ldquo;Which games&rdquo; below still decides which Twitch streamers are followed. Funny moments often come from Just Chatting, so &ldquo;Any game&rdquo; gets you the most funny clips.
          </p>
          {s.clipFunny && s.gameMode === "gta6" && (
            <div className="rounded-lg bg-sun/10 px-3 py-2 text-sm text-amber-200">Funny moments are on, but &ldquo;Which games&rdquo; is GTA 6 only, so Twitch funny moments only come from GTA streams. Pick &ldquo;Any game&rdquo; to get Just Chatting and IRL ones too.</div>
          )}
          {!s.clipFunny && !s.clipGaming && <div className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">Both are off, so no new clips will be made.</div>}
        </div>

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
          <div className="text-xs text-zinc-400" data-testid="judge-cost">
            The Judge looks at 8 frames of each clip plus its transcript.{" "}
            {cents != null ? <>Cost: <b className="text-zinc-200">~{cents < 1 ? cents.toFixed(1) : Math.round(cents * 10) / 10}¢ per clip</b> (last {costRows.length}).</> : "Cost per clip shows here once clips have been scored."}
          </div>
        </div>

        <div className="card space-y-4 p-5" data-testid="clips-card">
          <Head>Clips</Head>
          {!judgeConfigured() && <div className="rounded-lg bg-sun/10 px-3 py-2 text-sm text-amber-200">Without the Judge, every clip comes to you unscored. Add an Anthropic key so boring clips are filtered out.</div>}
          <Row label="Clip length (seconds)" hint="The cut lands on the payoff (the loud or funny bit) with a little build-up. Shorter sources are kept whole."><div className="flex items-center gap-2"><input name="clipMinSec" type="number" defaultValue={s.clipMinSec} className="field w-24" /> to <input name="clipMaxSec" type="number" defaultValue={s.clipMaxSec} className="field w-24" /></div></Row>
          <Row label="Only standout clips" hint="A Twitch clip needs at least this many times the views of that creator's usual clip. Higher = fewer, better clips."><div className="flex items-center gap-2 text-sm"><span>at least</span><input name="standoutMin" type="number" step="0.5" min="1" defaultValue={s.standoutMin} className="field w-24" /><span>&times; the creator&apos;s usual clip views</span></div></Row>
          <Row label="Max new clips per creator per scan" hint="Shares the line out fairly, so one big channel can't fill it."><input name="maxPerCreatorPerRun" type="number" min="1" defaultValue={s.maxPerCreatorPerRun} className="field w-32" /></Row>
          <Row label="Min Twitch clip views" hint="Only grab viewer clips with at least this many views."><input name="minClipViews" type="number" defaultValue={s.minClipViews} className="field w-32" /></Row>
          <Row label="Look back (days)" hint="How old a Twitch clip can be (1-30 days)."><input name="clipLookbackDays" type="number" min="1" max="30" defaultValue={Math.max(1, Math.round(s.clipLookbackHrs / 24))} className="field w-32" /></Row>
          <Row label="Layout" hint="How the wide stream is fitted into the tall video. You can re-cut any clip in another layout from its card in the Queue.">
            <div className="space-y-1.5" data-testid="layout-choice">
              {LAYOUTS.map((x) => (
                <label key={x.key} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="layout" value={x.key} defaultChecked={parseLayoutSetting(s.layout) === x.key} className="mt-0.5 h-4 w-4 accent-[#ff3d81]" />
                  <span><span className="font-semibold">{x.label}</span> <span className="text-xs text-zinc-500">{x.hint}</span></span>
                </label>
              ))}
            </div>
          </Row>
          <Row label="Editing style" hint="How new clips are edited. You can re-cut any clip in another style from its card in the Queue.">
            <div className="space-y-1.5">
              {EDIT_STYLES.map((x) => (
                <label key={x.key} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="editStyle" value={x.key} defaultChecked={parseEditStyle(s.editStyle) === x.key} className="mt-0.5 h-4 w-4 accent-[#ff3d81]" />
                  <span><span className="font-semibold">{x.label}</span> <span className="text-xs text-zinc-500">{x.hint}</span></span>
                </label>
              ))}
            </div>
          </Row>
          <Row label="Jump cuts" hint="Cuts out silent pauses. Only real silence is cut (never game sound, music or talking). You can also re-cut one clip without them from its card.">
            <select name="jumpCuts" defaultValue={parseJumpCuts(s.jumpCuts)} className="field w-72">
              {JUMP_CUT_MODES.map((x) => <option key={x.key} value={x.key}>{x.label}: {x.hint}</option>)}
            </select>
          </Row>
          <Row label="Burn captions"><input name="captions" type="checkbox" defaultChecked={s.captions} className={check} /></Row>
        </div>

        <div className="card space-y-4 p-5">
          <Head>YouTube scanner</Head>
          <Row label="Scan approved YouTube channels" hint="Every 30 min: cuts the most-replayed moments of their newest long videos (no API key needed)."><input name="ytScanEnabled" type="checkbox" defaultChecked={s.ytScanEnabled} className={check} /></Row>
          <Row label="Newest videos per channel" hint="How many of each channel's latest uploads to look at."><input name="ytVideosPerChannel" type="number" defaultValue={s.ytVideosPerChannel} className="field w-32" /></Row>
          <Row label="Moments per video" hint="Most-replayed peaks to clip from each video (at least 60s apart)."><input name="ytMomentsPerVideo" type="number" defaultValue={s.ytMomentsPerVideo} className="field w-32" /></Row>
          <Row label="Max video age (days)" hint="Older uploads are skipped."><input name="ytMaxVideoAgeDays" type="number" defaultValue={s.ytMaxVideoAgeDays} className="field w-32" /></Row>
          <Row label="Suggestions country" hint="2-letter code (US, GB, CA…) of the YouTube trending charts used for YouTube suggestions."><input name="ytSuggestRegion" defaultValue={s.ytSuggestRegion} maxLength={2} className="field w-32 uppercase" /></Row>
        </div>

        <div className="card space-y-4 p-5">
          <Row label="Which games" hint="Any game: your approved creators are clipped whatever they play. GTA 6 only: just their GTA 6 streams, plus the GTA 6 top clips.">
            <select name="gameMode" defaultValue={s.gameMode === "gta6" ? "gta6" : "any"} className="field w-72"><option value="any">Any game (approved streamers)</option><option value="gta6">GTA 6 only</option></select>
          </Row>
          <Row label="Pause the Scout" hint="Stops new clips. The queue still works."><input name="scoutPaused" type="checkbox" defaultChecked={s.scoutPaused} className={check} /></Row>
        </div>
        <button className="btn-hot">Save settings</button>
      </form>
    </div>
  );
}
