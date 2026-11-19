import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { appUrl } from "@/lib/youtube";
import { twitchConfigured } from "@/lib/twitch";
import { twitchUserAuthUrl } from "@/lib/twitch-user";

export const dynamic = "force-dynamic";

/** Starts "Connect Twitch (for follower counts)": Twitch's consent screen, back to APP_URL (the Live page). */
export function GET() {
  if (!twitchConfigured()) return NextResponse.redirect(`${appUrl()}/settings?msg=${encodeURIComponent("Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env first")}`);
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(twitchUserAuthUrl(state));
  res.cookies.set("tw_state", state, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
