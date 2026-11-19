import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { appUrl, authUrl, youtubeConfigured, youtubeKeysMissing } from "@/lib/youtube";
import { parseThen, THEN_COOKIE } from "@/lib/to-post";

export const dynamic = "force-dynamic";

/** Starts "Connect YouTube": sends Krew to Google's consent screen. */
export function GET(req: Request) {
  // v1.9.5: "Connect" in a channel's slot on Settings → the account goes into that channel.
  const q = new URL(req.url).searchParams;
  const channel = q.get("channel");
  // v2.0.6: "Upload to YouTube (connect first)" on a clip → after the callback, that clip is uploaded (then=upload:<clipId>).
  const then = parseThen(q.get("then"));
  if (!youtubeConfigured()) {
    const msg = `Add ${youtubeKeysMissing().join(" and ")} to .env first (Settings shows the redirect URL), then restart Clip Factory.`;
    return NextResponse.redirect(`${appUrl()}/${then ? "upload" : "settings"}?msg=${encodeURIComponent(msg)}`);
  }
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authUrl(state));
  res.cookies.set("yt_state", state, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  if (channel && /^[A-Za-z0-9_-]{1,40}$/.test(channel)) res.cookies.set("cf_channel", channel, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  if (then) res.cookies.set(THEN_COOKIE, `upload:${then.clipId}`, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
