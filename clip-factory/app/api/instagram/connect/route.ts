import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { appUrl } from "@/lib/youtube";
import { instagramAuthUrl, instagramConfigured } from "@/lib/instagram";

export const dynamic = "force-dynamic";

/** v2.0.3 "Connect Instagram" (Settings → Channels slot, or the Connected accounts card). Same cf_channel cookie as YouTube/TikTok. */
export function GET(req: Request) {
  const channel = new URL(req.url).searchParams.get("channel");
  if (!instagramConfigured()) return NextResponse.redirect(`${appUrl()}/settings?msg=${encodeURIComponent("Add INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET to .env first (README: Connect Instagram)")}`);
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(instagramAuthUrl(state));
  // 1 hour: Krew may have to fix the address bar (https → http) or paste it into Settings after Instagram sends him back.
  const opts = { httpOnly: true, sameSite: "lax" as const, maxAge: 3600, path: "/" };
  res.cookies.set("ig_state", state, opts);
  if (channel && /^[A-Za-z0-9_-]{1,40}$/.test(channel)) res.cookies.set("cf_channel", channel, opts);
  return res;
}
