// TikTok: Login Kit (desktop flow, so plain http://localhost works), upload-to-inbox drafts, stats.
// Krew finishes each post in the TikTok app: TikTok only lets audited apps post publicly, and its
// audit rules out re-upload tools, so drafts are the route that works.
import crypto from "node:crypto";
import fs from "node:fs";
import type { Account } from "@prisma/client";
import { prisma } from "./db";
import { appUrl } from "./youtube";

const AUTH_URL = () => process.env.TIKTOK_AUTH_URL || "https://www.tiktok.com/v2/auth/authorize/";
const API = () => (process.env.TIKTOK_API_URL || "https://open.tiktokapis.com").replace(/\/$/, "");
const SCOPES = "user.info.basic,user.info.profile,video.upload,video.list";
export const MAX_PENDING_DRAFTS = 5; // TikTok: at most 5 drafts waiting in an inbox per 24h

export function tiktokConfigured() {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}
export function tiktokRedirectUri() {
  return `${appUrl()}/api/tiktok/callback`;
}

/** PKCE pair. TikTok's desktop flow wants the challenge as hex-encoded SHA-256. */
export function pkce() {
  const verifier = crypto.randomBytes(48).toString("base64url").slice(0, 64);
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("hex") };
}

export function tiktokAuthUrl(state: string, challenge: string) {
  const u = new URL(AUTH_URL());
  u.search = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY!, response_type: "code", scope: SCOPES, redirect_uri: tiktokRedirectUri(),
    state, code_challenge: challenge, code_challenge_method: "S256", disable_auto_auth: "1",
  }).toString();
  return u.toString();
}

