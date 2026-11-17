// "Add a list of creators" (Streamers page): look a list of names up on Twitch and YouTube, then approve the
// matches Krew ticks. Looking up never approves anything; approveResolved only runs on his click.
//
// Twitch: Helix /search/channels (no follower counts there), best match = exact name (ignoring case, spaces,
//   underscores) > live + name starts with it > name starts with it > live > first result. Only exact matches
//   come pre-ticked in the table.
// YouTube: with YOUTUBE_API_KEY, /channels?forHandle=@<name without spaces> (1 unit), else /search (100 units) +
//   /channels, biggest subscriber count among channels whose title/handle loosely matches. Without a key: yt-dlp
//   on youtube.com/@<NameWithoutSpaces>.
// Rows are stored exactly like the single-add flows: Twitch rows by Helix user id; YouTube rows with
// twitchId "yt:<channelId>", login = @handle lowercased. Streamer.login is unique PER PLATFORM (v1.7.1), so a creator
// with the same name on Twitch and YouTube gets both rows. Only a same-platform clash (an old row still holding the
// name after a rename) stops an add, and the result says so in plain words.
import { prisma } from "./db";
import { loginTakenBy } from "./streamers";
import { getUsers, helix, twitchConfigured } from "./twitch";
import { resolveChannel } from "./ytdlp";
import { YouTubeApiError, youtubeKeyConfigured, ytApi } from "../workers/suggest-youtube";

/** What's stored when Krew approves without typing a note (2026-11-17: approving no longer needs a reason). */
export const DEFAULT_APPROVAL_NOTE = "Approved by Krew";
export const MAX_NAMES = 40;

export type Cell<T> = { status: "found"; match: T } | { status: "none" } | { status: "error"; reason: string };
export type TwitchHit = { id: string; login: string; name: string; avatar: string | null; isLive: boolean; game: string | null; exact: boolean; approved: boolean };
export type YtHit = { channelId: string; handle: string; title: string; subscribers: number | null; avatar: string | null; exact: boolean; approved: boolean };
export type ResolvedRow = { name: string; twitch: Cell<TwitchHit>; youtube: Cell<YtHit> };
export type ResolveResult = { rows: ResolvedRow[]; notes: string[] };

