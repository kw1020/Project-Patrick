"use client";
/* eslint-disable @next/next/no-img-element */
import { useState, useTransition } from "react";
import { approveCreators, findCreators } from "../../app/actions";
import type { ApproveItem, ApprovePick, Cell, ResolveResult, TwitchHit, YtHit } from "../lib/creator-lookup";
import { KREW_TOP_21 } from "../lib/starter-creators";
import { compact } from "../lib/format";

type Ticks = Record<string, boolean>; // `${row}:t` / `${row}:y`

function initialTicks(r: ResolveResult): Ticks {
  const t: Ticks = {};
  r.rows.forEach((row, i) => {
    // Only exact, not-yet-approved matches start ticked; "closest match" ones wait for Krew to check them.
    t[`${i}:t`] = row.twitch.status === "found" && row.twitch.match.exact && !row.twitch.match.approved;
    t[`${i}:y`] = row.youtube.status === "found" && row.youtube.match.exact && !row.youtube.match.approved;
  });
  return t;
}

function Pic({ src, name }: { src: string | null; name: string }) {
  return src ? <img src={src} alt="" className="h-7 w-7 shrink-0 rounded-full bg-zinc-800 object-cover" />
    : <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-zinc-800 text-xs font-black text-zinc-300">{name.slice(0, 1).toUpperCase()}</div>;
}

function Missing<T>({ cell }: { cell: Cell<T> }) {
  if (cell.status === "none") return <span className="text-xs text-zinc-500">not found</span>;
  if (cell.status === "error") return <span className="text-xs text-amber-200 [overflow-wrap:anywhere]">couldn&apos;t check ({cell.reason})</span>;
  return null;
}

function TwitchCell({ cell, checked, onToggle, label }: { cell: Cell<TwitchHit>; checked: boolean; onToggle: () => void; label: string }) {
  if (cell.status !== "found") return <div className="min-w-0"><span className="mr-1 text-[10px] font-black uppercase text-violet-300 sm:hidden">Twitch</span><Missing cell={cell} /></div>;
  const m = cell.match;
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2">
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={m.approved} aria-label={label} className="h-4 w-4 shrink-0 accent-pink-500" />
      <Pic src={m.avatar} name={m.name} />
      <span className="min-w-0">
        <a href={`https://www.twitch.tv/${m.login}`} target="_blank" className="block truncate text-sm font-bold hover:text-hot">
          <span className="mr-1 text-[10px] font-black uppercase text-violet-300">Twitch</span>{m.name}
        </a>
        <span className="block truncate text-[11px] text-zinc-400">
          {m.isLive ? <span className="text-red-400">● live</span> : "offline"}{m.game ? ` · ${m.game}` : ""}
          {m.approved ? <span className="text-emerald-300"> · already approved</span> : !m.exact ? <span className="text-amber-200"> · closest match, check it</span> : null}
        </span>
      </span>
    </label>
  );
}

function YouTubeCell({ cell, checked, onToggle, label }: { cell: Cell<YtHit>; checked: boolean; onToggle: () => void; label: string }) {
  if (cell.status !== "found") return <div className="min-w-0"><span className="mr-1 text-[10px] font-black uppercase text-red-300 sm:hidden">YouTube</span><Missing cell={cell} /></div>;
  const m = cell.match;
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2">
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={m.approved} aria-label={label} className="h-4 w-4 shrink-0 accent-pink-500" />
      <Pic src={m.avatar} name={m.title} />
      <span className="min-w-0">
        <a href={`https://www.youtube.com/@${m.handle}`} target="_blank" className="block truncate text-sm font-bold hover:text-hot">
          <span className="mr-1 text-[10px] font-black uppercase text-red-300">YouTube</span>{m.title}
        </a>
        <span className="block truncate text-[11px] text-zinc-400">
          @{m.handle}{m.subscribers != null ? ` · ${compact(m.subscribers)} subscribers` : ""}
          {m.approved ? <span className="text-emerald-300"> · already approved</span> : !m.exact ? <span className="text-amber-200"> · closest match, check it</span> : null}
        </span>
      </span>
    </label>
  );
}

