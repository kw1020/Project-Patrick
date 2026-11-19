// v2.0.3 Instagram: Business Login for Instagram (Instagram API with Instagram Login), Reels publish, Reels insights.
//
// Sources (Meta docs, read 2026-11-19):
// - Login + tokens: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
//   authorize = www.instagram.com/oauth/authorize, code (1 hour, single use) -> api.instagram.com/oauth/access_token (short-lived,
//   1 hour) -> graph.instagram.com/access_token?grant_type=ig_exchange_token (long-lived, 60 days) ->
//   graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token (another 60 days; the token must be >= 24h old and
//   not expired; a token not refreshed within 60 days dies and Krew must reconnect).
// - Who can use it without App Review: https://developers.facebook.com/documentation/instagram-platform/app-review
//   "My app is only for a business I own or manage | Instagram Login | Standard Access | Not required". Standard Access only
//   works for Instagram professional (Business/Creator) accounts that have a role on the app (added in the App Dashboard).
// - Publishing: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
//   container (POST /<IG_ID>/media, media_type=REELS) -> poll GET /<container>?fields=status_code (EXPIRED | ERROR | FINISHED |
//   IN_PROGRESS | PUBLISHED; Meta suggests once a minute for at most 5 minutes) -> POST /<IG_ID>/media_publish creation_id.
//   Limit: 100 API-published posts per account per moving 24 hours (GET /<IG_ID>/content_publishing_limit shows usage).
// - Local file upload: https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads
//   container with upload_type=resumable returns { id, uri }; POST the bytes to rupload.facebook.com/ig-api-upload/<ver>/<id>
//   with headers "Authorization: OAuth <token>", "offset: 0", "file_size: <bytes>". NOTE: Meta's page says this is "available
//   only for apps that have implemented Facebook Login for Business"; third-party 2026 guides show the same flow on
//   graph.instagram.com with Instagram Login tokens. UNVERIFIED here (no real account in the build sandbox): if Meta refuses it
//   for Instagram Login apps, the error below says so plainly. A Meta forum thread (Nov 2026) reports rupload answering HTTP 400
//   ProcessingFailedError for 45s+ videos although the upload worked, so a failed rupload is NOT treated as final: the
//   container status decides.
// - Caption: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
//   max 2200 characters, 30 hashtags, 20 @ tags. Reels: MP4/MOV, H.264, AAC, 3s-15min, <= 300 MB.
// - Insights: https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights
//   needs instagram_business_manage_insights; "plays" was retired on 2025-04-21, "views" replaces it.
// - Error codes: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes
import fs from "node:fs";
import type { Account } from "@prisma/client";
import { prisma } from "./db";
import { appUrl } from "./youtube";

const AUTH_URL = () => process.env.INSTAGRAM_AUTH_URL || "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = () => process.env.INSTAGRAM_TOKEN_URL || "https://api.instagram.com/oauth/access_token";
const GRAPH = () => (process.env.INSTAGRAM_GRAPH_URL || "https://graph.instagram.com").replace(/\/$/, "");
const RUPLOAD = () => (process.env.INSTAGRAM_UPLOAD_URL || "https://rupload.facebook.com").replace(/\/$/, "");
const VERSION = () => process.env.INSTAGRAM_API_VERSION || "v27.0";
/** Minimum to post Reels + read likes/comments; insights (views) is asked for too unless INSTAGRAM_INSIGHTS=off. */
const BASE_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];
export const INSIGHTS_SCOPE = "instagram_business_manage_insights";
export const IG_DAILY_LIMIT = 100; // posts per account per moving 24h (Meta)
export const IG_CAPTION_MAX = 2200;
export const IG_HASHTAG_MAX = 30;

export function instagramConfigured() {
  return Boolean(process.env.INSTAGRAM_CLIENT_ID && process.env.INSTAGRAM_CLIENT_SECRET);
}
export function instagramScopes() {
  return process.env.INSTAGRAM_INSIGHTS === "off" ? BASE_SCOPES : [...BASE_SCOPES, INSIGHTS_SCOPE];
}

