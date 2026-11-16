import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { appUrl } from "@/lib/youtube";
import { connectTikTok } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const back = (msg: string) => {
    const res = NextResponse.redirect(`${appUrl()}/settings?msg=${encodeURIComponent(msg)}`);
    res.cookies.delete("tt_state");
    res.cookies.delete("tt_verifier");
    return res;
  };
  if (q.get("error")) return back(`TikTok said: ${q.get("error_description") || q.get("error")}`);
  const state = q.get("state"), code = q.get("code"), verifier = req.cookies.get("tt_verifier")?.value;
  if (!code || !state || !verifier || state !== req.cookies.get("tt_state")?.value) return back("Sign-in check failed. Try connecting again.");
  try {
    const acct = await connectTikTok(code, verifier);
    revalidatePath("/settings");
    return back(acct.error ? acct.error : `connected:${acct.channelTitle}`);
  } catch (e) {
    return back((e as Error).message);
  }
}
