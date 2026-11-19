// v1.9.5: Twitch USER token (authorization-code flow), only to read follower counts for Suggestions + Creators.
// Helix `/channels/followers?broadcaster_id=X&first=1` returns `total` for any broadcaster with a user token that has
// moderator:read:followers. The redirect URI is exactly APP_URL ("http://localhost:3000"): that's what Krew registered in
// his Twitch app, so Twitch sends him back to the Live page `/?code=…&state=…`, which forwards to /api/twitch/callback.
import type { Account } from "@prisma/client";
import { prisma } from "./db";
import { appUrl } from "./youtube";

const AUTHORIZE_URL = () => process.env.TWITCH_AUTHORIZE_URL || "https://id.twitch.tv/oauth2/authorize";
const TOKEN_URL = () => process.env.TWITCH_AUTH_URL || "https://id.twitch.tv/oauth2/token";
const HELIX = () => process.env.TWITCH_API_URL || "https://api.twitch.tv/helix";
export const TWITCH_USER_SCOPE = "moderator:read:followers";
export const FOLLOWERS_MAX_AGE_MS = 24 * 3600_000; // refresh at most daily per streamer

export const twitchRedirectUri = () => appUrl();

export function twitchUserAuthUrl(state: string) {
  const u = new URL(AUTHORIZE_URL());
  u.search = new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID || "", redirect_uri: twitchRedirectUri(), response_type: "code", scope: TWITCH_USER_SCOPE, state }).toString();
  return u.toString();
}

/**
 * Twitch sends Krew back to `/` (the registered redirect URI). If the Live page's query is an OAuth return
 * (state + code, or state + error), the callback path to forward to; else null.
 */
export function twitchReturnRedirect(sp: Record<string, string | string[] | undefined>): string | null {
  const one = (k: string) => (Array.isArray(sp[k]) ? (sp[k] as string[])[0] : (sp[k] as string | undefined));
  const state = one("state"), code = one("code"), error = one("error");
  if (!state || (!code && !error)) return null;
  const q = new URLSearchParams({ state });
  if (code) q.set("code", code);
  if (error) { q.set("error", error); const d = one("error_description"); if (d) q.set("error_description", d); }
  return `/api/twitch/callback?${q.toString()}`;
}

type TokenResp = { access_token?: string; refresh_token?: string; expires_in?: number; message?: string; error?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResp> {
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID || "", client_secret: process.env.TWITCH_CLIENT_SECRET || "", ...params }),
  });
  const j = (await res.json().catch(() => ({}))) as TokenResp;
  if (!res.ok || !j.access_token) throw new Error(`Twitch sign-in failed: ${j.message || j.error || res.status}`);
  return j;
}

/** Finish "Connect Twitch": swap the code for a user token, look up who it is, save it (one Twitch login is kept). */
export async function connectTwitchUser(code: string) {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: twitchRedirectUri() });
  if (!t.refresh_token) throw new Error("Twitch didn't return a refresh token. Try connecting again.");
  const res = await fetch(`${HELIX()}/users`, { headers: { "Client-Id": process.env.TWITCH_CLIENT_ID || "", Authorization: `Bearer ${t.access_token}` } });
  const user = (((await res.json().catch(() => ({}))) as any)?.data ?? [])[0] as { id: string; login: string; display_name: string } | undefined;
  if (!res.ok || !user) throw new Error("Couldn't read your Twitch account with that sign-in.");
  const data = {
    channelTitle: user.display_name || user.login, username: user.login, refreshToken: t.refresh_token, accessToken: t.access_token!,
    expiresAt: new Date(Date.now() + (t.expires_in ?? 14000) * 1000), error: null, mode: "api",
  };
  const acct = await prisma.account.upsert({
    where: { platform_channelId: { platform: "twitch", channelId: user.id } },
    update: data,
    create: { platform: "twitch", channelId: user.id, ...data },
  });
  await prisma.account.deleteMany({ where: { platform: "twitch", id: { not: acct.id } } });
  return acct;
}

export async function getTwitchUserAccount(): Promise<Account | null> {
  return prisma.account.findFirst({ where: { platform: "twitch", error: null }, orderBy: { createdAt: "desc" } });
}

async function userToken(acct: Account, force = false): Promise<string> {
  if (!force && acct.accessToken && acct.expiresAt && acct.expiresAt.getTime() > Date.now() + 60_000) return acct.accessToken;
  try {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: acct.refreshToken });
    const upd = await prisma.account.update({
      where: { id: acct.id },
      data: { accessToken: t.access_token!, refreshToken: t.refresh_token ?? acct.refreshToken, expiresAt: new Date(Date.now() + (t.expires_in ?? 14000) * 1000), error: null },
    });
    Object.assign(acct, upd);
    return t.access_token!;
  } catch (e) {
    await prisma.account.update({ where: { id: acct.id }, data: { error: `${(e as Error).message}. Connect Twitch again on the Settings page.` } });
    throw e;
  }
}

/** Follower total for one broadcaster (Helix /channels/followers, first=1). Refreshes the token once on a 401. */
export async function fetchFollowers(acct: Account, broadcasterId: string): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await userToken(acct, attempt > 0);
    const res = await fetch(`${HELIX()}/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=1`, {
      headers: { "Client-Id": process.env.TWITCH_CLIENT_ID || "", Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && attempt === 0) continue;
    const j = (await res.json().catch(() => ({}))) as { total?: number; message?: string };
    if (!res.ok || typeof j.total !== "number") throw new Error(`Twitch followers ${res.status}: ${j.message || "no total"}`);
    return j.total;
  }
  throw new Error("Twitch followers: unauthorized");
}

export const followersStale = (at: Date | null | undefined, now = Date.now()) => !at || now - at.getTime() >= FOLLOWERS_MAX_AGE_MS;

/**
 * Follower counts for these Twitch ids (fetched `max` at a time, 4 in parallel). Errors for one streamer are skipped.
 * Returns id → total for the ones fetched; a dead login stops early (the account's error says why).
 */
export async function fetchFollowersMany(acct: Account, ids: string[], max = 150): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const todo = [...new Set(ids)].slice(0, max);
  let dead = false;
  const workers = Array.from({ length: Math.min(4, todo.length) }, async () => {
    while (todo.length && !dead) {
      const id = todo.shift()!;
      try { out.set(id, await fetchFollowers(acct, id)); } catch (e) { if (/sign-in failed/.test((e as Error).message)) dead = true; }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Approved Twitch creators whose count is older than a day (Creators page): refreshed during the suggestion scan. */
export async function refreshApprovedFollowers(acct: Account, max = 60): Promise<number> {
  const rows = await prisma.streamer.findMany({ where: { approved: true, platform: "twitch" }, select: { id: true, twitchId: true, followersAt: true } });
  const stale = rows.filter((r) => followersStale(r.followersAt)).slice(0, max);
  const got = await fetchFollowersMany(acct, stale.map((r) => r.twitchId), max);
  const now = new Date();
  for (const r of stale) if (got.has(r.twitchId)) await prisma.streamer.update({ where: { id: r.id }, data: { followers: got.get(r.twitchId)!, followersAt: now } });
  return got.size;
}
