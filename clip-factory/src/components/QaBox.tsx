"use client";
import { useState, useTransition } from "react";
import { checkVideo, fixClip } from "../../app/actions";
import type { QaResult } from "../lib/qa";

const TYPE: Record<string, string> = {
  bad_cut: "Bad cut", caption_over_face: "Caption over face", cam_crop: "Webcam crop", frozen: "Frozen", black: "Black screen",
  audio: "Audio", credit_missing: "Credit missing", ending: "Ending", other: "Other",
};
const FIX: Record<string, string> = {
  recut_no_jumpcuts: "re-cut without jump cuts", recut_layout_blur: "re-cut in Blurred background", recut_layout_split: "re-cut as cam on top",
  recut_layout_fullcam: "re-cut as full cam", recut_style_clean: "re-cut in Clean style", extend_end: "2s longer at the end",
};

/** v1.9.6 Supreme Judge video check on a clip card: "Checked ✓", or the issues + Fix it; "Check video" runs it (again). */
export function QaBox({ clipId, qa, hasVideo, canRecut, busy: outerBusy }: { clipId: string; qa: QaResult | null; hasVideo: boolean; canRecut: boolean; busy?: boolean }) {
  const [busy, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>, done: string) => start(async () => { try { await fn(); setNote(done); } catch (e) { setNote((e as Error).message); } });
  if (!hasVideo) return null;
  const fixes = qa ? [...new Set(qa.issues.map((i) => i.fix).filter((f) => f !== "none"))] : [];
  const disabled = busy || outerBusy;
  return (
    <div className="space-y-1.5 text-xs" data-testid="qa-box">
      {qa && (qa.ok ? (
        <div className="rounded-lg bg-emerald-500/10 px-2.5 py-1.5 font-bold text-emerald-300" title={`Checked: ${qa.checks.join(", ")}${qa.vision === "done" ? ` + ${qa.frames} frames watched` : ""}`}>
          Checked ✓{qa.vision !== "done" && <span className="ml-1 font-normal text-zinc-400">(free checks only)</span>}
        </div>
      ) : (
        <div className="space-y-1 rounded-lg border border-sun/40 bg-sun/10 px-2.5 py-2 text-amber-100" data-testid="qa-issues">
          <div className="font-bold">⚠️ Video check found {qa.issues.length} issue{qa.issues.length === 1 ? "" : "s"}</div>
          <ul className="space-y-0.5">
            {qa.issues.map((i, k) => (
              <li key={k} className="[overflow-wrap:anywhere]"><b>{TYPE[i.type] ?? i.type}</b>{i.at_sec != null ? ` at ${i.at_sec}s` : ""}: {i.detail}{i.fix !== "none" ? <span className="text-amber-300/80"> → {FIX[i.fix]}</span> : null}</li>
            ))}
          </ul>
          {fixes.length > 0 && canRecut && (
            <button className="btn-hot w-full py-1 text-xs" disabled={disabled} data-testid="fix-it"
              onClick={() => run(() => fixClip(clipId), "Re-cutting with the fix… it's checked again when done.")}>Fix it</button>
          )}
        </div>
      ))}
      {qa?.visionNote && <div className="text-[11px] text-zinc-500">{qa.visionNote}</div>}
      <button className="btn-ghost w-full py-1 text-xs" disabled={disabled} onClick={() => run(() => checkVideo(clipId), "Checking… refresh in a minute.")}>
        {qa ? "Check video again" : "Check video"}
      </button>
      {note && <div className="text-[11px] text-zinc-400">{note}</div>}
    </div>
  );
}
