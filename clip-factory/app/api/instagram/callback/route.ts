import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { assignHomeChannel } from "@/lib/to-post";
import { appUrl } from "@/lib/youtube";
import { connectInstagram } from "@/lib/instagram";

export const dynamic = "force-dynamic";

/**
 * Instagram sends Krew to the https:// version of this address (Meta only takes https redirect URIs); he reaches this
 * plain http route by fixing the address bar or pasting it on Settings (see `instagramRedirectUri`).
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const back = (msg: string) => {
    const res = NextResponse.redirect(`${appUrl()}/settings?msg=${encodeURIComponent(msg)}`);
    res.cookies.delete("ig_state");
    res.cookies.delete("cf_channel");
    return res;
  };
  if (q.get("error")) return back(`Instagram said: ${q.get("error_description") || q.get("error_reason") || q.get("error")}`);
  const state = q.get("state"), code = q.get("code")?.replace(/#_?$/, "");
  if (!code || !state || state !== req.cookies.get("ig_state")?.value) return back("Sign-in check failed (open the address in the same browser you pressed Connect in, within an hour). Try connecting again.");
  try {
    const acct = await connectInstagram(code);
    await assignHomeChannel(acct.id, req.cookies.get("cf_channel")?.value).catch(() => null);
    revalidatePath("/settings");
    return back(acct.error ? acct.error : `connected:${acct.channelTitle}`);
  } catch (e) {
    return back((e as Error).message);
  }
}
