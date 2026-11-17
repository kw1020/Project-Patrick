"use client";
import { useState, useTransition } from "react";
import { removeStreamer, setPaused } from "../../app/actions";

/** Pause / Resume and a two-step Remove (the app window never shows confirm() dialogs). */
export function CreatorActions({ id, name, paused }: { id: string; name: string; paused: boolean }) {
  const [asking, setAsking] = useState(false);
  const [busy, start] = useTransition();
  if (asking) {
    return (
      <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1.5" role="alertdialog" aria-label={`Remove ${name}?`}>
        <span className="min-w-0 flex-1 basis-40 text-xs text-red-200">Remove {name}? No new clips from them. Clips already made stay.</span>
        <button className="btn bg-red-600 px-2.5 py-1 text-xs text-white hover:brightness-110" disabled={busy} onClick={() => start(async () => { await removeStreamer(id); })}>
          {busy ? "Removing…" : "Yes, remove"}
        </button>
        <button className="btn-ghost px-2.5 py-1 text-xs" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
      </div>
    );
  }
  return (
    <>
      <button className="btn-ghost px-2.5 py-1 text-xs" disabled={busy} onClick={() => start(async () => { await setPaused(id, !paused); })}
        title={paused ? "Start clipping them again" : "Stop new clips for now; they stay approved"}>
        {paused ? "Resume" : "Pause"}
      </button>
      <button className="btn-bad px-2.5 py-1 text-xs" disabled={busy} onClick={() => setAsking(true)}>Remove</button>
    </>
  );
}
