"use client";
import { useActionState, useState } from "react";
import { approveSuggestion, dismissSuggestion } from "../../app/actions";

/** Approve (with a written reason) or "Not now". `prefill` is only ever a real quote from their bio / title. */
export function SuggestionActions({ id, name, prefill }: { id: string; name: string; prefill: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(approveSuggestion.bind(null, id), null);
  if (state?.ok) return <div className="text-sm text-emerald-300">{state.ok}</div>;
  if (!open) {
    return (
      <div className="flex gap-2">
        <button type="button" onClick={() => setOpen(true)} className="btn-hot flex-1">Approve…</button>
        <form action={dismissSuggestion.bind(null, id)} className="flex-1">
          <button className="btn-ghost w-full" title="Hide for 30 days">Not now</button>
        </form>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-2">
      <label className="block text-xs text-zinc-400" htmlFor={`note-${id}`}>Why is {name} approved?</label>
      <input id={`note-${id}`} name="note" defaultValue={prefill} autoFocus required
        placeholder="e.g. “Panels say clippers welcome”, “Paid campaign on Whop”" className="field" />
      <div className="flex gap-2">
        <button className="btn-ok flex-1" disabled={pending}>{pending ? "Approving…" : "Confirm approve"}</button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost">Cancel</button>
      </div>
      {state?.error && <div className="text-sm text-red-300">{state.error}</div>}
    </form>
  );
}
