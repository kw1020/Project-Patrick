"use client";
import { useActionState, useState } from "react";
import { makeEdit, type MakeEditResult } from "../../app/edit-actions";
import { EDIT_LENGTHS, FORMATS, MIN_MOMENTS, VIBES } from "../lib/edit-vibes";

export type CreatorOption = { id: string; name: string; platform: string; usable: number };

export function MakeEditForm({ creators, songs, defaults }: {
  creators: CreatorOption[]; songs: { name: string; mb: number }[];
  defaults: { vibe: string; length: number; bpm: number; creatorAudio: boolean };
}) {
  const [state, action, pending] = useActionState<MakeEditResult | null, FormData>(makeEdit, null);
  const first = creators.find((c) => c.usable >= MIN_MOMENTS)?.id ?? "";
  const [creator, setCreator] = useState(first);
  const [tempo, setTempo] = useState<"steady" | "song">("steady");
  const [format, setFormat] = useState<"montage" | "clipedit">("montage");
  const pick = creators.find((c) => c.id === creator);
  const enough = (pick?.usable ?? 0) >= (format === "clipedit" ? 1 : MIN_MOMENTS);
  return (
    <form action={action} className="card space-y-4 p-5" data-testid="make-edit">
      <div className="text-xs font-bold uppercase tracking-wide text-zinc-400">Make an edit</div>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1">
          <div className="text-sm font-semibold">Creator</div>
          <select name="streamerId" className="field" value={creator} onChange={(e) => setCreator(e.target.value)}>
            {creators.length === 0 && <option value="">No approved creators yet</option>}
            {creators.map((c) => (
              <option key={c.id} value={c.id} disabled={c.usable < (format === "clipedit" ? 1 : MIN_MOMENTS)}>
                {c.name}{c.platform === "youtube" ? " (YouTube)" : ""} · {c.usable} good moment{c.usable === 1 ? "" : "s"}{format === "montage" && c.usable < MIN_MOMENTS ? ` (needs ${MIN_MOMENTS})` : ""}
              </option>
            ))}
          </select>
          <div className="text-xs text-zinc-500">A montage needs {MIN_MOMENTS}+ of their clips that you haven&apos;t rejected. For one clip, use &ldquo;Make an edit from this clip&rdquo; on its card in the Queue.</div>
        </label>
        <div className="space-y-1 md:col-span-2">
          <div className="text-sm font-semibold">Format</div>
          <div className="flex flex-wrap gap-2">
            {FORMATS.map((f) => (
              <label key={f.key} title={f.hint} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm has-[:checked]:border-hot has-[:checked]:bg-hot/10">
                <input type="radio" name="format" value={f.key} checked={format === f.key} onChange={() => setFormat(f.key)} className="accent-[#ff3d81]" />{f.label}
              </label>
            ))}
          </div>
          <div className="text-xs text-zinc-500">{FORMATS.find((f) => f.key === format)?.hint}{format === "clipedit" ? " Uses their best clip; for a specific clip press \u201cMake an edit from this clip\u201d on it in the Queue." : ""}</div>
        </div>
        <div className="space-y-1">
          <div className="text-sm font-semibold">Vibe</div>
          <div className="flex flex-wrap gap-2">
            {VIBES.map((v) => (
              <label key={v.key} title={v.hint} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm has-[:checked]:border-hot has-[:checked]:bg-hot/10">
                <input type="radio" name="vibe" value={v.key} defaultChecked={defaults.vibe === v.key} className="accent-[#ff3d81]" />{v.label}
              </label>
            ))}
          </div>
          <div className="text-xs text-zinc-500">{VIBES.map((v) => `${v.label}: ${v.hint}`).join(" ")}</div>
        </div>
        <div className="space-y-1">
          <div className="text-sm font-semibold">Length</div>
          <div className="flex gap-2">
            {EDIT_LENGTHS.map((l) => (
              <label key={l} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm has-[:checked]:border-hot has-[:checked]:bg-hot/10">
                <input type="radio" name="length" value={l} defaultChecked={defaults.length === l} className="accent-[#ff3d81]" />{l}s
              </label>
            ))}
          </div>
          <div className="text-xs text-zinc-500">Rounded to whole bars of the beat.</div>
        </div>
        <div className="space-y-1.5">
          <div className="text-sm font-semibold">Tempo</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="tempo" value="steady" checked={tempo === "steady"} onChange={() => setTempo("steady")} className="accent-[#ff3d81]" />
            Steady beat at <input name="bpm" type="number" min={70} max={180} step={1} defaultValue={defaults.bpm} className="field w-20 py-1" /> BPM
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="tempo" value="song" checked={tempo === "song"} onChange={() => setTempo("song")} disabled={!songs.length} className="accent-[#ff3d81]" />
            Match a song from my music folder
          </label>
          {tempo === "song" && (
            <select name="song" className="field">
              {songs.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.mb} MB)</option>)}
            </select>
          )}
          <div className="text-xs text-zinc-500">
            {songs.length ? "The song is only used to find the beat. It's never put into the video." : <>No songs yet: put the song you&apos;ll use in TikTok in the <code className="rounded bg-black/40 px-1">clip-factory\music</code> folder. It&apos;s only used for timing, never put into the video.</>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="creatorAudio" defaultChecked={defaults.creatorAudio} className="h-4 w-4 accent-[#ff3d81]" />Keep the creator&apos;s audio (quieter, under your sound)</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="endText" defaultChecked className="h-4 w-4 accent-[#ff3d81]" />&ldquo;follow for more&rdquo; at the end</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="captions" className="h-4 w-4 accent-[#ff3d81]" />Word captions (edits usually have none)</label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-hot" disabled={pending || !enough}>{pending ? "Starting…" : "Make edit"}</button>
        {state?.ok && <span className="text-sm text-emerald-300">{state.ok}</span>}
        {state?.error && <span className="text-sm text-red-300">{state.error}</span>}
      </div>
      <p className="text-xs text-zinc-500">No music is put into edits (copyright). Add the trending sound in TikTok/Reels when you post.</p>
    </form>
  );
}
