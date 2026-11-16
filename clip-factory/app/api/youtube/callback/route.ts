import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { appUrl, connectWithCode } from "@/lib/youtube";

export const dynamic = "force-dynamic";

/** Google sends Krew back here after consent. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const back = (msg: string) => {
    const res = NextResponse.redirect(`${appUrl()}/settings?msg=${encodeURIComponent(msg)}`);
    res.cookies.delete("yt_state");
    return res;
  };
  if (q.get("error")) return back(`Google said: ${q.get("error")}`);
  const state = q.get("state"), code = q.get("code");
  if (!code || !state || state !== req.cookies.get("yt_state")?.value) return back("Sign-in check failed. Try connecting again.");
  try {
    const acct = await connectWithCode(code);
    revalidatePath("/settings");
    return back(`connected:${acct.channelTitle}`);
  } catch (e) {
    return back((e as Error).message);
  }
}
