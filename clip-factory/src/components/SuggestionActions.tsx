"use client";
import { useActionState } from "react";
import { approveSuggestion, dismissSuggestion } from "../../app/actions";

/** One-click Approve (no reason needed; the card's permission quote is kept as the note when there is one) or "Not now". */
export function SuggestionActions({ id, name }: { id: string; name: string }) {
  const [state, action, pending] = useActionState(approveSuggestion.bind(null, id), null);
  if (state?.ok) return <div className="text-sm text-emerald-300">{state.ok}</div>;
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <form action={action} className="flex-1">
          <button className="btn-hot w-full" disabled={pending} aria-label={`Approve ${name}`}>{pending ? "Approving…" : "Approve"}</button>
        </form>
        <form action={dismissSuggestion.bind(null, id)} className="flex-1">
          <button className="btn-ghost w-full" title="Hide for 30 days">Not now</button>
        </form>
      </div>
      {state?.error && <div className="text-sm text-red-300">{state.error}</div>}
    </div>
  );
}
