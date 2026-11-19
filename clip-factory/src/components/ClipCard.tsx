"use client";
import { useState, useTransition } from "react";
import { markPosted, postToAccount, rebuildCaption, recutClip, retryClip, setClipStatus, updateClipText } from "../../app/actions";
import { EDIT_STYLES, LAYOUTS, editStyleLabel, layoutChip, parseEditStyle } from "../lib/edit-styles";
import { captionCredits, checkCampaignCaption, creatorHandle, creatorUrl } from "../lib/social";
import { CategoryChip } from "./CategoryChip";

export type ClipView = {
  id: string; status: string; stage: string | null; error: string | null; title: string; caption: string;
  duration: number | null; score: number | null; hook: string | null; judgeReason: string | null; hasVideo: boolean;
  observations?: string | null; judgeFrames?: number | null; // v1.9.4: what the Judge saw/heard, and how many stills it looked at
  expired?: boolean; // the video was deleted by retention to save disk
  canRecut?: boolean; // the raw video is still there, so it can be re-cut in another editing style
  editStyle?: string | null; editNote?: string | null; version?: number;
  layout?: string | null; // v1.9.0: split | fullcam | blur, the layout it was last cut with // version busts the browser's video cache after a re-cut
  streamer: { name: string; login: string; platform: string }; source: string; vodOffset?: number | null; spikeScore: number; sourceUrl: string | null; sourceViews: number;
  category?: string | null; // funny | gaming (null on older clips)
  campaign?: { name: string; requiredText: string | null; bannedWords: string | null; maxCaptionChars: number | null } | null; // v1.9.1: the creator's active campaign
  posts: { platform: string; accountId: string | null; status: string; url: string | null; error: string | null }[]; postError: string | null;
};
export type AccountView = { id: string; platform: string; label: string; autoPost: boolean; privacy: string };

const STAGE: Record<string, string> = { grab: "Grabbing video…", transcribe: "Transcribing…", judge: "The Judge is scoring it…", cut: "Cutting + captioning…" };
const PLATFORM: Record<string, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Reels" };

