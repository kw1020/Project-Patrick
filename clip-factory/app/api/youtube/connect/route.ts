import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { appUrl, authUrl, youtubeConfigured } from "@/lib/youtube";

export const dynamic = "force-dynamic";

/** Starts "Connect YouTube": sends Krew to Google's consent screen. */
export function GET(req: Request) {
  // v1.9.5: "Connect" in a channel's slot on Settings → the account goes into that channel.
  const channel = new URL(req.url).searchParams.get("channel");
  if (!youtubeConfigured()) return NextResponse.redirect(`${appUrl()}/settings?msg=${encodeURIComponent("Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to .env first")}`);
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authUrl(state));
  res.cookies.set("yt_state", state, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  if (channel && /^[A-Za-z0-9_-]{1,40}$/.test(channel)) res.cookies.set("cf_channel", channel, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
