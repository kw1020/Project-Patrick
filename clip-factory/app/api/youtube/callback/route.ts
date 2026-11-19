import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { assignHomeChannel, parseThen, THEN_COOKIE, uploadAfterConnect } from "@/lib/to-post";
import { appUrl, connectWithCode } from "@/lib/youtube";

export const dynamic = "force-dynamic";

/** Google sends Krew back here after consent. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  // v2.0.6: started from a clip's "Upload to YouTube (connect first)" → back to the Upload page, and that clip is uploaded.
  const then = parseThen(req.cookies.get(THEN_COOKIE)?.value);
  const back = (msg: string) => {
    const res = NextResponse.redirect(`${appUrl()}/${then ? "upload" : "settings"}?msg=${encodeURIComponent(msg)}`);
    res.cookies.delete("yt_state");
    res.cookies.delete("cf_channel");
    res.cookies.delete(THEN_COOKIE);
    return res;
  };
  if (q.get("error")) return back(`Google said: ${q.get("error")}`);
  const state = q.get("state"), code = q.get("code");
  if (!code || !state || state !== req.cookies.get("yt_state")?.value) return back("Sign-in check failed. Try connecting again.");
  try {
    const acct = await connectWithCode(code);
    const home = await assignHomeChannel(acct.id, req.cookies.get("cf_channel")?.value).catch(() => null);
    if (then) {
      const msg = await uploadAfterConnect(then.clipId, home ?? null);
      try { for (const p of ["/upload", "/queue", "/settings"]) revalidatePath(p); } catch { /* outside a request */ }
      return back(`Connected ${acct.channelTitle}. ${msg}`);
    }
    try { revalidatePath("/settings"); } catch { /* outside a request */ }
    return back(`connected:${acct.channelTitle}`);
  } catch (e) {
    return back((e as Error).message);
  }
}