export function ClipCard({ clip, accounts }: { clip: ClipView; accounts: AccountView[] }) {
  const [title, setTitle] = useState(clip.title);
  const [caption, setCaption] = useState(clip.caption);
  const [saved, setSaved] = useState(true);
  const [copied, setCopied] = useState(false);
  const [busy, start] = useTransition();
  const [recutStyle, setRecutStyle] = useState<string>(parseEditStyle(clip.editStyle));
  const [recutLayout, setRecutLayout] = useState<string>(clip.layout === "facecam" ? "split" : clip.layout ?? "auto");
  const [recutJumps, setRecutJumps] = useState(true);
  const dirty = title !== clip.title || caption !== clip.caption;

  const save = () => { if (dirty || !saved) start(async () => { await updateClipText(clip.id, title, caption); setSaved(true); }); };
  const act = (fn: () => Promise<unknown>) => start(async () => { if (dirty) await updateClipText(clip.id, title, caption); await fn(); });
  const copy = async () => {
    await navigator.clipboard.writeText(caption);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const uploading = clip.stage === "post";
  const auto = accounts.filter((a) => a.autoPost);
  const notYet = accounts.filter((a) => !clip.posts.some((p) => p.accountId === a.id && p.status !== "failed"));
  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.label;
  const reviewed = clip.status === "approved" || clip.status === "posted";
  const recutting = clip.stage === "cut" && clip.status !== "processing";
  const styleName = editStyleLabel(clip.editStyle);
  const layoutName = layoutChip(clip.layout);
  const scoreColor = clip.score == null ? "" : clip.score >= 8 ? "text-emerald-300" : clip.score >= 6 ? "text-sun" : "text-red-300";

  return (
    <div className={`card flex flex-col overflow-hidden ${busy ? "opacity-60" : ""}`}>
      <div className="relative aspect-[9/16] w-full bg-black">
        {clip.hasVideo ? (
          <video key={clip.version} src={`/api/media/${clip.id}${clip.version ? `?v=${clip.version}` : ""}`} controls preload="metadata" playsInline className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-zinc-400">
            {clip.expired ? <span>{clip.status === "expired" ? "Expired: nobody reviewed it in time, so the video was deleted to save space" : "Video expired (deleted to save space)"}</span>
              : clip.status === "failed" ? <span className="text-red-300">{clip.error}</span> : <span className="animate-pulse">{STAGE[clip.stage ?? ""] ?? "Working…"}</span>}
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap gap-1">
          {clip.score != null && <span className={`rounded-md bg-black/75 px-2 py-1 text-xs font-black ${scoreColor}`}>{clip.score}/10</span>}
          {clip.duration != null && <span className="rounded-md bg-black/75 px-2 py-1 text-xs font-bold">{Math.round(clip.duration)}s</span>}
          {styleName && <span className="rounded-md bg-black/75 px-2 py-1 text-xs font-bold text-zinc-300">{styleName}</span>}
          {layoutName && <span className="rounded-md bg-black/75 px-2 py-1 text-xs font-bold text-zinc-300" data-testid="layout-chip">{layoutName}</span>}
          <span className="rounded-md bg-black/75 px-2 py-1 text-xs font-bold text-zinc-300">{clip.source === "chat" ? `Chat spike ${clip.spikeScore}x` : clip.source === "youtube" ? "YouTube peak" : "Twitch clip"}</span>
          {clip.category && <span className="rounded-md bg-black/75"><CategoryChip category={clip.category} className="inline-block px-2 py-1 text-xs" /></span>}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
          <a href={creatorUrl(clip.streamer)} target="_blank" className="font-bold text-zinc-200 hover:text-hot">{clip.streamer.name}</a>
          {clip.sourceUrl && (
            <a href={clip.source === "youtube" ? `${clip.sourceUrl}&t=${Math.max(0, (clip.vodOffset ?? 25) - 25)}s` : clip.sourceUrl} target="_blank" className="hover:text-white">
              {clip.source === "chat" ? "Watch on Twitch ↗" : clip.source === "youtube" ? "Watch on YouTube ↗" : `${clip.sourceViews.toLocaleString()} views on Twitch ↗`}
            </a>
          )}
        </div>
        {clip.judgeReason && (
          <div className="rounded-lg bg-ink px-2.5 py-2 text-xs leading-relaxed text-zinc-300">
            <span className="font-bold text-zinc-100">Judge{clip.score != null ? ` · ${clip.score}/10` : ""}:</span> {clip.judgeReason}
            {clip.observations && <div className="mt-1 text-zinc-400" data-testid="judge-observations">Saw: {clip.observations}{clip.judgeFrames === 0 ? " (text only, no frames)" : ""}</div>}
            {clip.hook && <div className="mt-1 text-zinc-400">Hook on video: “{clip.hook}”</div>}
          </div>
        )}
        <input className="field font-semibold" value={title} onChange={(e) => { setTitle(e.target.value); setSaved(false); }} onBlur={save} maxLength={100} />
        <textarea className="field min-h-28 text-xs leading-relaxed" value={caption} onChange={(e) => { setCaption(e.target.value); setSaved(false); }} onBlur={save} />
        {!captionCredits(caption, clip.streamer) && (
          <div className="text-xs text-sun">⚠ Caption must credit {creatorHandle(clip.streamer)}</div>
        )}
        {clip.campaign && (
          <div className="space-y-0.5 rounded-lg border border-line px-2.5 py-2 text-xs" data-testid="campaign-checks">
            <div className="font-bold text-zinc-300">Campaign: {clip.campaign.name}</div>
            {checkCampaignCaption(caption, clip.campaign).map((r, i) => (
              <div key={i} className={`[overflow-wrap:anywhere] ${r.ok ? "text-emerald-300" : "text-sun"}`}>{r.ok ? "✅" : "⚠️"} {r.rule}</div>
            ))}
          </div>
        )}

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {clip.status === "pending" && <>
            <button className="btn-ok flex-1" disabled={busy} onClick={() => act(() => setClipStatus(clip.id, "approved"))}>
              {auto.length ? `Approve + send to ${auto.length === 1 ? auto[0].label : `${auto.length} accounts`}` : "Approve"}
            </button>
            <button className="btn-bad flex-1" disabled={busy} onClick={() => act(() => setClipStatus(clip.id, "rejected"))}>Reject</button>
          </>}
          {clip.status === "rejected" && !clip.expired && <button className="btn-ghost flex-1" disabled={busy} onClick={() => act(() => setClipStatus(clip.id, "pending"))}>Back to review</button>}
          {clip.status === "failed" && <button className="btn-hot flex-1" disabled={busy} onClick={() => act(() => retryClip(clip.id))}>Retry</button>}
          {clip.hasVideo && !clip.expired && <a className="btn-ghost flex-1" href={`/api/media/${clip.id}?download=1`}>Download</a>}
          <button className="btn-ghost flex-1" onClick={copy}>{copied ? "Copied ✓" : "Copy caption"}</button>
          {clip.status !== "processing" && (
            <button className="btn-ghost flex-1" disabled={busy} title="Write the caption again in the ViceCityClips format, with the creator's campaign rules"
              onClick={() => start(async () => { const c = await rebuildCaption(clip.id); setCaption(c); setSaved(true); })}>Rebuild caption</button>
          )}
        </div>
        {recutting && <div className="animate-pulse text-xs text-sun">Re-cutting… the new version replaces this video in about a minute.</div>}
        {clip.editNote && !recutting && <div className="text-xs text-zinc-500" title={clip.editNote}>Plain edit used (the styled edit hit a problem).</div>}
        {clip.canRecut && clip.status !== "processing" && (
          <details className="text-xs">
            <summary className="cursor-pointer select-none text-zinc-400 hover:text-white">Re-cut ▾</summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <select aria-label="Editing style" className="field py-1 text-xs" value={recutStyle} onChange={(e) => setRecutStyle(e.target.value)} disabled={busy || recutting}>
                {EDIT_STYLES.map((x) => <option key={x.key} value={x.key} title={x.hint}>{x.label}</option>)}
              </select>
              <select aria-label="Layout" className="field py-1 text-xs" value={recutLayout} onChange={(e) => setRecutLayout(e.target.value)} disabled={busy || recutting}>
                {LAYOUTS.map((x) => <option key={x.key} value={x.key} title={x.hint}>{x.short}</option>)}
              </select>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="flex flex-1 items-center gap-1.5 text-zinc-400" title="Off = no cuts inside the clip">
                <input type="checkbox" className="h-3.5 w-3.5 accent-[#ff3d81]" checked={recutJumps} onChange={(e) => setRecutJumps(e.target.checked)} disabled={busy || recutting} />
                Jump cuts
              </label>
              <button className="btn-hot px-3 py-1 text-xs" disabled={busy || recutting}
                onClick={() => act(() => recutClip(clip.id, recutStyle, recutJumps ? undefined : "off", recutLayout))}>Re-cut</button>
            </div>
          </details>
        )}

        {reviewed && (
          <div className="mt-1 space-y-2 border-t border-line pt-3">
            {clip.posts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 text-xs">
                {clip.posts.map((p, i) => {
                  const name = `${PLATFORM[p.platform] ?? p.platform}${accountName(p.accountId) ? ` · ${accountName(p.accountId)}` : ""}`;
                  if (p.status === "draft") return <span key={i} title="Open TikTok, tap the inbox notification, paste the caption, post." className="rounded-full bg-sun/15 px-2 py-1 font-bold text-sun">⏳ {name}: draft in your TikTok inbox</span>;
                  if (p.status === "failed") return <span key={i} title={p.error ?? ""} className="rounded-full bg-red-500/15 px-2 py-1 font-bold text-red-300">✕ {name}: {p.error}</span>;
                  return p.url
                    ? <a key={i} href={p.url} target="_blank" className="rounded-full bg-emerald-500/15 px-2 py-1 font-bold text-emerald-300">✓ {name} ↗</a>
                    : <span key={i} className="rounded-full bg-emerald-500/15 px-2 py-1 font-bold text-emerald-300">✓ {name}</span>;
                })}
              </div>
            )}
            {uploading && <div className="animate-pulse text-xs text-sun">Sending…</div>}
            {clip.postError && <div className="text-xs text-red-300">Posting failed: {clip.postError}</div>}
            {!uploading && notYet.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {notYet.map((a) => (
                  <button key={a.id} className="btn-hot flex-1" disabled={busy} onClick={() => act(() => postToAccount(clip.id, a.id))}>
                    {a.platform === "tiktok" ? `TikTok draft → ${a.label}` : `YouTube → ${a.label} (${a.privacy})`}
                  </button>
                ))}
              </div>
            )}
            <form id={`posted-${clip.id}`} action={(fd) => act(() => markPosted(clip.id, fd))} className="flex gap-2">
              <select name="platform" className="field w-24 shrink-0">
                <option value="tiktok">TikTok</option><option value="instagram">Reels</option><option value="youtube">Shorts</option>
              </select>
              <input name="url" placeholder="Post link (optional)" className="field min-w-0" />
              <button className="btn-ghost shrink-0">Posted</button>
            </form>
            <input form={`posted-${clip.id}`} name="campaignLink" placeholder="Whop campaign link (optional)" className="field text-xs" data-testid="posted-campaign-link" />
          </div>
        )}
      </div>
    </div>
  );
}