/**
 * Meta only saves https redirect URIs for Instagram login. Clip Factory runs on plain http://localhost, so by default the
 * redirect URI is the SAME address with https (https://localhost:3000/api/instagram/callback): Instagram sends the browser
 * there, the page can't load (no https on localhost), and Krew either changes https -> http in the address bar or pastes
 * the address into Settings; both land on the real http callback below with the code. INSTAGRAM_REDIRECT_URI overrides it
 * (e.g. an https tunnel address) and must match the App Dashboard exactly.
 */
export function instagramRedirectUri() {
  if (process.env.INSTAGRAM_REDIRECT_URI) return process.env.INSTAGRAM_REDIRECT_URI;
  return `${appUrl().replace(/^http:\/\//i, "https://")}/api/instagram/callback`;
}

export function instagramAuthUrl(state: string) {
  const u = new URL(AUTH_URL());
  u.search = new URLSearchParams({
    client_id: process.env.INSTAGRAM_CLIENT_ID!, redirect_uri: instagramRedirectUri(), response_type: "code",
    scope: instagramScopes().join(","), state, enable_fb_login: "false", force_reauth: "true",
  }).toString();
  return u.toString();
}

export { pastedCallbackPath } from "./instagram-paste";

type GraphError = { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string; error_user_title?: string };

/** Meta's Instagram error codes, in plain words (codes from the error-codes reference above). */
export function explainInstagram(err: GraphError | undefined, status: number): string {
  const code = err?.code, sub = err?.error_subcode;
  switch (sub) {
    case 2207042: return "This Instagram account hit Instagram's limit of 100 posts a day through apps. Try again tomorrow.";
    case 2207050: return "Instagram says this account is inactive, checkpointed or restricted. Open the Instagram app, fix the account, then reconnect it.";
    case 2207051: return "Instagram blocked this post as possible spam. Wait a while, post one by hand, then try again.";
    case 2207026: return "Instagram didn't accept the video format (it wants MP4, H.264 + AAC, 3s to 15 min). Try Re-cut, then post again.";
    case 2207020: case 2207008: return "The Instagram upload expired before it was published. Press Post again.";
    case 2207010: return "The caption is too long for Instagram (2200 characters, 30 hashtags, 20 @ tags). Shorten it and post again.";
    case 2207001: case 2207003: return "Instagram had a server problem with this upload. Press Post again in a few minutes.";
  }
  if (code === 190) return "Instagram sign-in expired or was removed. Reconnect the account on the Settings page.";
  if (code === 10 || code === 200 || code === 3) return "This Instagram account didn't give Clip Factory permission to post. Reconnect it and allow everything (the account must be Business or Creator and added to your Meta app).";
  if (code === 4 || code === 17 || code === 32 || code === 613) return "Instagram says too many requests. Wait an hour and try again.";
  if (code === 9) return "Instagram's posting limit for this account is reached. Try again tomorrow.";
  if (code === 100 && /resumable|upload_type/i.test(err?.message ?? "")) return "Instagram refused uploading the video file directly (Meta may only allow that for Facebook-login apps). See README: Connect Instagram, \"If posting says Instagram refused uploading\".";
  const msg = err?.error_user_msg || err?.message || "request failed";
  return `Instagram error ${code ?? status}${sub ? `/${sub}` : ""}: ${msg}`;
}

async function graph<T = any>(path: string, opts: { token: string; method?: "GET" | "POST"; params?: Record<string, string> }): Promise<T> {
  const u = new URL(`${GRAPH()}/${VERSION()}${path}`);
  const params = new URLSearchParams(opts.params ?? {});
  let body: URLSearchParams | undefined;
  if ((opts.method ?? "GET") === "GET") for (const [k, v] of params) u.searchParams.set(k, v);
  else body = params;
  const res = await fetch(u, { method: opts.method ?? "GET", headers: { Authorization: `Bearer ${opts.token}` }, body });
  const j = (await res.json().catch(() => ({}))) as T & { error?: GraphError };
  if (!res.ok || (j as any)?.error) throw new Error(explainInstagram((j as any)?.error, res.status));
  return j;
}