/** Lowercase letters + digits only: "Kai Cenat" = "kaicenat" = "Kai_Cenat". */
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Trim, drop "@", blank lines and repeats (same squashed name). */
export function cleanNames(lines: string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of lines) {
    const name = String(raw ?? "").trim().replace(/^@/, "").replace(/\s+/g, " ").slice(0, 60);
    const key = squash(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// ---------- Twitch ----------
export type HelixChannel = { id: string; broadcaster_login: string; display_name: string; thumbnail_url?: string; is_live?: boolean; game_name?: string };

export function pickTwitch(name: string, list: HelixChannel[]): { ch: HelixChannel; exact: boolean } | null {
  const q = squash(name);
  if (!q || !list.length) return null;
  const exact = list.find((c) => squash(c.display_name ?? "") === q || squash(c.broadcaster_login ?? "") === q);
  if (exact) return { ch: exact, exact: true };
  const prefix = (c: HelixChannel) => squash(c.broadcaster_login ?? "").startsWith(q) || squash(c.display_name ?? "").startsWith(q);
  const ch = list.find((c) => c.is_live && prefix(c)) ?? list.find(prefix) ?? list.find((c) => c.is_live) ?? list[0];
  return { ch, exact: false };
}

async function findTwitch(name: string): Promise<Cell<TwitchHit>> {
  const r = await helix<HelixChannel>("/search/channels", { query: name, first: 10 });
  const hit = pickTwitch(name, r.data ?? []);
  if (!hit) return { status: "none" };
  const c = hit.ch;
  return {
    status: "found",
    match: { id: c.id, login: c.broadcaster_login, name: c.display_name || c.broadcaster_login, avatar: c.thumbnail_url || null, isLive: Boolean(c.is_live), game: c.game_name || null, exact: hit.exact, approved: false },
  };
}

// ---------- YouTube ----------
type ApiChannel = {
  id: string;
  snippet?: { title?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
};

const subsOf = (c: ApiChannel) => (c.statistics?.hiddenSubscriberCount || c.statistics?.subscriberCount == null ? null : Number(c.statistics.subscriberCount) || 0);

/** Title or @handle contains the name (or the other way round), ignoring case and spaces. */
export function looseMatch(name: string, title: string, handle: string) {
  const q = squash(name), t = squash(title), h = squash(handle);
  if (!q) return false;
  return t.includes(q) || h.includes(q) || (t.length >= 3 && q.includes(t)) || (h.length >= 3 && q.includes(h));
}

function ytCell(c: ApiChannel, exact: boolean): Cell<YtHit> {
  const handle = (c.snippet?.customUrl ?? "").trim().replace(/^@/, "").toLowerCase();
  const title = c.snippet?.title || handle;
  if (!/^[a-z0-9._-]{3,30}$/.test(handle)) return { status: "error", reason: `found "${title}" but it has no @handle (needed for the credit link)` };
  const t = c.snippet?.thumbnails ?? {};
  const avatar = t.medium?.url || t.default?.url || t.high?.url || null;
  return { status: "found", match: { channelId: c.id, handle, title, subscribers: subsOf(c), avatar, exact, approved: false } };
}

async function findYouTubeApi(name: string): Promise<Cell<YtHit>> {
  const handle = name.replace(/\s+/g, "");
  if (/^[A-Za-z0-9._-]{3,30}$/.test(handle)) {
    const r = await ytApi<{ items?: ApiChannel[] }>("/channels", { part: "snippet,statistics", forHandle: `@${handle}` });
    if (r.items?.[0]) return ytCell(r.items[0], true);
  }
  const s = await ytApi<{ items?: { id?: { channelId?: string }; snippet?: { channelId?: string } }[] }>("/search", { part: "snippet", type: "channel", q: name, maxResults: "5" });
  const ids = [...new Set((s.items ?? []).map((i) => i.id?.channelId || i.snippet?.channelId).filter((x): x is string => Boolean(x)))];
  if (!ids.length) return { status: "none" };
  const c = await ytApi<{ items?: ApiChannel[] }>("/channels", { part: "snippet,statistics", id: ids.join(","), maxResults: "50" });
  const loose = (c.items ?? []).filter((ch) => looseMatch(name, ch.snippet?.title ?? "", ch.snippet?.customUrl ?? ""));
  if (!loose.length) return { status: "none" };
  loose.sort((a, b) => (subsOf(b) ?? -1) - (subsOf(a) ?? -1));
  return ytCell(loose[0], squash(loose[0].snippet?.title ?? "") === squash(name) || squash(loose[0].snippet?.customUrl ?? "") === squash(name));
}

async function findYouTubeYtdlp(name: string): Promise<Cell<YtHit>> {
  const handle = name.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(handle)) return { status: "none" };
  try {
    const ch = await resolveChannel(`@${handle}`);
    const h = ch.handle.toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(h)) return { status: "error", reason: "no usable @handle" };
    return { status: "found", match: { channelId: ch.channelId, handle: h, title: ch.title, subscribers: null, avatar: ch.avatar, exact: true, approved: false } };
  } catch (e) {
    const msg = (e as Error).message;
    if (/does not exist|not found|404|doesn't look like/i.test(msg)) return { status: "none" };
    return { status: "error", reason: msg.replace(/^YouTube couldn't find that channel \((.*)\)\.$/, "$1").slice(0, 160) };
  }
}

// ---------- Resolve a whole list ----------
const short = (e: unknown) => ((e as Error)?.message || String(e)).replace(/\s+/g, " ").slice(0, 140);

/** Look every name up (4 at a time, 60s for the whole list). One name failing never breaks the table. */
export async function resolveCreators(lines: string[], opts: { concurrency?: number; timeoutMs?: number } = {}): Promise<ResolveResult> {
  const { concurrency = 4, timeoutMs = 60_000 } = opts;
  const all = cleanNames(lines);
  const names = all.slice(0, MAX_NAMES);
  const notes: string[] = [];
  if (all.length > names.length) notes.push(`Only the first ${MAX_NAMES} names were checked. Add the rest in another go.`);
  const twitchOn = twitchConfigured();
  if (!twitchOn) notes.push("Twitch keys are missing in .env, so Twitch wasn't checked.");
  const ytKey = youtubeKeyConfigured();
  let ytStopped: string | null = null; // quota used up / bad key: stop asking YouTube for the rest of the list

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => { timedOut = true; rej(new Error("ran out of time")); }, timeoutMs); });
  deadline.catch(() => {});
  const bounded = <T>(p: Promise<T>) => Promise.race([p, deadline]);

  const twitchCell = async (name: string): Promise<Cell<TwitchHit>> => {
    if (!twitchOn) return { status: "error", reason: "no Twitch keys" };
    try { return await bounded(findTwitch(name)); } catch (e) { return { status: "error", reason: short(e) }; }
  };
  const youtubeCell = async (name: string): Promise<Cell<YtHit>> => {
    if (ytStopped) return { status: "error", reason: ytStopped };
    try {
      return await bounded(ytKey ? findYouTubeApi(name) : findYouTubeYtdlp(name));
    } catch (e) {
      if (e instanceof YouTubeApiError && e.fatal) {
        ytStopped = e.message;
        return { status: "error", reason: e.message };
      }
      return { status: "error", reason: short(e) };
    }
  };

  const rows: ResolvedRow[] = new Array(names.length);
  let next = 0;
  const work = async () => {
    for (;;) {
      const i = next++;
      if (i >= names.length) return;
      const name = names[i];
      if (timedOut) { rows[i] = { name, twitch: { status: "error", reason: "ran out of time" }, youtube: { status: "error", reason: "ran out of time" } }; continue; }
      const [twitch, youtube] = await Promise.all([twitchCell(name), youtubeCell(name)]);
      rows[i] = { name, twitch, youtube };
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, names.length)) }, work));
  } finally {
    clearTimeout(timer);
  }
  if (ytStopped) notes.push(`YouTube: ${ytStopped}. Some YouTube matches weren't checked.`);
  if (timedOut) notes.push("Some names took too long to check. Try those again in a minute.");

  // Mark matches that are already approved, so the table can say so.
  const tIds = rows.flatMap((r) => (r.twitch.status === "found" ? [r.twitch.match.id] : []));
  const yIds = rows.flatMap((r) => (r.youtube.status === "found" ? [`yt:${r.youtube.match.channelId}`] : []));
  if (tIds.length || yIds.length) {
    const done = new Set((await prisma.streamer.findMany({ where: { approved: true, twitchId: { in: [...tIds, ...yIds] } }, select: { twitchId: true } })).map((s) => s.twitchId));
    for (const r of rows) {
      if (r.twitch.status === "found") r.twitch.match.approved = done.has(r.twitch.match.id);
      if (r.youtube.status === "found") r.youtube.match.approved = done.has(`yt:${r.youtube.match.channelId}`);
    }
  }
  return { rows, notes };
}

