"use client";
import { useState, useTransition } from "react";
import { deleteEdit, remakeEdit, retryEdit, setEditStatus, updateEditText } from "../../app/edit-actions";
import { STAGE_LABEL, formatLabel, vibeLabel } from "../lib/edit-vibes";
import { captionCredits, creatorHandle, creatorUrl } from "../lib/social";

export type EditView = {
  id: string; status: string; stage: string | null; error: string | null; postError: string | null; format: string; vibe: string;
  lengthSec: number; duration: number | null; bpm: number; timingTrack: string | null; startAt: string | null; creatorAudio: boolean;
  title: string; caption: string; hasVideo: boolean; hasBeat: boolean; version: number; slices: number | null;
  streamer: { name: string; login: string; platform: string };
  /** v2.0.5 Top 5: the theme label + every creator in it (null / [] for montages and clip edits). */
  theme?: string | null; creators?: { login: string; name: string; platform: string }[];
  posts: { platform: string; accountId: string | null; status: string; url: string | null; error: string | null }[];
};

const PLATFORM: Record<string, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Reels" };

export function EditCard({ edit, channelName }: { edit: EditView; channelName: string | null }) {
  const [withBeat, setWithBeat] = useState(false);
  const [title, setTitle] = useState(edit.title);
  const [caption, setCaption] = useState(edit.caption);
  const [copied, setCopied] = useState(false);
  const [busy, start] = useTransition();
  const dirty = title !== edit.title || caption !== edit.caption;
  const act = (fn: () => Promise<unknown>) => start(async () => { if (dirty) await updateEditText(edit.id, title, caption); await fn(); });
  const copy = async () => { await navigator.clipboard.writeText(caption); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const reviewed = edit.status === "approved" || edit.status === "posted";
  const sending = edit.stage === "post";
  const src = `/api/media/edit/${edit.id}?variant=${withBeat ? "beat" : "final"}&v=${edit.version}`;
  const chip = "rounded-md bg-black/75 px-2 py-1 text-xs font-bold";
  const top5 = edit.format === "top5";
  const credited = (top5 && edit.creators?.length ? edit.creators : [edit.streamer]).filter((c) => !captionCredits(caption, c));
  return (
    <div className={`card flex flex-col overflow-hidden ${busy ? "opacity-60" : ""}`} data-testid="edit-card">
      <div className="relative aspect-[9/16] w-full bg-black">
        {edit.hasVideo ? (
          <video key={src} src={src} controls preload="metadata" playsInline className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-zinc-400">
            {edit.status === "failed" ? <span className="text-red-300">{edit.error}</span>
              : edit.status === "processing" ? <span className="animate-pulse">{STAGE_LABEL[edit.stage ?? ""] ?? "Working"}…</span>
              : <span>Video expired (deleted to save space)</span>}
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap gap-1">
          <span className={`${chip} text-hot`}>Edit</span>
          <span className={chip}>{formatLabel(edit.format)}</span>
          {top5 ? <span className={`${chip} text-zinc-300`}>{edit.theme}</span> : <span className={`${chip} text-zinc-300`}>{vibeLabel(edit.vibe)}</span>}
          <span className={chip}>{Math.round(edit.duration ?? edit.lengthSec)}s</span>
          {!top5 && <span className={`${chip} text-zinc-300`}>{Math.round(edit.bpm)} BPM{edit.timingTrack ? " · song" : ""}</span>}
          {withBeat && <span className={`${chip} text-red-300`}>Preview with beat</span>}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
          {top5 && edit.creators?.length
            ? <span className="truncate font-bold text-zinc-200">{edit.creators.map((c) => c.name).join(", ")}</span>
            : <a href={creatorUrl(edit.streamer)} target="_blank" className="font-bold text-zinc-200 hover:text-hot">{edit.streamer.name}</a>}
          <span>{top5 ? "5 moments" : edit.slices ? `${edit.slices} cuts` : ""}{edit.creatorAudio ? "" : " · no creator audio"}</span>
        </div>
        {edit.hasBeat && (
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={withBeat} onChange={(e) => setWithBeat(e.target.checked)} className="h-4 w-4 accent-[#ff3d81]" />
            Play with beat <span className="text-zinc-500">(to check the timing — don&apos;t post that one)</span>
          </label>
        )}
        {edit.timingTrack && edit.startAt && (
          <div className="rounded-lg bg-ink px-2.5 py-2 text-xs text-zinc-300">Cut to <b>{edit.timingTrack}</b>. In TikTok, start the sound at <b>{edit.startAt}</b>.</div>
        )}
        <input className="field font-semibold" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => dirty && start(() => updateEditText(edit.id, title, caption))} maxLength={100} />
        <textarea className="field min-h-24 text-xs leading-relaxed" value={caption} onChange={(e) => setCaption(e.target.value)} onBlur={() => dirty && start(() => updateEditText(edit.id, title, caption))} />
        {credited.length > 0 && <div className="text-xs text-sun">⚠ Caption must credit {credited.map(creatorHandle).join(" ")}</div>}
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {edit.status === "pending" && <>
            <button className="btn-ok flex-1" disabled={busy} onClick={() => act(() => setEditStatus(edit.id, "approved"))}>Approve</button>
            <button className="btn-bad flex-1" disabled={busy} onClick={() => act(() => setEditStatus(edit.id, "rejected"))}>Reject</button>
          </>}
          {edit.status === "rejected" && edit.hasVideo && <button className="btn-ghost flex-1" disabled={busy} onClick={() => act(() => setEditStatus(edit.id, "pending"))}>Back to review</button>}
          {edit.status === "failed" && <button className="btn-hot flex-1" disabled={busy} onClick={() => act(() => retryEdit(edit.id))}>Retry</button>}
          {edit.hasVideo && <a className="btn-ghost flex-1" href={`/api/media/edit/${edit.id}?download=1`}>Download</a>}
          <button className="btn-ghost flex-1" onClick={copy}>{copied ? "Copied ✓" : "Copy caption"}</button>
          {edit.status !== "processing" && <button className="btn-ghost flex-1" disabled={busy} title="Same settings, other moments" onClick={() => act(() => remakeEdit(edit.id))}>Re-make</button>}
          {(edit.status === "rejected" || edit.status === "failed") && <button className="btn-ghost" disabled={busy} title="Delete this edit" onClick={() => act(() => deleteEdit(edit.id))}>✕</button>}
        </div>
        {reviewed && (
          <div className="mt-1 space-y-2 border-t border-line pt-3">
            <div className="text-xs text-sun">Add your sound in TikTok/Reels before posting.</div>
            {edit.posts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 text-xs">
                {edit.posts.map((p, i) => {
                  const name = PLATFORM[p.platform] ?? p.platform;
                  if (p.status === "draft") return <span key={i} className="rounded-full bg-sun/15 px-2 py-1 font-bold text-sun">⏳ {name}: draft in your TikTok inbox</span>;
                  if (p.status === "failed") return <span key={i} title={p.error ?? ""} className="rounded-full bg-red-500/15 px-2 py-1 font-bold text-red-300">✕ {name}</span>;
                  return p.url ? <a key={i} href={p.url} target="_blank" className="rounded-full bg-emerald-500/15 px-2 py-1 font-bold text-emerald-300">✓ {name} ↗</a>
                    : <span key={i} className="rounded-full bg-emerald-500/15 px-2 py-1 font-bold text-emerald-300">✓ {name}</span>;
                })}
              </div>
            )}
            {sending && <div className="animate-pulse text-xs text-sun">Sending…</div>}
            {edit.postError && <div className="text-xs text-red-300">Posting failed: {edit.postError}</div>}
            {channelName
              ? <a href="/upload" className="btn-hot block text-center text-sm">Post it from Upload ({channelName} column)</a>
              : <div className="text-xs text-zinc-500">No channel takes Edits yet: tick &ldquo;Edits&rdquo; on your edit channel in Settings → Channels.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
