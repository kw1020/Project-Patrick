import type { Metadata } from "next";
import { getChangelog } from "@/lib/version";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "What's new - Clip Factory" };

function niceDate(d: string) {
  const t = Date.parse(d + "T12:00:00Z");
  if (!d || Number.isNaN(t)) return d;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export default function WhatsNewPage() {
  const entries = getChangelog();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-black">What&apos;s new</h1>
        <p className="text-sm text-zinc-400">
          Every Clip Factory update, newest first. Updates arrive by themselves when you open Clip Factory or press Update now on the CF icon.
        </p>
      </div>

      {entries.length === 0 && (
        <div className="card p-5 text-sm text-zinc-400">Couldn&apos;t find the patch notes. Try updating Clip Factory from the CF icon.</div>
      )}

      <ol className="space-y-4">
        {entries.map((e, i) => {
          const latest = i === 0;
          return (
            <li key={e.version}
              className={`card p-5 ${latest ? "border-hot/60 bg-gradient-to-br from-hot/10 via-panel to-panel" : ""}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className={`font-black tabular-nums ${latest ? "text-xl" : "text-lg text-zinc-200"}`}>v{e.version}</h2>
                {latest && <span className="rounded-full bg-hot px-2 py-0.5 text-[11px] font-bold uppercase text-white">You have this</span>}
                {e.date && <span className="text-sm text-zinc-500">{niceDate(e.date)}</span>}
              </div>
              <ul className={`mt-3 space-y-1.5 text-sm ${latest ? "text-zinc-100" : "text-zinc-400"}`}>
                {e.notes.map((n, j) => (
                  <li key={j} className="flex gap-2">
                    <span className={`mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full ${latest ? "bg-sun" : "bg-zinc-600"}`} />
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
