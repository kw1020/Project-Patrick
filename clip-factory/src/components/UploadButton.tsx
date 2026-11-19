"use client";
import { useState, useTransition } from "react";
import { postToAll } from "../../app/actions";
import type { UploadButtonState } from "../lib/channels";

/**
 * v2.0.6 (Krew: "a button for YouTube that says upload and just uploads it"): the always-visible Upload button on approved Queue
 * cards and Upload cards. Connected → one click uploads to every connected account of the channel; not connected → it goes to
 * Connect YouTube for this clip's channel and uploads when Google sends Krew back; keys missing / blocked → disabled, and the
 * "Why can't I upload?" line says why.
 */
export function UploadButton({ clipId, channelId, state, ytUrl, uploading, big = true }: {
  clipId: string; channelId: string | null; state: UploadButtonState; ytUrl?: string | null; uploading?: boolean; big?: boolean;
}) {
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cls = `${big ? "py-3 text-lg" : "py-2 text-sm"} w-full font-black`;
  const upload = () => start(async () => {
    setErr(null); setMsg(null);
    try {
      const r = await postToAll(clipId, channelId!);
      setMsg(r.queued.length ? `Uploading to ${r.queued.join(", ")}…${r.byHand.length ? ` (${r.byHand.join(", ")}: by hand)` : ""}` : "Nothing to upload: the rest are by hand.");
    } catch (e) { setErr((e as Error).message); }
  });
  return (
    <div className="space-y-1" data-testid="upload-button">
      {state.kind === "upload" && (
        <button className={`btn-hot ${cls}`} disabled={busy || uploading || !channelId} onClick={upload}>{busy || uploading ? "Uploading…" : state.label}</button>
      )}
      {state.kind === "connect" && (
        <a className={`btn-hot block text-center ${cls}`} href={state.href} title="Signs in to this channel's YouTube, then uploads this clip">{state.label}</a>
      )}
      {(state.kind === "keys" || state.kind === "blocked") && <button className={`btn-hot ${cls}`} disabled>{state.label}</button>}
      {state.kind === "done" && ytUrl && <a href={ytUrl} target="_blank" className={`btn-ok block text-center ${cls}`}>Live on YouTube ✓ ↗</a>}
      {state.kind === "done" && !ytUrl && <div className="text-center text-sm font-bold text-emerald-300">Live on YouTube ✓</div>}
      {state.kind !== "done" && ytUrl && <a href={ytUrl} target="_blank" className="block text-xs font-bold text-emerald-300">Live on YouTube ✓ ↗</a>}
      {state.restNow > 0 && state.kind !== "upload" && (
        <button className="btn-ghost w-full py-1 text-xs" disabled={busy || uploading || !channelId} onClick={upload}>Upload to the {state.restNow} connected account{state.restNow === 1 ? "" : "s"} now</button>
      )}
      {state.why && <div className="text-xs text-amber-200 [overflow-wrap:anywhere]" data-testid="why-cant-upload"><b>Why can&apos;t I upload?</b> {state.why}</div>}
      {msg && <div className="text-xs text-emerald-300 [overflow-wrap:anywhere]">{msg}</div>}
      {err && <div className="text-xs text-red-300 [overflow-wrap:anywhere]">{err}</div>}
    </div>
  );
}
