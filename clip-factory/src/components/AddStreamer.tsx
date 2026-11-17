"use client";
import { useActionState } from "react";
import { addStreamer, addYouTubeChannel } from "../../app/actions";

export function AddStreamer({ prefill }: { prefill?: string }) {
  const [state, action, pending] = useActionState(addStreamer, null);
  return (
    <form action={action} className="card space-y-3 p-4">
      <div className="font-bold">Approve a streamer</div>
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
        <input name="login" defaultValue={prefill} placeholder="Twitch username or link" className="field" required />
        <input name="note" aria-label="Note (optional)" placeholder="Note (optional), e.g. “Paid clip campaign on Vyro”" className="field" />
        <button className="btn-hot" disabled={pending}>{pending ? "Checking…" : "Approve"}</button>
      </div>
      {state?.error && <div className="text-sm text-red-300">{state.error}</div>}
      {state?.ok && <div className="text-sm text-emerald-300">{state.ok}</div>}
      <p className="text-xs text-zinc-500">Only clip streamers who opted in, run a paid clipping campaign, or publicly allow clippers. A note is handy proof if a clip gets claimed.</p>
    </form>
  );
}

export function AddYouTubeChannel() {
  const [state, action, pending] = useActionState(addYouTubeChannel, null);
  return (
    <form action={action} className="card space-y-3 p-4">
      <div className="font-bold">Approve a YouTube channel</div>
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
        <input name="channel" placeholder="@handle or channel link" className="field" required />
        <input name="note" aria-label="Note (optional)" placeholder="Note (optional), e.g. “Clipping campaign on Whop”" className="field" />
        <button className="btn-hot" disabled={pending}>{pending ? "Checking…" : "Approve"}</button>
      </div>
      {state?.error && <div className="text-sm text-red-300">{state.error}</div>}
      {state?.ok && <div className="text-sm text-emerald-300">{state.ok}</div>}
      <p className="text-xs text-zinc-500">The YouTube scanner cuts the most-replayed moments of their newest long videos. Only approve creators who allow clipping or run a clipping campaign.</p>
    </form>
  );
}
