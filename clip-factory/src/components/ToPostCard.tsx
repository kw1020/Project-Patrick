"use client";
import { useState, useTransition } from "react";
import { markPostedToAccount, postToAccount, postToAll, setClipChannel } from "../../app/actions";
import { PLATFORM_LABEL, downloadUrl } from "../lib/channels";
import { checkCampaignCaption } from "../lib/social";
import { CategoryChip } from "./CategoryChip";

export type ToPostRow = {
  accountId: string; platform: string; label: string; action: "post" | "tiktok" | "manual"; error: string | null; disabled?: boolean;
  done: { status: string; url: string | null } | null;
};
export type ToPostView = {
  id: string; title: string; caption: string; score: number | null; judgeReason: string | null; hasVideo: boolean; version: number;
  stage: string | null; postError: string | null; category: string | null; duration: number | null;
  streamer: { name: string; login: string };
  campaign: { name: string; link: string | null; requiredText: string | null; bannedWords: string | null; maxCaptionChars: number | null } | null;
  channelId: string | null; chosenChannelId: string | null; channelName: string | null;
  rows: ToPostRow[];
  supreme?: { rank: number | null; reason: string | null } | null;
};

const chip: Record<string, string> = {
  youtube: "bg-red-600/20 text-red-300", tiktok: "bg-cyan-500/15 text-cyan-300", instagram: "bg-fuchsia-500/15 text-fuchsia-300",
};

