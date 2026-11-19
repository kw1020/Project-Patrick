import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { appUrl } from "@/lib/youtube";
import { connectTwitchUser } from "@/lib/twitch-user";
import { pokeSuggest } from "@/lib/queues";

export const dynamic = "force-dynamic";

/** Twitch → `/?code=…&state=…` (the registered redirect URI) → the Live page forwards here. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const back = (msg: string) => {
    const res = NextResponse.redirect(`${appUrl()}/settings?msg=${encodeURIComponent(msg)}`);
    res.cookies.delete("tw_state");
    return res;
  };
  if (q.get("error")) return back(`Twitch said: ${q.get("error_description") || q.get("error")}`);
  const state = q.get("state"), code = q.get("code");
  if (!code || !state || state !== req.cookies.get("tw_state")?.value) return back("Twitch sign-in check failed. Try connecting again.");
  try {
    const acct = await connectTwitchUser(code);
    try { revalidatePath("/settings"); revalidatePath("/streamers"); } catch { /* outside a request (tests) */ }
    await pokeSuggest().catch(() => {}); // rank suggestions by followers right away
    return back(`connected:Twitch (${acct.channelTitle}) for follower counts`);
  } catch (e) {
    return back((e as Error).message);
  }
}