// ---------- Approve the ticked ones ----------
export type ApprovePick = {
  name: string;
  twitch?: { id: string; login: string; name: string; avatar: string | null };
  youtube?: { channelId: string; handle: string; title: string; avatar: string | null };
};
export type ApproveItem = { name: string; platform: "twitch" | "youtube"; ok: boolean; message: string };
export type ApproveResult = { items: ApproveItem[]; twitchApproved: number; youtubeApproved: number };

/**
 * Approve ticked matches. A creator found on both platforms gets BOTH rows (login is unique per platform since v1.7.1).
 * Idempotent: rows that are already approved are left untouched, so re-running "Approve all ticked" only adds what's missing.
 */
export async function approveResolved(picks: ApprovePick[], note: string): Promise<ApproveResult> {
  const items: ApproveItem[] = [];
  const say = (name: string, platform: "twitch" | "youtube", ok: boolean, message: string) => items.push({ name, platform, ok, message });

  const tw = picks.filter((p) => p.twitch && /^\d{1,20}$/.test(String(p.twitch.id)));
  // Fresh names/avatars from Helix when we can; the table's own data otherwise.
  const fresh = new Map<string, { login: string; name: string; avatar: string | null }>();
  if (tw.length && twitchConfigured()) {
    try {
      for (const u of await getUsers({ ids: tw.map((p) => p.twitch!.id) })) fresh.set(u.id, { login: u.login, name: u.display_name, avatar: u.profile_image_url || null });
    } catch { /* keep the table's data */ }
  }
  let twitchApproved = 0, youtubeApproved = 0;
  for (const p of tw) {
    const t = p.twitch!;
    const u = fresh.get(t.id) ?? { login: String(t.login).toLowerCase(), name: String(t.name), avatar: t.avatar ?? null };
    if (!/^[a-z0-9_]{1,25}$/.test(u.login)) { say(p.name, "twitch", false, `"${u.login}" doesn't look like a Twitch username.`); continue; }
    try {
      // Already approved (e.g. by an earlier "Approve all"): leave the row exactly as it is, so re-running is safe.
      const have = await prisma.streamer.findUnique({ where: { twitchId: t.id }, select: { approved: true, name: true } });
      if (have?.approved) { say(p.name, "twitch", true, `${have.name} is already approved on Twitch.`); continue; }
      // An older row for a different Twitch account still holds this name (someone renamed). Don't guess which is right.
      // A YouTube channel with the same name is fine (login is unique per platform since v1.7.1).
      const stale = await loginTakenBy("twitch", u.login, t.id);
      if (stale) { say(p.name, "twitch", false, `${u.name} not added: another Twitch account in Clip Factory already uses the name "${u.login}" (probably an old name change), so it wasn't added.`); continue; }
      const s = await prisma.streamer.upsert({
        where: { twitchId: t.id },
        update: { approved: true, approvedAt: new Date(), approvalNote: note, login: u.login, name: u.name, profileImage: u.avatar },
        create: { twitchId: t.id, login: u.login, name: u.name, profileImage: u.avatar, approved: true, approvedAt: new Date(), approvalNote: note },
      });
      await prisma.suggestion.updateMany({ where: { streamerId: s.id }, data: { status: "approved" } });
      twitchApproved++;
      say(p.name, "twitch", true, `${u.name} approved on Twitch.`);
    } catch (e) {
      say(p.name, "twitch", false, `Couldn't add ${u.name} (${short(e)}).`);
    }
  }

  for (const p of picks) {
    const y = p.youtube;
    if (!y) continue;
    const handle = String(y.handle ?? "").replace(/^@/, "").toLowerCase();
    if (!/^UC[\w-]{22}$/.test(String(y.channelId)) || !/^[a-z0-9._-]{3,30}$/.test(handle)) { say(p.name, "youtube", false, "That YouTube match looks wrong. Add it with “Approve a YouTube channel” instead."); continue; }
    const twitchId = `yt:${y.channelId}`;
    try {
      const have = await prisma.streamer.findUnique({ where: { twitchId }, select: { approved: true, platform: true } });
      if (have?.approved && have.platform === "youtube") { say(p.name, "youtube", true, `YouTube @${handle} is already approved.`); continue; }
      // Only another YouTube channel can clash; a Twitch streamer with the same name is fine (since v1.7.1).
      if (await loginTakenBy("youtube", handle, twitchId)) {
        say(p.name, "youtube", false, `YouTube @${handle} not added: another YouTube channel already uses that name in Clip Factory.`);
        continue;
      }
      const s = await prisma.streamer.upsert({
        where: { twitchId },
        update: { approved: true, approvedAt: new Date(), approvalNote: note, login: handle, name: y.title || handle, ...(y.avatar ? { profileImage: y.avatar } : {}), platform: "youtube" },
        create: { twitchId, platform: "youtube", login: handle, name: y.title || handle, profileImage: y.avatar ?? null, approved: true, approvedAt: new Date(), approvalNote: note },
      });
      await prisma.suggestion.updateMany({ where: { streamerId: s.id }, data: { status: "approved" } });
      youtubeApproved++;
      say(p.name, "youtube", true, `${y.title || handle} (youtube.com/@${handle}) approved.`);
    } catch (e) {
      say(p.name, "youtube", false, `Couldn't add YouTube @${handle} (${short(e)}).`);
    }
  }
  return { items, twitchApproved, youtubeApproved };
}