type TokenResp = { access_token?: string; user_id?: string | number; permissions?: string | string[]; expires_in?: number; error_type?: string; error_message?: string; error?: GraphError };

/** Short-lived (1h) -> long-lived (60 days). */
async function longLived(short: string): Promise<{ token: string; expiresIn: number }> {
  const u = new URL(`${GRAPH()}/access_token`);
  u.search = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: process.env.INSTAGRAM_CLIENT_SECRET!, access_token: short }).toString();
  const res = await fetch(u);
  const j = (await res.json().catch(() => ({}))) as TokenResp;
  if (!res.ok || !j.access_token) throw new Error(`Instagram sign-in failed: ${j.error ? explainInstagram(j.error, res.status) : j.error_message || res.status}`);
  return { token: j.access_token, expiresIn: j.expires_in ?? 60 * 86400 };
}

/** Finish the connect flow: code -> short-lived -> long-lived token, look the account up, save (or refresh) it. */
export async function connectInstagram(code: string) {
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.INSTAGRAM_CLIENT_ID!, client_secret: process.env.INSTAGRAM_CLIENT_SECRET!, grant_type: "authorization_code", redirect_uri: instagramRedirectUri(), code }),
  });
  const raw = (await res.json().catch(() => ({}))) as TokenResp & { data?: TokenResp[] };
  const t = raw.data?.[0] ?? raw; // Meta documents { data: [ {...} ] }; older answers were flat
  if (!res.ok || !t.access_token) {
    const why = t.error_message || raw.error_message || (raw.error ? explainInstagram(raw.error, res.status) : `HTTP ${res.status}`);
    throw new Error(`Instagram sign-in failed: ${why}${/redirect/i.test(why) ? `. The redirect URI in your Meta app must be exactly ${instagramRedirectUri()}` : ""}`);
  }
  const granted = (Array.isArray(t.permissions) ? t.permissions : String(t.permissions ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
  const long = await longLived(t.access_token);
  const me = await graph<{ id?: string; user_id?: string | number; username?: string; account_type?: string; name?: string }>("/me", { token: long.token, params: { fields: "id,user_id,username,account_type,name" } });
  const igId = String(me.user_id ?? me.id ?? t.user_id ?? "");
  if (!igId) throw new Error("Instagram didn't say which account this is. Try connecting again.");
  const problems: string[] = [];
  if (me.account_type && !/business|creator/i.test(me.account_type)) problems.push("This is a personal Instagram account. In the Instagram app: Settings → Account type and tools → Switch to professional account (Creator or Business), then reconnect.");
  if (granted.length && !granted.includes("instagram_business_content_publish")) problems.push("Missing permission: posting. Reconnect and allow everything.");
  const data = {
    channelTitle: me.username ? `@${me.username}` : me.name || "Instagram account", username: me.username ?? null, handle: me.username ? `@${me.username}` : null,
    refreshToken: long.token, accessToken: long.token, expiresAt: new Date(Date.now() + long.expiresIn * 1000),
    scopes: granted.join(",") || null, mode: "api", error: problems.length ? problems.join(" ") : null,
  };
  return prisma.account.upsert({
    where: { platform_channelId: { platform: "instagram", channelId: igId } },
    update: data,
    create: { platform: "instagram", channelId: igId, ...data },
  });
}

/** Refresh when the long-lived token has under 7 days left (and is >= 24h old, Meta's rule). Returns a usable token. */
export async function instagramToken(acct: Account): Promise<string> {
  const token = acct.accessToken || acct.refreshToken;
  const left = acct.expiresAt ? acct.expiresAt.getTime() - Date.now() : 0;
  if (!token) throw new Error(`Reconnect ${acct.channelTitle ?? "Instagram"} on the Settings page.`);
  if (acct.expiresAt && left <= 0) {
    const msg = `Instagram sign-in for ${acct.channelTitle ?? "this account"} ran out (Instagram tokens last 60 days). Reconnect it on the Settings page.`;
    await prisma.account.update({ where: { id: acct.id }, data: { error: msg } });
    throw new Error(msg);
  }
  const age = acct.expiresAt ? 60 * 86400_000 - left : Infinity; // issued ~60 days before expiry
  if (left > 7 * 86400_000 || age < 24 * 3600_000) return token;
  return refreshInstagram(acct, token);
}

async function refreshInstagram(acct: Account, token: string) {
  const u = new URL(`${GRAPH()}/refresh_access_token`);
  u.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token }).toString();
  const res = await fetch(u);
  const j = (await res.json().catch(() => ({}))) as TokenResp;
  if (!res.ok || !j.access_token) {
    const msg = `${j.error ? explainInstagram(j.error, res.status) : "Instagram didn't refresh the sign-in"}. Reconnect ${acct.channelTitle ?? "Instagram"} on the Settings page.`;
    await prisma.account.update({ where: { id: acct.id }, data: { error: msg } });
    throw new Error(msg);
  }
  await prisma.account.update({ where: { id: acct.id }, data: { accessToken: j.access_token, refreshToken: j.access_token, expiresAt: new Date(Date.now() + (j.expires_in ?? 60 * 86400) * 1000), error: null } });
  return j.access_token;
}

