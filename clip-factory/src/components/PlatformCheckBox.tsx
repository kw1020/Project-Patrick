"use client";
import { PLATFORM_NAMES, type PlatformCheck } from "../lib/platform-rules";

/** v1.9.8 "Platform check" box on the Queue card and the Upload card (red = blocks posting, yellow = warning). */
export function PlatformCheckBox({ check }: { check: PlatformCheck }) {
  const color = check.fails ? "border-red-500/40 text-red-300" : check.warns ? "border-sun/40 text-sun" : "border-emerald-500/30 text-emerald-300";
  const items = [...check.items.filter((i) => i.level === "fail"), ...check.items.filter((i) => i.level === "warn"), ...check.items.filter((i) => i.level === "ok")];
  return (
    <details className={`rounded-lg border px-2.5 py-2 text-xs ${color}`} data-testid="platform-check" open={check.fails > 0}>
      <summary className="cursor-pointer select-none font-bold">{check.fails ? "⛔" : check.warns ? "⚠️" : "✅"} Platform check: {check.summary}</summary>
      <div className="mt-1 space-y-0.5">
        {items.map((i, k) => (
          <div key={k} className={`[overflow-wrap:anywhere] ${i.level === "fail" ? "text-red-300" : i.level === "warn" ? "text-sun" : "text-zinc-400"}`}>
            {i.level === "fail" ? "⛔ Blocks posting: " : i.level === "warn" ? "⚠️ " : "✓ "}{i.text}{i.platforms ? ` (${i.platforms.map((p) => PLATFORM_NAMES[p]).join(", ")})` : ""}
          </div>
        ))}
      </div>
    </details>
  );
}
