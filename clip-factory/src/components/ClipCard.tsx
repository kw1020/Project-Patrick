"use client";
import { useState, useTransition } from "react";
import { markPosted, retryClip, setClipStatus, updateClipText, uploadToYouTube } from "../../app/actions";

export type ClipView = {
  id: string; status: string; stage: string | null; error: string | null; title: string; caption: string;
  duration: number | null; score: number | null; hook: string | null; judgeReason: string | null; hasVideo: boolean;
  streamer: { name: string; login: string }; source: string; spikeScore: number; sourceUrl: string | null; sourceViews: number;
  posts: { platform: string; url: string | null }[]; postError: string | null;
};

const STAGE: Record<string, string> = { grab: "Grabbing video…", transcribe: "Transcribing…", judge: "The Judge is scoring it…", cut: "Cutting + captioning…" };
const PLATFORM: Record<string, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Reels" };

export function ClipCard({ clip, yt }: { clip: ClipView; yt: { connected: boolean; auto: boolean; privacy: string } }) {
  const [title, setTitle] = useState(clip.title);
  const [caption, setCaption] = useState(clip.caption);
  const [saved, setSaved] = useState(true);
  const [copied, setCopied] = useState(false);
  const [busy, start] = useTransition();
  const dirty = title !== clip.title || caption !== clip.caption;

  const save = () => { if (dirty || !saved) start(async () => { await updateClipText(clip.id, title, caption); setSaved(true); }); };
  const act = (fn: () => Promise<unknown>) => start(async () => { if (dirty) await updateClipText(clip.id, title, caption); await fn(); });
  const copy = async () => {
    await navigator.clipboard.writeText(caption);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const onYouTube = clip.posts.some((p) => p.platform === "youtube");
  const uploading = clip.stage === "post";
  const reviewed = clip.status === "approved" || clip.status === "posted";
  const scoreColor = clip.score == null ? "" : clip.score >= 8 ? "text-emerald-300" : clip.score >= 6 ? "text-sun" : "text-red-300";

  return (
    <div className={`card flex flex-col overflow-hidden ${busy ? "opacity-60" : ""}`}>
      <div className="relative aspect-[9/16] w-full bg-black">
        {clip.hasVideo ? (
          <video src={`/api/media/${clip.id}`} controls preload="metadata" playsInline className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-zinc-400">
            {clip.status === "failed" ? <span className="text-red-300">{clip.error}</span> : <span className="animate-pulse">{STAGE[clip.stage ?? ""] ?? "Working…"}</span>}
          </div>
        )}
        <div className="pointer-events-none absolute left-2 top-2 flex gap-1">
          {clip.score != null && <span className={`rounded-md bg-black/75 px-2 py-1 text-xs font-black ${scoreColor}`}>{clip.score}/10</span>}
          {clip.duration != null && <span className="rounded-md bg-black/75 px-2 py-1 text-xs font-bold">{Math.round(clip.duration)}s</span>}
          <span className="rounded-md bg-black/75 px-2 py-1 text-xs font-bold text-zinc-300">{clip.source === "chat" ? `Chat spike ${clip.spikeScore}x` : "Twitch clip"}</span>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
          <a href={`https://twitch.tv/${clip.streamer.login}`} target="_blank" className="font-bold text-zinc-200 hover:text-hot">{clip.streamer.name}</a>
          {clip.sourceUrl && (
            <a href={clip.sourceUrl} target="_blank" className="hover:text-white">
              {clip.source === "chat" ? "Watch on Twitch ↗" : `${clip.sourceViews.toLocaleString()} views on Twitch ↗`}
            </a>
          )}
        </div>
        {clip.judgeReason && (
          <div className="rounded-lg bg-ink px-2.5 py-2 text-xs leading-relaxed text-zinc-300">
            <span className="font-bold text-zinc-100">Judge{clip.score != null ? ` · ${clip.score}/10` : ""}:</span> {clip.judgeReason}
            {clip.hook && <div className="mt-1 text-zinc-400">Hook on video: “{clip.hook}”</div>}
          </div>
        )}
        <input className="field font-semibold" value={title} onChange={(e) => { setTitle(e.target.value); setSaved(false); }} onBlur={save} maxLength={100} />
        <textarea className="field min-h-28 text-xs leading-relaxed" value={caption} onChange={(e) => { setCaption(e.target.value); setSaved(false); }} onBlur={save} />
        {!caption.includes(`twitch.tv/${clip.streamer.login}`) && (
          <div className="text-xs text-sun">⚠ Caption must credit twitch.tv/{clip.streamer.login}</div>
        )}

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {clip.status === "pending" && <>
            <button className="btn-ok flex-1" disabled={busy} onClick={() => act(() => setClipStatus(clip.id, "approved"))}>
              {yt.connected && yt.auto ? `Approve + post to YouTube (${yt.privacy})` : "Approve"}
            </button>
            <button className="btn-bad flex-1" disabled={busy} onClick={() => act(() => setClipStatus(clip.id, "rejected"))}>Reject</button>
          </>}
          {clip.status === "rejected" && <button className="btn-ghost flex-1" disabled={busy} onClick={() => act(() => setClipStatus(clip.id, "pending"))}>Back to review</button>}
          {clip.status === "failed" && <button className="btn-hot flex-1" disabled={busy} onClick={() => act(() => retryClip(clip.id))}>Retry</button>}
          {clip.hasVideo && <a className="btn-ghost flex-1" href={`/api/media/${clip.id}?download=1`}>Download</a>}
          <button className="btn-ghost flex-1" onClick={copy}>{copied ? "Copied ✓" : "Copy caption"}</button>
        </div>

        {reviewed && (
          <div className="mt-1 space-y-2 border-t border-line pt-3">
            {clip.posts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 text-xs">
                {clip.posts.map((p, i) => p.url
                  ? <a key={i} href={p.url} target="_blank" className="rounded-full bg-emerald-500/15 px-2 py-1 font-bold text-emerald-300">✓ {PLATFORM[p.platform] ?? p.platform} ↗</a>
                  : <span key={i} className="rounded-full bg-emerald-500/15 px-2 py-1 font-bold text-emerald-300">✓ {PLATFORM[p.platform] ?? p.platform}</span>)}
              </div>
            )}
            {uploading && <div className="animate-pulse text-xs text-sun">Uploading to YouTube…</div>}
            {clip.postError && <div className="text-xs text-red-300">YouTube upload failed: {clip.postError}</div>}
            {yt.connected && !onYouTube && !uploading && (
              <button className="btn-hot w-full" disabled={busy} onClick={() => act(() => uploadToYouTube(clip.id))}>
                {clip.postError ? "Retry YouTube upload" : `Upload to YouTube (${yt.privacy})`}
              </button>
            )}
            <form action={(fd) => act(() => markPosted(clip.id, fd))} className="flex gap-2">
              <select name="platform" className="field w-24 shrink-0">
                <option value="tiktok">TikTok</option><option value="instagram">Reels</option><option value="youtube">Shorts</option>
              </select>
              <input name="url" placeholder="Post link (optional)" className="field" />
              <button className="btn-ghost shrink-0">Posted</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
