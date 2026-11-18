"use client";
// v1.9.1 Campaign mode (Whop Content Rewards): the per-creator select and the Campaigns card on the Streamers page.
import { useState, useTransition } from "react";
import { createCampaign, deleteCampaign, saveCampaign, setStreamerCampaign } from "../../app/actions";

export type CampaignView = {
  id: string; name: string; link: string | null; rules: string | null; requiredText: string | null; bannedWords: string | null;
  maxCaptionChars: number | null; active: boolean; creators: number;
};

/** "Campaign" select for one approved creator: None / the campaigns / "+ New campaign…". Saves on change. */
export function CampaignSelect({ streamerId, value, campaigns, className = "" }: { streamerId: string; value: string | null; campaigns: { id: string; name: string; active?: boolean }[]; className?: string }) {
  const [v, setV] = useState(value ?? "");
  const [busy, start] = useTransition();
  return (
    <select aria-label="Campaign" data-testid="campaign-select" className={`field w-44 py-1.5 text-sm ${busy ? "opacity-60" : ""} ${className}`} value={v} disabled={busy}
      onChange={(e) => {
        const next = e.target.value;
        start(async () => { const id = await setStreamerCampaign(streamerId, next); setV(id ?? ""); });
      }}>
      <option value="">No campaign</option>
      {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active === false ? " (paused)" : ""}</option>)}
      <option value="new">+ New campaign…</option>
    </select>
  );
}

function CampaignFields({ c }: { c?: CampaignView }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="grid gap-1 text-xs text-zinc-400">Name<input name="name" defaultValue={c?.name ?? ""} placeholder="e.g. Kai Cenat clips" required maxLength={80} className="field text-sm" /></label>
      <label className="grid gap-1 text-xs text-zinc-400">Whop link<input name="link" defaultValue={c?.link ?? ""} placeholder="https://whop.com/…" className="field text-sm" /></label>
      <label className="grid gap-1 text-xs text-zinc-400 sm:col-span-2">Caption rules (the Judge follows these for the hook)
        <textarea name="rules" defaultValue={c?.rules ?? ""} placeholder="Paste the campaign's caption rules here" className="field min-h-20 text-sm" />
      </label>
      <label className="grid gap-1 text-xs text-zinc-400">Must be in the caption (one per line)
        <textarea name="requiredText" defaultValue={c?.requiredText ?? ""} placeholder={"@kaicenat\n#ad\n#KaiCenatClips"} className="field min-h-20 text-sm" />
      </label>
      <label className="grid gap-1 text-xs text-zinc-400">Banned words (comma or one per line)
        <textarea name="bannedWords" defaultValue={c?.bannedWords ?? ""} placeholder="e.g. free, giveaway" className="field min-h-20 text-sm" />
      </label>
      <label className="grid gap-1 text-xs text-zinc-400">Max caption length (characters, empty = no limit)
        <input name="maxCaptionChars" defaultValue={c?.maxCaptionChars ?? ""} inputMode="numeric" placeholder="e.g. 150" className="field text-sm" />
      </label>
      <label className="flex items-center gap-2 self-end pb-2 text-sm"><input name="active" type="checkbox" defaultChecked={c?.active ?? true} className="h-5 w-5 accent-[#ff3d81]" />Active</label>
    </div>
  );
}

function CampaignRow({ c }: { c: CampaignView }) {
  const [busy, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <form data-testid="campaign-row" className={`space-y-2 px-4 py-4 ${busy ? "opacity-60" : ""}`}
      action={(fd) => start(async () => { await saveCampaign(c.id, fd); setSaved(true); setTimeout(() => setSaved(false), 1500); })}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-bold">{c.name}</span>
        {!c.active && <span className="rounded bg-zinc-800 px-1.5 text-[10px] font-black uppercase text-zinc-400">Paused</span>}
        <span className="text-xs text-zinc-500">{c.creators} creator{c.creators === 1 ? "" : "s"}</span>
        {c.link && <a href={c.link} target="_blank" className="text-xs text-hot [overflow-wrap:anywhere]">Whop ↗</a>}
      </div>
      <CampaignFields c={c} />
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost" disabled={busy}>{saved ? "Saved ✓" : "Save"}</button>
        {confirm ? <>
          <button type="button" className="btn-bad" disabled={busy} onClick={() => start(async () => { await deleteCampaign(c.id); })}>Yes, delete</button>
          <button type="button" className="btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <span className="self-center text-xs text-zinc-400">Its creators go back to “No campaign”.</span>
        </> : <button type="button" className="btn-bad" onClick={() => setConfirm(true)}>Delete</button>}
      </div>
    </form>
  );
}

/** Streamers page: the campaigns, each editable, plus a "New campaign" form. */
export function CampaignsCard({ campaigns }: { campaigns: CampaignView[] }) {
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  return (
    <section className="space-y-2" data-testid="campaigns-card">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-bold">Campaigns ({campaigns.length})</h2>
          <p className="text-xs text-zinc-400">Whop Content Rewards. Tag a creator with a campaign and their captions follow its rules. Nothing is blocked: you decide.</p>
        </div>
        <button type="button" className="btn-hot" onClick={() => setOpen((o) => !o)}>{open ? "Close" : "+ New campaign"}</button>
      </div>
      <div className="card divide-y divide-line">
        {open && (
          <form key={formKey} className={`space-y-2 px-4 py-4 ${busy ? "opacity-60" : ""}`}
            action={(fd) => start(async () => { await createCampaign(fd); setOpen(false); setFormKey((k) => k + 1); })}>
            <div className="text-sm font-bold">New campaign</div>
            <CampaignFields />
            <button className="btn-hot" disabled={busy}>Create</button>
          </form>
        )}
        {campaigns.length === 0 && !open && <div className="p-6 text-sm text-zinc-400">No campaigns yet.</div>}
        {campaigns.map((c) => <CampaignRow key={c.id} c={c} />)}
      </div>
    </section>
  );
}
