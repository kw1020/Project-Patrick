"use client";
import { useActionState, useState } from "react";
import { makeEdit, type MakeEditResult } from "../../app/edit-actions";
import { DEFAULT_FORMAT, EDIT_LENGTHS, FORMATS, MIN_MOMENTS, TOP5_COUNT, TOP5_THEMES, VIBES, type EditFormat, type Top5Theme } from "../lib/edit-vibes";

export type CreatorOption = { id: string; name: string; platform: string; usable: number };

export function MakeEditForm({ creators, songs, defaults, themeCounts }: {
  creators: CreatorOption[]; songs: { name: string; mb: number }[];
  defaults: { vibe: string; length: number; bpm: number; creatorAudio: boolean };
  /** v2.0.5: how many different moments each Top 5 theme has right now (a Top 5 needs 5). */
  themeCounts: Record<string, number>;
}) {
  const [state, action, pending] = useActionState<MakeEditResult | null, FormData>(makeEdit, null);
  const first = creators.find((c) => c.usable >= MIN_MOMENTS)?.id ?? "";
  const [creator, setCreator] = useState(first);
  const [tempo, setTempo] = useState<"steady" | "song">("steady");
  const [format, setFormat] = useState<EditFormat>(DEFAULT_FORMAT);
  const [theme, setTheme] = useState<Top5Theme>(() => TOP5_THEMES.find((t) => t.key !== "creator" && (themeCounts[t.key] ?? 0) >= TOP5_COUNT)?.key ?? "funny");
  const pick = creators.find((c) => c.id === creator);
  const enough = format === "top5"
    ? (theme === "creator" ? (pick?.usable ?? 0) >= TOP5_COUNT : (themeCounts[theme] ?? 0) >= TOP5_COUNT)
    : (pick?.usable ?? 0) >= (format === "clipedit" ? 1 : MIN_MOMENTS);
  const formatPicker = (
    <div className="space-y-1">
      <div className="text-sm font-semibold">Format</div>
      <div className="flex flex-wrap gap-2">
        {FORMATS.map((f) => (
          <label key={f.key} title={f.hint} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm has-[:checked]:border-hot has-[:checked]:bg-hot/10">
            <input type="radio" name="format" value={f.key} checked={format === f.key} onChange={() => setFormat(f.key)} className="accent-[#ff3d81]" />{f.label}
          </label>
        ))}
      </div>
      <div className="text-xs text-zinc-500">{FORMATS.find((f) => f.key === format)?.hint}{format === "clipedit" ? " Uses their best clip; for a specific clip press “Make an edit from this clip” on it in the Queue." : ""}</div>
    </div>
  );
  if (format === "top5") return (
    <form action={action} className="card space-y-4 p-5" data-testid="make-edit">
      <div className="text-xs font-bold uppercase tracking-wide text-zinc-400">Make an edit</div>
      {formatPicker}
      <div className="space-y-1">
        <div className="text-sm font-semibold">Theme</div>
        <div className="flex flex-wrap gap-2">
          {TOP5_THEMES.map((t) => (
            <label key={t.key} title={t.hint} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm has-[:checked]:border-hot has-[:checked]:bg-hot/10">
              <input type="radio" name="theme" value={t.key} checked={theme === t.key} onChange={() => setTheme(t.key)} className="accent-[#ff3d81]" />
              {t.label}{t.key !== "creator" && <span className="text-xs text-zinc-500">· {themeCounts[t.key] ?? 0}</span>}
            </label>
          ))}
        </div>
        <div className="text-xs text-zinc-500">{TOP5_THEMES.find((t) => t.key === theme)?.hint} Picked by the Judge&apos;s score, the payoff and how much it stood out; the same moment never twice{theme === "creator" ? "" : ", at most 2 per creator"}. About 45-75s, ending on #1.</div>
      </div>
      {theme === "creator" && (
        <label className="block space-y-1">
          <div className="text-sm font-semibold">Creator</div>
          <select name="streamerId" className="field" value={creator} onChange={(e) => setCreator(e.target.value)}>
            {creators.length === 0 && <option value="">No approved creators yet</option>}
            {creators.map((c) => (
              <option key={c.id} value={c.id} disabled={c.usable < TOP5_COUNT}>
                {c.name}{c.platform === "youtube" ? " (YouTube)" : ""} · {c.usable} good moment{c.usable === 1 ? "" : "s"}{c.usable < TOP5_COUNT ? ` (needs ${TOP5_COUNT})` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-hot" disabled={pending || !enough}>{pending ? "Starting…" : "Make it"}</button>
        {!enough && <span className="text-xs text-zinc-400">Needs {TOP5_COUNT} different moments.</span>}
        {state?.ok && <span className="text-sm text-emerald-300">{state.ok}</span>}
        {state?.error && <span className="text-sm text-red-300">{state.error}</span>}
      </div>
      <p className="text-xs text-zinc-500">Each moment keeps its own sound and captions. No music is put in: add the trending sound in TikTok/Reels when you post.</p>
    </form>
  );
  return (
    <form action={action} className="card space-y-4 p-5" data-testid="make-edit">
      <div className="text-xs font-bold uppercase tracking-wide text-zinc-400">Make an edit</div>
      {formatPicker}
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
