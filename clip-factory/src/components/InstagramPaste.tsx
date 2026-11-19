"use client";
import { useState } from "react";
import { pastedCallbackPath } from "../lib/instagram-paste";

/**
 * v2.0.3: Meta only takes https redirect addresses, so after "Allow" Instagram opens https://localhost:3000/... which can't
 * load. Krew pastes that address here (or changes https to http in the address bar) and the connect finishes.
 */
export function InstagramPaste({ redirectUri }: { redirectUri: string }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="space-y-1.5 rounded-lg border border-fuchsia-500/30 p-2.5" data-testid="instagram-paste"
      onSubmit={(e) => {
        e.preventDefault();
        const path = pastedCallbackPath(v);
        if (!path) { setErr("That address has no code in it. Copy the whole address from the address bar after pressing Allow on Instagram."); return; }
        window.location.href = path;
      }}>
      <div className="text-xs text-zinc-300">
        <b>Connecting Instagram?</b> After you press Allow, Instagram opens a page that can&apos;t load ({redirectUri.replace(/\?.*$/, "")}?code=…).
        That&apos;s expected: copy the whole address from the address bar and paste it here (or change <code>https</code> to <code>http</code> in the address bar and press Enter).
      </div>
      <div className="flex gap-1.5">
        <input value={v} onChange={(e) => { setV(e.target.value); setErr(null); }} placeholder="https://localhost:3000/api/instagram/callback?code=…" aria-label="Instagram address" className="field min-w-0 flex-1 py-1 text-xs" />
        <button className="btn-hot shrink-0 px-3 py-1 text-xs">Finish connecting</button>
      </div>
      {err && <div className="text-xs text-red-300">{err}</div>}
    </form>
  );
}