/** Copies the caption and starts the download in one click (the media route sends it as an attachment). */
export async function downloadAndCopy(clipId: string, caption: string) {
  try { await navigator.clipboard.writeText(caption); } catch { /* clipboard blocked: the caption box is still there */ }
  const a = document.createElement("a");
  a.href = downloadUrl(clipId);
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ToPostCard({ clip, channels, children }: { clip: ToPostView; channels: { id: string; name: string }[]; children?: React.ReactNode }) {
  const [busy, start] = useTransition();
  const [copied, setCopied] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => start(async () => { setErr(null); try { await fn(); } catch (e) { setErr((e as Error).message); } });
  const flash = (k: string) => { setCopied(k); setTimeout(() => setCopied(null), 1600); };
  const left = clip.rows.filter((r) => !r.done && !r.disabled);
  const autoLeft = left.filter((r) => r.action !== "manual" && !r.error);
  const manualLeft = left.filter((r) => r.action === "manual" || r.error);
  const uploading = clip.stage === "post";
  const checks = clip.campaign ? checkCampaignCaption(clip.caption, clip.campaign) : [];

  return (
    <article className={`card flex min-w-0 flex-col overflow-hidden ${busy ? "opacity-70" : ""}`} data-testid="to-post-card">
      {/* v1.9.5 Upload columns: one card per clip in its channel's column, preview on top (fits a Chromebook screen). */}
      <div className="relative flex h-[22rem] w-full shrink-0 justify-center bg-black">
        {clip.hasVideo
          ? <video src={`/api/media/${clip.id}?v=${clip.version}`} controls preload="metadata" playsInline className="h-full max-w-full object-contain" />
          : <div className="grid h-full place-items-center p-4 text-center text-sm text-zinc-400">Video not found</div>}
        <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap gap-1">
          {clip.score != null && <span className="rounded-md bg-black/75 px-2 py-1 text-xs font-black text-emerald-300">{clip.score}/10</span>}
          {clip.duration != null && <span className="rounded-md bg-black/75 px-2 py-1 text-xs font-bold">{Math.round(clip.duration)}s</span>}
          {clip.category && <span className="rounded-md bg-black/75"><CategoryChip category={clip.category} className="inline-block px-2 py-1 text-xs" /></span>}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-3">
        {clip.supreme && (
          <div className="rounded-lg border border-sun/40 bg-sun/10 px-2.5 py-1.5 text-xs text-amber-100" data-testid="supreme-pick">
            <b>⭐ Supreme pick{clip.supreme.rank != null ? ` #${clip.supreme.rank}` : ""}</b>{clip.supreme.reason ? `: ${clip.supreme.reason}` : ""}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 truncate text-sm font-bold">{clip.streamer.name}</div>
          <select aria-label="Move to channel" className="field w-36 py-1 text-xs" value="" disabled={busy} data-testid="move-to"
            onChange={(e) => { const v = e.target.value; if (v) run(() => setClipChannel(clip.id, v === "auto" ? "" : v)); }}>
            <option value="">Move to…</option>
            {channels.filter((c) => c.id !== clip.channelId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {clip.chosenChannelId && <option value="auto">Automatic (by type)</option>}
          </select>
        </div>
        {clip.judgeReason && <div className="line-clamp-2 text-xs text-zinc-400" title={clip.judgeReason}>{clip.judgeReason}</div>}

        <div className="relative">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-ink p-2.5 pr-16 text-xs leading-relaxed text-zinc-200 [overflow-wrap:anywhere]" data-testid="final-caption">{clip.caption}</pre>
          <button className="btn-ghost absolute right-1.5 top-1.5 px-2 py-0.5 text-xs" onClick={async () => { await navigator.clipboard.writeText(clip.caption).catch(() => {}); flash("caption"); }}>
            {copied === "caption" ? "Copied ✓" : "Copy"}
          </button>
        </div>
        {checks.length > 0 && (
          <div className="space-y-0.5 text-xs" data-testid="campaign-checks">
            <div className="font-bold text-zinc-300">Campaign: {clip.campaign!.name}{clip.campaign!.link && <a href={clip.campaign!.link} target="_blank" className="ml-1 font-normal text-hot">open ↗</a>}</div>
            {checks.map((r, i) => <div key={i} className={`[overflow-wrap:anywhere] ${r.ok ? "text-emerald-300" : "text-sun"}`}>{r.ok ? "✅" : "⚠️"} {r.rule}</div>)}
          </div>
        )}

        {!clip.channelId ? (
          <div className="rounded-lg bg-sun/10 px-3 py-2 text-xs text-amber-200">No channel takes this clip automatically. Use Move to… (or add a channel in Settings).</div>
        ) : clip.rows.length === 0 ? (
          <div className="rounded-lg bg-sun/10 px-3 py-2 text-xs text-amber-200">{clip.channelName} has no accounts yet. Add its YouTube / TikTok / Instagram in <a href="/settings#channels" className="underline">Settings</a>.</div>
        ) : (
          <div className="space-y-2">
            {left.length > 0 && (
              <button className="btn-hot w-full" disabled={busy || uploading || clip.stage === "cut"} data-testid="post-to-all"
                onClick={() => run(async () => {
                  const r = await postToAll(clip.id, clip.channelId!);
                  setMsg(r.queued.length ? `Sending to ${r.queued.join(", ")}…${r.byHand.length ? " Then do the by-hand ones below." : ""}` : "Nothing to upload: do the by-hand ones below.");
                })}>
                Post to all on {clip.channelName}{autoLeft.length ? ` (${autoLeft.map((r) => PLATFORM_LABEL[r.platform]).join(" + ")} now${manualLeft.length ? `, ${manualLeft.length} by hand` : ""})` : " (by hand)"}
              </button>
            )}
            {msg && <div className="text-xs text-emerald-300">{msg}</div>}
            {uploading && <div className="animate-pulse text-xs text-sun">Uploading…</div>}
            {clip.postError && <div className="text-xs text-red-300 [overflow-wrap:anywhere]">Posting failed: {clip.postError}</div>}
            <ul className="divide-y divide-line rounded-lg border border-line" data-testid="account-rows">
              {clip.rows.map((r) => (
                <li key={r.accountId} className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-xs">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-black uppercase ${chip[r.platform] ?? "bg-zinc-800"}`}>{PLATFORM_LABEL[r.platform] ?? r.platform}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{r.label}</span>
                  {r.disabled && !r.done ? (
                    <span className="text-zinc-500 [overflow-wrap:anywhere]" title="Skipped by Post to all; switch it back on in Settings → Channels">off: {r.error ?? "disabled"}</span>
                  ) : r.done ? (
                    r.done.status === "draft"
                      ? <span className="font-bold text-sun" title="Open TikTok, tap the inbox notification, paste the caption, post.">⏳ draft in TikTok inbox</span>
                      : r.done.url ? <a href={r.done.url} target="_blank" className="font-bold text-emerald-300">✓ posted ↗</a> : <span className="font-bold text-emerald-300">✓ posted</span>
                  ) : r.action === "manual" || r.error ? (
                    <ManualRow clipId={clip.id} row={r} caption={clip.caption} campaign={Boolean(clip.campaign)} busy={busy} run={run} copied={copied === r.accountId} onCopied={() => flash(r.accountId)} />
                  ) : (
                    <button className="btn-ghost py-1 text-xs" disabled={busy || uploading} onClick={() => run(() => postToAccount(clip.id, r.accountId))}
                      title={r.action === "tiktok" ? "Sends it to the TikTok inbox as a draft" : "Uploads it to YouTube now"}>
                      {uploading ? "sending…" : r.action === "tiktok" ? "Send to TikTok" : "Post to YouTube"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {children}
        {err && <div className="text-xs text-red-300 [overflow-wrap:anywhere]">{err}</div>}
      </div>
    </article>
  );
}

function ManualRow({ clipId, row, caption, campaign, busy, run, copied, onCopied }: {
  clipId: string; row: ToPostRow; caption: string; campaign: boolean; busy: boolean; run: (fn: () => Promise<unknown>) => void; copied: boolean; onCopied: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex w-full flex-col gap-1.5">
      {row.error && <span className="text-red-300" title={row.error}>login broken: post by hand</span>}
      <button className="btn-ghost py-1 text-xs" data-testid="download-copy" onClick={async () => { await downloadAndCopy(clipId, caption); onCopied(); setOpen(true); }}>
        {copied ? "Downloading · caption copied ✓" : "Download + copy caption"}
      </button>
      {open || !campaign ? (
        <form className="flex min-w-0 flex-wrap gap-1.5" action={(fd) => run(() => markPostedToAccount(clipId, row.accountId, fd))}>
          <input name="url" placeholder="Post link (optional)" className="field w-40 min-w-0 flex-1 py-1 text-xs" />
          {campaign && <input name="campaignLink" placeholder="Campaign link (optional)" className="field w-40 min-w-0 flex-1 py-1 text-xs" />}
          <button className="btn-ok py-1 text-xs" disabled={busy}>Mark posted</button>
        </form>
      ) : (
        <button className="btn-ok py-1 text-xs" onClick={() => setOpen(true)}>Mark posted…</button>
      )}
    </div>
  );
}
