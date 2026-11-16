// Minimal Twitch Helix client (app access token, client-credentials flow).
// Overridable so tests (and `npm run doctor` against the stand-ins) can point at a mock server.
const HELIX = () => process.env.TWITCH_API_URL || "https://api.twitch.tv/helix";
const AUTH_URL = () => process.env.TWITCH_AUTH_URL || "https://id.twitch.tv/oauth2/token";

let token: { value: string; expiresAt: number } | null = null;
let gameIdCache: string | null = null;

export function twitchConfigured() {
  return Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
}

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) throw new Error("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET missing in .env");
  const res = await fetch(AUTH_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Twitch token request failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return token.value;
}

type Params = Record<string, string | number | string[] | undefined>;

export async function helix<T = any>(endpoint: string, params: Params = {}): Promise<{ data: T[]; pagination?: { cursor?: string } }> {
  const url = new URL(HELIX() + endpoint);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
  }
  let refreshed = false, rateRetries = 0, serverRetries = 0;
  for (;;) {
    const res = await fetch(url, {
      headers: { "Client-Id": process.env.TWITCH_CLIENT_ID!, Authorization: `Bearer ${await getToken()}` },
    });
    if (res.status === 401) {
      if (refreshed) throw new Error(`Twitch ${endpoint} unauthorized`);
      refreshed = true; token = null; continue;
    }
    if (res.status === 429 && rateRetries < 2) {
      rateRetries++;
      await sleep(rateLimitWait(res.headers.get("Ratelimit-Reset")));
      continue;
    }
    if (res.status >= 500 && serverRetries < 1) {
      serverRetries++;
      await sleep(2000);
      continue;
    }
    if (!res.ok) throw new Error(`Twitch ${endpoint} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as any;
  }
}

/** ms to wait after a 429: until Ratelimit-Reset (unix seconds), 5s if missing, capped at 60s. */
export function rateLimitWait(reset: string | null, now = Date.now()): number {
  const sec = reset ? Number(reset) : NaN;
  if (!Number.isFinite(sec)) return 5000;
  return Math.min(60_000, Math.max(0, sec * 1000 - now));
}

let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Swap the retry sleep (tests). Returns the previous one. */
export function setSleep(fn: (ms: number) => Promise<void>) {
  const prev = sleep;
  sleep = fn;
  return prev;
}

/** Fetch every page (capped) of a paginated endpoint. */
export async function helixAll<T = any>(endpoint: string, params: Params, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await helix<T>(endpoint, { ...params, after });
    out.push(...page.data);
    after = page.pagination?.cursor;
    if (!after || page.data.length === 0) break;
  }
  return out;
}

export type TwitchStream = {
  id: string; user_id: string; user_login: string; user_name: string; game_id: string;
  title: string; viewer_count: number; started_at: string; thumbnail_url: string;
};
export type TwitchClip = {
  id: string; url: string; broadcaster_id: string; broadcaster_name: string; creator_name: string;
  video_id: string; game_id: string; title: string; view_count: number; created_at: string;
  thumbnail_url: string; duration: number; vod_offset: number | null;
};
export type TwitchUser = { id: string; login: string; display_name: string; profile_image_url: string };

/** GTA 6's Twitch category id. Override with TWITCH_GAME_ID if Twitch names it differently. */
export async function getGameId(): Promise<string> {
  if (process.env.TWITCH_GAME_ID) return process.env.TWITCH_GAME_ID;
  if (gameIdCache) return gameIdCache;
  const names = [process.env.TWITCH_GAME_NAME, "Grand Theft Auto VI", "Grand Theft Auto 6"].filter(Boolean) as string[];
  const exact = await helix<{ id: string; name: string }>("/games", { name: names });
  if (exact.data[0]) return (gameIdCache = exact.data[0].id);
  const search = await helix<{ id: string; name: string }>("/search/categories", { query: "Grand Theft Auto VI", first: 10 });
  const hit = search.data.find((g) => /grand theft auto (vi|6)\b/i.test(g.name));
  if (!hit) throw new Error("Couldn't find the GTA 6 category on Twitch. Set TWITCH_GAME_ID in .env.");
  return (gameIdCache = hit.id);
}

export function getLiveStreams(gameId: string) {
  return helixAll<TwitchStream>("/streams", { game_id: gameId, first: 100, type: "live" }, 5);
}

/** Live streams for specific users (any game), 100 ids per call. */
export async function getStreamsByUserIds(ids: string[]) {
  const out: TwitchStream[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await helix<TwitchStream>("/streams", { user_id: chunk, first: 100, type: "live" });
    out.push(...r.data);
  }
  return out;
}

export function getClips(params: { game_id?: string; broadcaster_id?: string; started_at: string; ended_at?: string }, maxPages = 2) {
  return helixAll<TwitchClip>("/clips", { ...params, first: 100 }, maxPages);
}

export async function getUsers(opts: { logins?: string[]; ids?: string[] }) {
  const out: TwitchUser[] = [];
  const logins = opts.logins ?? [], ids = opts.ids ?? [];
  for (let i = 0; i < Math.max(logins.length, ids.length); i += 100) {
    const r = await helix<TwitchUser>("/users", { login: logins.slice(i, i + 100), id: ids.slice(i, i + 100) });
    out.push(...r.data);
  }
  return out;
}

/** The VOD being recorded for a live stream right now (null if past broadcasts are off). */
export async function getLiveVodId(userId: string, streamId: string | null): Promise<string | null> {
  const r = await helix<{ id: string; stream_id: string | null }>("/videos", { user_id: userId, type: "archive", first: 1 });
  const v = r.data[0];
  if (!v) return null;
  return !streamId || v.stream_id === streamId ? v.id : null;
}
