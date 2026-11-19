import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { appUrl } from "@/lib/youtube";
import { pkce, tiktokAuthUrl, tiktokConfigured } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

/** Starts "Connect TikTok". Each time = one more account (sign in to a different TikTok to add it). */
export function GET(req: Request) {
  // v1.9.5: "Connect" in a channel's slot on Settings → the account goes into that channel.
  const channel = new URL(req.url).searchParams.get("channel");
  if (!tiktokConfigured()) return NextResponse.redirect(`${appUrl()}/settings?msg=${encodeURIComponent("Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to .env first")}`);
  const state = crypto.randomBytes(16).toString("hex");
  const { verifier, challenge } = pkce();
  const res = NextResponse.redirect(tiktokAuthUrl(state, challenge));
  const opts = { httpOnly: true, sameSite: "lax" as const, maxAge: 600, path: "/" };
  res.cookies.set("tt_state", state, opts);
  res.cookies.set("tt_verifier", verifier, opts);
  if (channel && /^[A-Za-z0-9_-]{1,40}$/.test(channel)) res.cookies.set("cf_channel", channel, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