type TokenResp = { access_token?: string; refresh_token?: string; expires_in?: number; open_id?: string; scope?: string; error?: string; error_description?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResp> {
  const res = await fetch(`${API()}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY!, client_secret: process.env.TIKTOK_CLIENT_SECRET!, ...params }),
  });
  const j = (await res.json().catch(() => ({}))) as TokenResp;
  if (!res.ok || !j.access_token) throw new Error(`TikTok sign-in failed: ${j.error_description || j.error || res.status}`);
  return j;
}

async function api<T = any>(token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(API() + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body ?? {}),
  });
  const j = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } };
  const code = j.error?.code;
  if (!res.ok || (code && code !== "ok")) throw new Error(explain(code, j.error?.message, res.status));
  return j.data as T;
}

/** TikTok's error codes, in plain words. */
export function explain(code: string | undefined, message: string | undefined, status: number) {
  switch (code) {
    case "spam_risk_too_many_pending_share": return "This TikTok account already has 5 drafts waiting. Post or delete them in the TikTok app, then try again tomorrow.";
    case "spam_risk_too_many_posts": return "TikTok's daily post limit for this account is reached. Try again tomorrow.";
    case "spam_risk_user_banned_from_posting": return "TikTok has blocked this account from posting through apps.";
    case "reached_active_user_cap": return "Your TikTok app hit its daily user limit. Try again tomorrow.";
    case "scope_not_authorized": return "This TikTok account didn't allow uploads. Reconnect it and tick every permission.";
    case "access_token_invalid": return "TikTok sign-in expired. Reconnect the account on the Settings page.";
    case "rate_limit_exceeded": return "TikTok says too many requests. Wait a minute and retry.";
    default: return `TikTok error ${code ?? status}: ${message || "request failed"}`;
  }
}

/** Finish the connect flow and save (or refresh) the account. */
export async function connectTikTok(code: string, verifier: string) {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: tiktokRedirectUri(), code_verifier: verifier });
  if (!t.refresh_token || !t.open_id) throw new Error("TikTok didn't return a refresh token.");
  const missing = ["video.upload", "video.list"].filter((s) => !(t.scope ?? "").split(",").includes(s));
  let user: { display_name?: string; username?: string } = {};
  try {
    const res = await fetch(`${API()}/v2/user/info/?fields=open_id,display_name,username`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    user = ((await res.json()) as any)?.data?.user ?? {};
  } catch { /* name is cosmetic */ }
  const data = {
    channelTitle: user.username ? `@${user.username}` : user.display_name || "TikTok account", username: user.username ?? null,
    refreshToken: t.refresh_token, accessToken: t.access_token!, expiresAt: new Date(Date.now() + (t.expires_in ?? 7200) * 1000),
    error: missing.length ? `Missing permission: ${missing.join(", ")}. Reconnect and allow everything.` : null,
  };
  return prisma.account.upsert({
    where: { platform_channelId: { platform: "tiktok", channelId: t.open_id } },
    update: data,
    create: { platform: "tiktok", channelId: t.open_id, ...data },
  });
}

async function accessToken(acct: Account) {
  if (acct.accessToken && acct.expiresAt && acct.expiresAt.getTime() > Date.now() + 60_000) return acct.accessToken;
  try {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: acct.refreshToken });
    // TikTok rotates refresh tokens: the old one stops working, so always save the new one.
    await prisma.account.update({
      where: { id: acct.id },
      data: { accessToken: t.access_token!, refreshToken: t.refresh_token ?? acct.refreshToken, expiresAt: new Date(Date.now() + (t.expires_in ?? 7200) * 1000), error: null },
    });
    return t.access_token!;
  } catch (e) {
    const msg = `${(e as Error).message}. Reconnect ${acct.channelTitle ?? "TikTok"} on the Settings page.`;
    await prisma.account.update({ where: { id: acct.id }, data: { error: msg } });
    throw new Error(msg);
  }
}

/** TikTok's chunk rules: under 64 MB goes up whole; bigger files in 10 MB chunks, the last one taking the remainder. */
export function chunkPlan(size: number) {
  const MB = 1024 * 1024;
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

/** Send a finished clip to the account's TikTok inbox as a draft. Returns the publish_id. */
export async function uploadDraft(acct: Account, file: string): Promise<string> {
  const token = await accessToken(acct);
  const size = fs.statSync(file).size;
  const plan = chunkPlan(size);
  const init = await api<{ publish_id: string; upload_url: string }>(token, "/v2/post/publish/inbox/video/init/", {
    source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count },
  });
  const buf = fs.readFileSync(file);
  for (let i = 0; i < plan.count; i++) {
    const start = i * plan.chunkSize;
    const end = i === plan.count - 1 ? size - 1 : start + plan.chunkSize - 1;
    const res = await fetch(init.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
      body: buf.subarray(start, end + 1),
    });
    if (![200, 201, 206].includes(res.status)) throw new Error(`TikTok upload failed at chunk ${i + 1}/${plan.count} (HTTP ${res.status})`);
  }
  return init.publish_id;
}

export type DraftStatus = { status: string; postIds: string[]; failReason: string | null };

export async function draftStatus(acct: Account, publishId: string): Promise<DraftStatus> {
  const token = await accessToken(acct);
  const d = await api<{ status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>(token, "/v2/post/publish/status/fetch/", { publish_id: publishId });
  return { status: d.status, postIds: (d.publicaly_available_post_id ?? []).map(String), failReason: d.fail_reason ?? null };
}

export type TikTokStats = { views: number; likes: number | null; comments: number | null };

/** Stats for videos this account posted (20 ids per call). */
export async function fetchTikTokStats(acct: Account, ids: string[]): Promise<Map<string, TikTokStats>> {
  const out = new Map<string, TikTokStats>();
  if (!ids.length) return out;
  const token = await accessToken(acct);
  for (let i = 0; i < ids.length; i += 20) {
    const d = await api<{ videos?: { id: string; view_count?: number; like_count?: number; comment_count?: number }[] }>(
      token, "/v2/video/query/?fields=id,view_count,like_count,comment_count", { filters: { video_ids: ids.slice(i, i + 20) } });
    for (const v of d.videos ?? []) out.set(String(v.id), { views: v.view_count ?? 0, likes: v.like_count ?? null, comments: v.comment_count ?? null });
  }
  return out;
}

export function tiktokVideoUrl(acct: Account, id: string) {
  return acct.username ? `https://www.tiktok.com/@${acct.username}/video/${id}` : `https://www.tiktok.com/video/${id}`;
}
