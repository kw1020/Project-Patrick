// v2.0.3: pure helper (no Node imports) so the Settings paste box can use it in the browser.

/**
 * What Krew pasted ("https://localhost:3000/api/instagram/callback?code=AB#_&state=..." or just the query) -> the local
 * callback path with the same query, or null when there's no code/error in it. Meta appends "#_" to the code; it's not part of it.
 */
export function pastedCallbackPath(pasted: string): string | null {
  const t = String(pasted ?? "").trim();
  const q = (t.includes("?") ? t.slice(t.indexOf("?") + 1) : t).replace(/#.*$/, "");
  const p = new URLSearchParams(q);
  if (!p.get("code") && !p.get("error")) return null;
  const out = new URLSearchParams();
  for (const k of ["code", "state", "error", "error_reason", "error_description"]) {
    const v = p.get(k);
    if (v) out.set(k, v);
  }
  return `/api/instagram/callback?${out.toString()}`;
}
