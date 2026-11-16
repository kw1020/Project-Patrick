import { getSettings } from "@/lib/db";
import { saveSettings } from "../actions";

export const dynamic = "force-dynamic";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 sm:grid-cols-[16rem_1fr] sm:items-center sm:gap-4">
      <div><div className="text-sm font-semibold">{label}</div>{hint && <div className="text-xs text-zinc-500">{hint}</div>}</div>
      <div>{children}</div>
    </label>
  );
}

export default async function SettingsPage() {
  const s = await getSettings();
  return (
    <form action={saveSettings} className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-black">Settings</h1>
        <p className="text-sm text-zinc-400">Changes apply to the next clips the line makes.</p>
      </div>
      <div className="card space-y-4 p-5">
        <div className="text-xs font-bold uppercase tracking-wide text-zinc-400">Clips</div>
        <Row label="Clip length (seconds)" hint="Shorter sources are kept whole."><div className="flex items-center gap-2"><input name="clipMinSec" type="number" defaultValue={s.clipMinSec} className="field w-24" /> to <input name="clipMaxSec" type="number" defaultValue={s.clipMaxSec} className="field w-24" /></div></Row>
        <Row label="Min Twitch clip views" hint="Only grab viewer clips with at least this many views."><input name="minClipViews" type="number" defaultValue={s.minClipViews} className="field w-32" /></Row>
        <Row label="Look back (hours)" hint="How old a Twitch clip can be."><input name="clipLookbackHrs" type="number" defaultValue={s.clipLookbackHrs} className="field w-32" /></Row>
        <Row label="Vertical layout" hint="Facecam needs the box set per streamer; falls back to blur.">
          <select name="layout" defaultValue={s.layout} className="field w-56"><option value="blur">Blurred background</option><option value="facecam">Facecam on top</option></select>
        </Row>
        <Row label="Burn captions"><input name="captions" type="checkbox" defaultChecked={s.captions} className="h-5 w-5 accent-[#ff3d81]" /></Row>
      </div>
      <div className="card space-y-4 p-5">
        <div className="text-xs font-bold uppercase tracking-wide text-zinc-400">Phase 2 (saved now, used once the spike detector + Judge ship)</div>
        <Row label="Spike sensitivity" hint="Flag when chat msgs/sec hits this many × the 5-min average."><input name="spikeMultiplier" type="number" step="0.1" defaultValue={s.spikeMultiplier} className="field w-32" /></Row>
        <Row label="Judge min score" hint="Auto-reject clips the Judge scores below this (1–10)."><input name="minScore" type="number" step="0.5" defaultValue={s.minScore} className="field w-32" /></Row>
      </div>
      <div className="card space-y-4 p-5">
        <Row label="Pause the Scout" hint="Stops new clips. The queue still works."><input name="scoutPaused" type="checkbox" defaultChecked={s.scoutPaused} className="h-5 w-5 accent-[#ff3d81]" /></Row>
      </div>
      <button className="btn-hot">Save settings</button>
    </form>
  );
}