export function BulkAddCreators({ initial }: { initial?: ResolveResult }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<ResolveResult | null>(initial ?? null);
  const [ticks, setTicks] = useState<Ticks>(initial ? initialTicks(initial) : {});
  const [done, setDone] = useState<Record<number, ApproveItem[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [finding, startFind] = useTransition();
  const [approving, startApprove] = useTransition();

  const find = () => startFind(async () => {
    setError(null); setDone({});
    try {
      const r = await findCreators(text);
      setResult(r); setTicks(initialTicks(r));
      if (!r.rows.length) setError("Type at least one name, one per line.");
    } catch (e) {
      setError(`Couldn't check the list (${(e as Error).message}). Try again.`);
    }
  });

  const pickFor = (i: number): ApprovePick | null => {
    const row = result!.rows[i];
    const p: ApprovePick = { name: row.name };
    if (ticks[`${i}:t`] && row.twitch.status === "found") {
      const m = row.twitch.match; p.twitch = { id: m.id, login: m.login, name: m.name, avatar: m.avatar };
    }
    if (ticks[`${i}:y`] && row.youtube.status === "found") {
      const m = row.youtube.match; p.youtube = { channelId: m.channelId, handle: m.handle, title: m.title, avatar: m.avatar };
    }
    return p.twitch || p.youtube ? p : null;
  };

  const approve = (rows: number[]) => startApprove(async () => {
    setError(null);
    const picks = rows.map((i) => [i, pickFor(i)] as const).filter((x): x is readonly [number, ApprovePick] => x[1] != null);
    if (!picks.length) { setError("Tick at least one match first."); return; }
    try {
      const r = await approveCreators(picks.map((x) => x[1]), note);
      const byRow: Record<number, ApproveItem[]> = { ...done };
      for (const [i, p] of picks) byRow[i] = r.items.filter((it) => it.name === p.name);
      setDone(byRow);
      // Approved ones can't be approved twice: untick them and mark them.
      setResult((prev) => prev && {
        ...prev,
        rows: prev.rows.map((row, i) => {
          const items = byRow[i] ?? [];
          const okT = items.some((it) => it.ok && it.platform === "twitch"), okY = items.some((it) => it.ok && it.platform === "youtube");
          return {
            ...row,
            twitch: okT && row.twitch.status === "found" ? { ...row.twitch, match: { ...row.twitch.match, approved: true } } : row.twitch,
            youtube: okY && row.youtube.status === "found" ? { ...row.youtube, match: { ...row.youtube.match, approved: true } } : row.youtube,
          };
        }),
      });
      setTicks((t) => {
        const n = { ...t };
        for (const [i] of picks) for (const it of byRow[i] ?? []) if (it.ok) n[`${i}:${it.platform === "twitch" ? "t" : "y"}`] = false;
        return n;
      });
    } catch (e) {
      setError(`Approving failed (${(e as Error).message}).`);
    }
  });

  const toggle = (k: string) => setTicks((t) => ({ ...t, [k]: !t[k] }));
  const tickedCount = Object.values(ticks).filter(Boolean).length;

  return (
    <section className="card min-w-0 space-y-3 p-4" data-testid="bulk-add">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-bold">Add a list of creators</div>
        <button type="button" className="btn-ghost text-xs" onClick={() => setText(KREW_TOP_21.join("\n"))}>Load Krew&apos;s top 21</button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} aria-label="Creator names, one per line"
          placeholder={"One name per line, e.g.\nKai Cenat\nxQc\nIShowSpeed"} className="field min-h-28 font-mono text-xs" />
        <div className="flex flex-col gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note (optional)" placeholder="Note (optional)" className="field" />
          <button type="button" className="btn-hot" onClick={find} disabled={finding || !text.trim()}>{finding ? "Looking them up…" : "Find them"}</button>
          <p className="text-xs text-zinc-500">Checks Twitch and YouTube for each name. Nobody is approved until you press Approve.</p>
        </div>
      </div>
      {error && <div className="text-sm text-red-300">{error}</div>}

      {result && result.rows.length > 0 && (
        <div className="space-y-2">
          {result.notes.map((n, i) => <div key={i} className="rounded-lg border border-sun/30 bg-sun/10 px-3 py-2 text-xs text-amber-200">{n}</div>)}
          <div className="hidden grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 px-3 text-[11px] font-bold uppercase tracking-wide text-zinc-500 sm:grid">
            <span>Name</span><span>Twitch</span><span>YouTube</span><span />
          </div>
          <div className="divide-y divide-line rounded-xl border border-line">
            {result.rows.map((row, i) => (
              <div key={row.name} className="grid grid-cols-1 gap-2 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
                <div className="truncate text-sm font-black">{row.name}</div>
                <TwitchCell cell={row.twitch} checked={Boolean(ticks[`${i}:t`])} onToggle={() => toggle(`${i}:t`)} label={`Twitch match for ${row.name}`} />
                <YouTubeCell cell={row.youtube} checked={Boolean(ticks[`${i}:y`])} onToggle={() => toggle(`${i}:y`)} label={`YouTube match for ${row.name}`} />
                <div className="flex flex-col items-start gap-1 sm:items-end">
                  <button type="button" className="btn-ghost text-xs" disabled={approving || !(ticks[`${i}:t`] || ticks[`${i}:y`])} onClick={() => approve([i])}>Approve</button>
                </div>
                {done[i]?.length ? (
                  <div className="space-y-0.5 sm:col-span-4">
                    {done[i].map((it, k) => <div key={k} className={`text-xs [overflow-wrap:anywhere] ${it.ok ? "text-emerald-300" : "text-amber-200"}`}>{it.message}</div>)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-hot" disabled={approving || tickedCount === 0} onClick={() => approve(result.rows.map((_, i) => i))}>
              {approving ? "Approving…" : `Approve all ticked (${tickedCount})`}
            </button>
            <span className="text-xs text-zinc-500">Their clips start coming in on the next scan.</span>
          </div>
          <p className="text-xs text-zinc-500">Kick isn&apos;t supported yet — creators who only stream on Kick won&apos;t be found on Twitch.</p>
        </div>
      )}
    </section>
  );
}
