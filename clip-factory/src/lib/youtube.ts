// YouTube: OAuth connect, Shorts upload (resumable), view counts. Plain fetch against Google's REST API.
import fs from "node:fs";
import { prisma } from "./db";

// Overridable so tests can point at a mock server.
const AUTH_URL = () => process.env.GOOGLE_OAUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const API_URL = () => process.env.YOUTUBE_API_URL || "https://www.googleapis.com/youtube/v3";
const UPLOAD_URL = () => process.env.YOUTUBE_UPLOAD_URL || "https://www.googleapis.com/upload/youtube/v3/videos";
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];

export function youtubeConfigured() {
  return Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);
}
export function appUrl() {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}
export function redirectUri() {
  return `${appUrl()}/api/youtube/callback`;
}

export function authUrl(state: string) {
  const u = new URL(AUTH_URL());
  u.search = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID!, redirect_uri: redirectUri(), response_type: "code",
    scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", state,
  }).toString();
  return u.toString();
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.YOUTUBE_CLIENT_ID!, client_secret: process.env.YOUTUBE_CLIENT_SECRET!, ...params }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(`Google sign-in failed: ${j.error_description || j.error || res.status}`);
  return j;
}

/** Finish the connect flow: trade the code for tokens, look up the channel, save the account. */
export async function connectWithCode(code: string) {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new Error("Google didn't return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.");
  const ch = await ytFetch(t.access_token!, "/channels?part=snippet&mine=true");
  const item = ch.items?.[0];
  if (!item) throw new Error("That Google account has no YouTube channel.");
  const data = {
    channelId: item.id as string, channelTitle: item.snippet?.title as string, refreshToken: t.refresh_token,
    accessToken: t.access_token!, expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000), error: null,
  };
  return prisma.account.upsert({ where: { platform: "youtube" }, update: data, create: { platform: "youtube", ...data } });
}

export function getYouTubeAccount() {
  return prisma.account.findUnique({ where: { platform: "youtube" } });
}

async function accessToken() {
  const acct = await getYouTubeAccount();
  if (!acct) throw new Error("YouTube isn't connected. Connect it on the Settings page.");
  if (acct.accessToken && acct.expiresAt && acct.expiresAt.getTime() > Date.now() + 60_000) return acct.accessToken;
  try {
    const t = await tokenRequest({ refresh_token: acct.refreshToken, grant_type: "refresh_token" });
    await prisma.account.update({ where: { id: acct.id }, data: { accessToken: t.access_token!, expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000), error: null } });
    return t.access_token!;
  } catch (e) {
    const msg = `${(e as Error).message}. Reconnect YouTube on the Settings page.`;
    await prisma.account.update({ where: { id: acct.id }, data: { error: msg } });
    throw new Error(msg);
  }
}

async function ytFetch(token: string, path: string) {
  const res = await fetch(API_URL() + path, { headers: { Authorization: `Bearer ${token}` } });
  const j = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${j.error?.message || "request failed"}`);
  return j;
}

export type UploadInput = { file: string; title: string; description: string; tags: string[]; privacy: "public" | "unlisted" | "private" };

/** Upload a finished clip. Vertical + under 60s, so YouTube treats it as a Short. Returns the video id. */
export async function uploadVideo(input: UploadInput): Promise<string> {
  const token = await accessToken();
  const size = fs.statSync(input.file).size;
  const meta = {
    snippet: { title: input.title.replace(/[<>]/g, "").slice(0, 100), description: input.description.replace(/[<>]/g, "").slice(0, 4900), tags: input.tags.slice(0, 15), categoryId: "20" /* Gaming */ },
    status: { privacyStatus: input.privacy, selfDeclaredMadeForKids: false },
  };
  const init = await fetch(`${UPLOAD_URL()}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(size) },
    body: JSON.stringify(meta),
  });
  const session = init.headers.get("location");
  if (!init.ok || !session) {
    const j = (await init.json().catch(() => ({}))) as any;
    const reason = j.error?.errors?.[0]?.reason;
    throw new Error(reason === "quotaExceeded" || reason === "uploadLimitExceeded"
      ? "YouTube's daily upload limit is used up (100 uploads/day per Google project). It resets at midnight Pacific."
      : `YouTube rejected the upload (${init.status}): ${j.error?.message || "no upload session returned"}`);
  }
  const put = await fetch(session, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(size) }, body: fs.readFileSync(input.file) });
  const j = (await put.json().catch(() => ({}))) as any;
  if (!put.ok || !j.id) throw new Error(`YouTube upload failed (${put.status}): ${j.error?.message || "no video id returned"}`);
  return j.id as string;
}

/** View counts for up to 50 video ids per call (1 quota unit each call). */
export async function fetchViews(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const token = await accessToken();
  for (let i = 0; i < ids.length; i += 50) {
    const j = await ytFetch(token, `/videos?part=statistics&id=${ids.slice(i, i + 50).join(",")}`);
    for (const v of j.items ?? []) out.set(v.id, Number(v.statistics?.viewCount ?? 0));
  }
  return out;
}
