"use client";
// v2.0.0: Queue card button -> a Clip -> Edit of this clip (vibe/tempo/length from Settings). Kept apart from ClipCard on purpose.
import Link from "next/link";
import { useState, useTransition } from "react";
import { makeEditFromClip } from "../../app/edit-actions";

export function MakeEditFromClip({ clipId }: { clipId: string }) {
  const [busy, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  if (done) return <div className="text-xs text-emerald-300">{done} <Link href="/edits" className="underline">See Edits</Link></div>;
  return (
    <button className="btn-ghost w-full text-xs" disabled={busy} data-testid="make-edit-from-clip"
      onClick={() => start(async () => {
        try { await makeEditFromClip(clipId); setDone("Making a Clip → Edit."); } catch (e) { setDone(`Couldn't: ${(e as Error).message}`); }
      })}>
      {busy ? "Starting…" : "Make an edit from this clip"}
    </button>
  );
}
