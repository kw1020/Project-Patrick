"use client";
import { useState, useTransition } from "react";
import { markPosted, retryClip, setClipStatus, updateClipText } from "../../app/actions";

export type ClipView = {
  id: string; status: string; stage: string | null; error: string | null; title: string; caption: string;
  duration: number | null; score: number | null; transcript: string | null; hasVideo: boolean;
  streamer: { name: string; login: string }; sourceUrl: string | null; sourceViews: number; createdAt: string;
};

export function ClipCard({ clip }: { clip: ClipView }) {
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

  return (
    <div className={`card flex flex-col overflow-hidden ${busy ? "opacity-60" : ""}`}>
      <div className="relative aspect-[9/16] w-full bg-black">
        {clip.hasVideo ? (
          <video src={`/api/media/${clip.id}`} controls preload="metadata" playsInline className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-zinc-400">
            {clip.status === "failed" ? <span className="text-red-300">{clip.error}</span> : <span className="animate-pulse">{clip.stage === "cut" ? "Cutting + captioning…" : "Grabbing video…"}</span>}
          </div>
        )}
        <div className="pointer-events-none absolute left-2 top-2 flex gap-1">
          {clip.score != null && <span className="rounded-md bg-black/70 px-2 py-1 text-xs font-black text-sun">{clip.score}/10</span>}
          {clip.duration != null && <span className="rounded-md bg-black/70 px-2 py-1 text-xs font-bold">{Math.round(clip.duration)}s</span>}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <a href={`https://twitch.tv/${clip.streamer.login}`} target="_blank" className="font-bold text-zinc-200 hover:text-hot">{clip.streamer.name}</a>
          {clip.sourceUrl && <a href={clip.sourceUrl} target="_blank" className="hover:text-white">{clip.sourceViews.toLocaleString()} views on Twitch ↗</a>}
        </div>
        <input className="field font-semibold" value={title} onChange={(e) => { setTitle(e.target.value); setSaved(false); }} onBlur={save} maxLength={100} />
        <textarea className="field min-h-28 text-xs leading-relaxed" value={caption} onChange={(e) => { setCaption(e.target.value); setSaved(false); }} onBlur={save} />
        {!caption.includes(`twitch.tv/${clip.streamer.login}`) && (
          <div className="text-xs text-sun">⚠ Caption must credit twitch.tv/{clip.streamer.login}</div>
        )}

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {clip.status === "pending" && <>
            <button className="btn-ok flex-1" disabled={busy} onClick={() => act(() => setClipStatus(clip.id, "approved"))}>Approve</button>
            <button className="btn-bad flex-1" disabled={busy} onClick={() => act(() => setClipStatus(clip.id, "rejected"))}>Reject</button>
          </>}
          {clip.status === "rejected" && <button className="btn-ghost flex-1" disabled={busy} onClick={() => act(() => setClipStatus(clip.id, "pending"))}>Back to review</button>}
          {clip.status === "failed" && <button className="btn-hot flex-1" disabled={busy} onClick={() => act(() => retryClip(clip.id))}>Retry</button>}
          {clip.hasVideo && <a className="btn-ghost flex-1" href={`/api/media/${clip.id}?download=1`}>Download</a>}
          <button className="btn-ghost flex-1" onClick={copy}>{copied ? "Copied ✓" : "Copy caption"}</button>
        </div>

        {clip.status === "approved" && (
          <form action={(fd) => act(() => markPosted(clip.id, fd))} className="mt-1 flex gap-2 border-t border-line pt-3">
            <select name="platform" className="field w-28 shrink-0">
              <option value="tiktok">TikTok</option><option value="youtube">Shorts</option><option value="instagram">Reels</option>
            </select>
            <input name="url" placeholder="Post link (optional)" className="field" />
            <button className="btn-hot shrink-0">Posted</button>
          </form>
        )}
      </div>
    </div>
  );
}
