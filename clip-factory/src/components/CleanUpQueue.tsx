"use client";
import { useState, useTransition } from "react";
import { cleanUpQueueNow } from "../../app/actions";

/** v2.0.6 Queue header: reject every pending clip below the min score (or never scored) in one click, with a two-step confirm. */
export function CleanUpQueue({ minScore, count }: { minScore: number; count: number }) {
  const [busy, start] = useTransition();
  const [sure, setSure] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="clean-up-queue">
      {sure ? (
        <button className="btn-bad" disabled={busy} onClick={() => start(async () => {
          const n = await cleanUpQueueNow();
          setSure(false);
          setMsg(n ? `Cleared ${n} clip${n === 1 ? "" : "s"} (moved to Rejected; their videos are deleted after a few hours).` : "Nothing to clear.");
        })}>Clear {count} clip{count === 1 ? "" : "s"} below {minScore}?</button>
      ) : (
        <button className="btn-ghost" disabled={busy || count === 0} title={`Rejects every clip waiting for review that scored below ${minScore} or was never scored. Approved and posted clips are not touched.`}
          onClick={() => { setMsg(null); setSure(true); }}>Clean up queue{count ? ` (${count})` : ""}</button>
      )}
      {msg && <span className="text-xs text-emerald-300">{msg}</span>}
    </div>
  );
}