/** For `npm run doctor` and the daily check: refresh now if it's due, and make sure the token still works. */
export async function checkInstagram(acct: Account) {
  const token = await instagramToken(acct);
  await graph("/me", { token, params: { fields: "id,username" } });
  return token;
}

/** Instagram's caption rules: <= 30 hashtags (the first 30 are kept) and <= 2200 characters. */
export function instagramCaption(caption: string): string {
  let seen = 0;
  const kept = caption.replace(/(^|\s)#[^\s#]+/g, (m) => (++seen <= IG_HASHTAG_MAX ? m : ""));
  return kept.replace(/[ \t]+\n/g, "\n").trim().slice(0, IG_CAPTION_MAX);
}

export type PublishOpts = { pollMs?: number; maxWaitMs?: number; onContainer?: (containerId: string) => Promise<void> };
export type Published = { mediaId: string; containerId: string; permalink: string | null };

/**
 * Publish a local MP4 as a Reel: resumable container -> upload the file -> wait for FINISHED -> media_publish -> permalink.
 * `onContainer` runs right after the container exists (the poster records it, so a worker restart can never publish twice).
 */
export async function publishReel(acct: Account, file: string, caption: string, opts: PublishOpts = {}): Promise<Published> {
  const token = await instagramToken(acct);
  const igId = acct.channelId!;
  const size = fs.statSync(file).size;
  const c = await graph<{ id: string; uri?: string }>(`/${igId}/media`, {
    token, method: "POST", params: { media_type: "REELS", upload_type: "resumable", caption: instagramCaption(caption), share_to_feed: "true" },
  });
  if (!c.id) throw new Error("Instagram didn't make an upload slot. Press Post again.");
  await opts.onContainer?.(c.id);
  // Meta returns the exact upload URI; build it ourselves only if it's missing (or a stand-in URL is set for tests).
  const uri = process.env.INSTAGRAM_UPLOAD_URL || !c.uri ? `${RUPLOAD()}/ig-api-upload/${VERSION()}/${c.id}` : c.uri;
  let uploadNote = "";
  try {
    const up = await fetch(uri, { method: "POST", headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(size) }, body: fs.readFileSync(file) });
    const uj = (await up.json().catch(() => ({}))) as { success?: boolean; debug_info?: { message?: string; type?: string }; error?: GraphError };
    if (uj.error) throw new Error(explainInstagram(uj.error, up.status));
    if (!up.ok || uj.success === false) uploadNote = uj.debug_info?.message || `HTTP ${up.status}`;
  } catch (e) {
    if (/sign-in|permission|refused/i.test((e as Error).message)) throw e;
    uploadNote = (e as Error).message;
  }
  // The container status decides (see the rupload note at the top). Meta suggests polling for up to 5 minutes.
  const pollMs = opts.pollMs ?? Number(process.env.INSTAGRAM_POLL_MS || 10_000);
  const deadline = Date.now() + (opts.maxWaitMs ?? 6 * 60_000);
  let status = "IN_PROGRESS", detail = "";
  for (;;) {
    const s = await graph<{ status_code?: string; status?: string }>(`/${c.id}`, { token, params: { fields: "status_code,status" } });
    status = s.status_code ?? "IN_PROGRESS"; detail = s.status ?? "";
    if (status === "FINISHED" || status === "PUBLISHED") break;
    if (status === "ERROR") throw new Error(`Instagram couldn't process the video${detail ? ` (${detail})` : ""}${uploadNote ? `; upload said: ${uploadNote}` : ""}. Try Re-cut, then post again.`);
    if (status === "EXPIRED") throw new Error("The Instagram upload expired before it was published. Press Post again.");
    if (Date.now() + pollMs > deadline) throw new Error(`Instagram is still processing the video after ${Math.round((opts.maxWaitMs ?? 360_000) / 60_000)} minutes${uploadNote ? ` (upload said: ${uploadNote})` : ""}. It was NOT published; press Post again later.`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const pub = await graph<{ id: string }>(`/${igId}/media_publish`, { token, method: "POST", params: { creation_id: c.id } });
  let permalink: string | null = null;
  try { permalink = (await graph<{ permalink?: string }>(`/${pub.id}`, { token, params: { fields: "permalink" } })).permalink ?? null; } catch { /* the post is up; the link is cosmetic */ }
  return { mediaId: pub.id, containerId: c.id, permalink };
}

/** Container status (the stats sync uses it to settle a post whose worker stopped mid-publish). */
export async function containerStatus(acct: Account, containerId: string): Promise<string> {
  const token = await instagramToken(acct);
  return (await graph<{ status_code?: string }>(`/${containerId}`, { token, params: { fields: "status_code" } })).status_code ?? "UNKNOWN";
}

export type InstagramStats = { views: number | null; likes: number | null; comments: number | null };

/** Views (insights, if that permission was granted) + likes/comments for each Reel. One failing Reel doesn't stop the rest. */
export async function fetchInstagramStats(acct: Account, ids: string[]): Promise<Map<string, InstagramStats>> {
  const out = new Map<string, InstagramStats>();
  if (!ids.length) return out;
  const token = await instagramToken(acct);
  const canInsights = !acct.scopes || acct.scopes.split(",").includes(INSIGHTS_SCOPE);
  for (const id of ids) {
    try {
      const f = await graph<{ like_count?: number; comments_count?: number }>(`/${id}`, { token, params: { fields: "like_count,comments_count" } });
      const s: InstagramStats = { views: null, likes: f.like_count ?? null, comments: f.comments_count ?? null };
      if (canInsights) {
        try {
          const ins = await graph<{ data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(`/${id}/insights`, { token, params: { metric: "views,likes,comments" } });
          for (const m of ins.data ?? []) {
            const v = m.total_value?.value ?? m.values?.[0]?.value;
            if (typeof v !== "number") continue;
            if (m.name === "views") s.views = v; else if (m.name === "likes") s.likes = v; else if (m.name === "comments") s.comments = v;
          }
        } catch { /* no insights permission / too new: likes + comments still count */ }
      }
      out.set(id, s);
    } catch { /* deleted Reel etc. */ }
  }
  return out;
}
