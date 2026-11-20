// v2.0.8 YouTube scout (Krew: "a second scout who searches for YouTube videos ... of the people we make, and then they can clip
// from those"). Part 1, this file: find each approved, not-paused Twitch creator's YouTube channel(s).
//
// Per creator (at most SCOUT_DAILY creators a day, SCOUT_PER_RUN per 30-min run, results cached on the Twitch row):
//   1. links in their Twitch bio (Helix /users description; Twitch panels are not in Helix, so they can't be read),
//   2. @<login> / @<name> directly (YouTube Data API `channels?forHandle`, 1 unit; without a key yt-dlp on youtube.com/@x),
//   3. one search by name (Data API `search.list`, which has its own 100/day bucket: at most SEARCH_DAILY calls a day; without a key
//      or once that is used up, yt-dlp `ytsearch5:`).
// Every channel found is checked with matchConfidence (src/lib/yt-match.ts). Confident -> an APPROVED YouTube Streamer row with
// approvalNote "Same creator as approved Twitch @login (linked automatically)" (deliberate extension of the approval rule: it is the
// creator Krew already approved, see CLAUDE.md "Rules"). Unsure -> a Suggestion (YouTube tab) for one-click approve, only when nothing
// confident was found. A channel Krew removed before is never approved again by the scout.
import { prisma, getSettings } from "../lib/db";
import { redis, setStatus } from "../lib/queues";
import { loginTakenBy } from "../lib/streamers";
import { getUsers, twitchConfigured } from "../lib/twitch";
import { resolveChannel, ytError, ytSearchChannels } from "../lib/ytdlp";
import { matchConfidence, bioYouTubeLinks, type Match, type YtCandidate } from "../lib/yt-match";
import { YouTubeApiError, youtubeKeyConfigured, youtubeSuggestionScore, ytApi } from "./suggest-youtube";

export const SCOUT_DAILY = 15;        // creators looked up per day by the schedule
export const SCOUT_DAILY_MANUAL = 30; // "Find YouTube channels now" may go this far in a day
export const SCOUT_PER_RUN = 3;       // per scheduled 30-min run (so a run stays quick)
export const SEARCH_DAILY = 20;       // Data API search.list calls per day (its bucket is 100/day)
const RECHECK_MS = 14 * 86400_000;    // nothing (sure) found: look again after 2 weeks
const ERROR_RECHECK_MS = 86400_000;   // the look-up failed: try again the next day
export const autoNote = (login: string) => `Same creator as approved Twitch @${login} (linked automatically)`;

type Cand = YtCandidate & { avatar: string | null };
type TwitchRow = { id: string; twitchId: string; login: string; name: string };

const day = () => new Date().toISOString().slice(0, 10);
async function used(kind: "creators" | "search"): Promise<number> {
  return Number((await redis().get(`cf:ytscout:${kind}:${day()}`)) ?? 0);
}
async function bump(kind: "creators" | "search") {
  const k = `cf:ytscout:${kind}:${day()}`;
  await redis().incr(k);
  await redis().expire(k, 3 * 86400);
}

type ApiChannel = {
  id: string;
  snippet?: { title?: string; description?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
};
function fromApi(c: ApiChannel): Cand {
  const st = c.statistics ?? {};
  const t = c.snippet?.thumbnails ?? {};
  return {
    channelId: c.id, handle: (c.snippet?.customUrl ?? "").trim().replace(/^@/, "").toLowerCase(), title: c.snippet?.title ?? "",
    subscribers: st.hiddenSubscriberCount || st.subscriberCount == null ? null : Number(st.subscriberCount) || 0,
    description: c.snippet?.description ?? null, avatar: t.medium?.url || t.default?.url || t.high?.url || null,
  };
}

/** Which Twitch creators are due a look-up: approved, not paused, no YouTube linked yet, never looked or looked long ago. */
export async function dueCreators(now = Date.now()) {
  const rows = await prisma.streamer.findMany({
    where: { platform: "twitch", approved: true, paused: false, youtubeId: null },
    select: { id: true, twitchId: true, login: true, name: true, ytLookupAt: true, ytLookupNote: true, followers: true, peakViewers: true },
  });
  return rows
    .filter((r) => !r.ytLookupAt || now - r.ytLookupAt.getTime() > (r.ytLookupNote?.startsWith("error") ? ERROR_RECHECK_MS : RECHECK_MS))
    .sort((a, b) => Number(!!a.ytLookupAt) - Number(!!b.ytLookupAt) || (b.followers ?? 0) - (a.followers ?? 0) || b.peakViewers - a.peakViewers);
}

/** Look for every due creator's YouTube channel (within today's budget). Returns the status line (also saved as "yt_scout"). */
export async function runYouTubeScout(opts: { manual?: boolean } = {}): Promise<string> {
  const settings = await getSettings();
  if (settings.scoutPaused) return "paused";
  if (!settings.ytScanEnabled) return "off (Settings → YouTube scanner)";
  const due = await dueCreators();
  const left = (opts.manual ? SCOUT_DAILY_MANUAL : SCOUT_DAILY) - (await used("creators"));
  if (!due.length) return save("every approved Twitch creator has been checked (looked at again every 2 weeks)");
  if (left <= 0) return save(`daily limit reached (${opts.manual ? SCOUT_DAILY_MANUAL : SCOUT_DAILY} creators a day), ${due.length} left for tomorrow`);
  const batch = due.slice(0, Math.min(left, opts.manual ? SCOUT_DAILY : SCOUT_PER_RUN));

  // Twitch bios in one Helix call.
  const bios = new Map<string, string>();
  if (twitchConfigured()) {
    try {
      for (const u of await getUsers({ ids: batch.map((b) => b.twitchId) })) bios.set(u.id, u.description ?? "");
    } catch (e) { console.warn("[yt-scout] Twitch bios:", (e as Error).message); }
  }

  const ctx = { api: youtubeKeyConfigured(), apiStopped: null as string | null };
  let linked = 0, suggested = 0, none = 0, failed = 0;
  const notes: string[] = [];
  for (const c of batch) {
    await bump("creators");
    let note: string;
    try {
      const r = await lookUp(c, bios.get(c.twitchId) ?? null, ctx);
      linked += r.linked; suggested += r.suggested;
      if (!r.linked && !r.suggested) none++;
      note = r.note;
      if (r.extra) notes.push(`${c.name}: ${r.extra}`);
    } catch (e) {
      failed++;
      note = `error: ${ytError(e)}`.slice(0, 300);
      notes.push(`${c.name}: ${note}`);
    }
    await prisma.streamer.update({ where: { id: c.id }, data: { ytLookupAt: new Date(), ytLookupNote: note.slice(0, 300) } });
  }
  const parts = [`checked ${batch.length} creator${batch.length === 1 ? "" : "s"}: ${linked} YouTube channel${linked === 1 ? "" : "s"} linked, ${suggested} in Suggestions, ${none} with nothing sure`];
  if (failed) parts.push(`${failed} failed`);
  if (due.length > batch.length) parts.push(`${due.length - batch.length} left for the next runs`);
  if (ctx.apiStopped) parts.push(`YouTube API: ${ctx.apiStopped} (used yt-dlp instead)`);
  if (notes.length) parts.push(notes.slice(0, 2).join("; "));
  return save(parts.join(" · "), failed === 0 || failed < batch.length);

  async function save(msg: string, ok = true) {
    await setStatus("yt_scout", ok, msg).catch(() => {});
    return msg;
  }
}

type Ctx = { api: boolean; apiStopped: string | null };

async function lookUp(c: TwitchRow, bio: string | null, ctx: Ctx): Promise<{ linked: number; suggested: number; note: string; extra?: string }> {
  const found = new Map<string, Cand>();
  const errors: string[] = [];
  const add = (x: Cand | null) => { if (x && /^UC[\w-]{22}$/.test(x.channelId) && !found.has(x.channelId)) found.set(x.channelId, x); };
  const useApi = () => ctx.api && !ctx.apiStopped;
  const api = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e) {
      if (e instanceof YouTubeApiError && e.fatal) { ctx.apiStopped = e.message; return null; }
      errors.push((e as Error).message); return null;
    }
  };
  const viaYtdlp = async (input: string) => {
    try {
      const ch = await resolveChannel(input);
      add({ channelId: ch.channelId, handle: ch.handle.toLowerCase(), title: ch.title, subscribers: ch.subscribers ?? null, description: ch.description ?? null, avatar: ch.avatar });
    } catch (e) {
      const m = (e as Error).message;
      if (!/does not exist|not found|404|doesn't look like|unavailable/i.test(m)) errors.push(m.slice(0, 160));
    }
  };
  const byHandle = async (h: string) => {
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(h)) return;
    if (useApi()) {
      const r = await api(() => ytApi<{ items?: ApiChannel[] }>("/channels", { part: "snippet,statistics", forHandle: `@${h}` }));
      if (r) { (r.items ?? []).forEach((i) => add(fromApi(i))); return; }
    }
    await viaYtdlp(`@${h}`);
  };
  const byIds = async (ids: string[]) => {
    const want = ids.filter((id) => !found.has(id));
    if (!want.length) return;
    if (useApi()) {
      const r = await api(() => ytApi<{ items?: ApiChannel[] }>("/channels", { part: "snippet,statistics", id: want.join(","), maxResults: "50" }));
      if (r) { (r.items ?? []).forEach((i) => add(fromApi(i))); return; }
    }
    for (const id of want.slice(0, 3)) await viaYtdlp(`https://www.youtube.com/channel/${id}`);
  };

  // 1. Twitch bio links.
  const links = bioYouTubeLinks(bio);
  for (const h of links.handles) await byHandle(h);
  await byIds(links.ids);
  for (const u of links.other.slice(0, 2)) await viaYtdlp(u);
  // 2. Same @handle as the login / the name.
  const handles = [...new Set([c.login, c.name.replace(/[^A-Za-z0-9._-]/g, "")].map((h) => h.toLowerCase()))];
  for (const h of handles) if (![...found.values()].some((f) => f.handle === h)) await byHandle(h);
  // 3. One search by name (main + clips channels).
  let searched = false;
  if (useApi() && (await used("search")) < SEARCH_DAILY) {
    await bump("search");
    const s = await api(() => ytApi<{ items?: { id?: { channelId?: string }; snippet?: { channelId?: string } }[] }>("/search", { part: "snippet", type: "channel", q: c.name, maxResults: "5" }));
    if (s) {
      searched = true;
      await byIds([...new Set((s.items ?? []).map((i) => i.id?.channelId || i.snippet?.channelId).filter((x): x is string => Boolean(x)))]);
    }
  }
  if (!searched) {
    try {
      const ids = await ytSearchChannels(c.name, 5);
      for (const id of ids.filter((x) => !found.has(x)).slice(0, 3)) await viaYtdlp(`https://www.youtube.com/channel/${id}`);
    } catch (e) { errors.push(`search: ${ytError(e)}`.slice(0, 160)); }
  }

  const tw = { login: c.login, name: c.name, bio };
  const judged = [...found.values()].map((y) => ({ y, m: matchConfidence(tw, y) })).filter((x): x is { y: Cand; m: NonNullable<Match> } => x.m != null);
  const sure = judged.filter((x) => x.m.confident);
  const linkedRows: { id: string; y: Cand; m: NonNullable<Match> }[] = [];
  const skipped: string[] = [];
  for (const x of sure) {
    const r = await linkChannel(c, x.y);
    if (r.id) linkedRows.push({ id: r.id, y: x.y, m: x.m });
    else if (r.why) skipped.push(`@${x.y.handle}: ${r.why}`);
  }
  if (linkedRows.length) {
    const main = linkedRows.filter((r) => r.m.kind === "main").sort((a, b) => (b.y.subscribers ?? -1) - (a.y.subscribers ?? -1))[0] ?? linkedRows[0];
    await prisma.streamer.update({ where: { id: c.id }, data: { youtubeId: main.id } });
    return { linked: linkedRows.length, suggested: 0, note: `found ${linkedRows.map((r) => `@${r.y.handle} (${r.m.reason})`).join(", ")}`, extra: skipped[0] };
  }
  // Nothing sure: the best unsure ones (most subscribers) go to Suggestions for Krew's click.
  const unsure = judged.filter((x) => !x.m.confident).sort((a, b) => (b.y.subscribers ?? -1) - (a.y.subscribers ?? -1)).slice(0, 2);
  let suggested = 0;
  for (const x of unsure) if (await suggest(c, x.y, x.m)) suggested++;
  if (suggested) return { linked: 0, suggested, note: `maybe ${unsure.map((x) => `@${x.y.handle}`).join(", ")} (in Suggestions)` };
  const why = skipped[0] ?? errors[0];
  return { linked: 0, suggested: 0, note: errors.length && !found.size ? `error: ${errors[0]}` : `not found${why ? ` (${why})` : ""}`, extra: why };
}

const validHandle = (h: string) => /^[a-z0-9._-]{3,30}$/.test(h);

/** Make (or reuse) the approved YouTube row for a confident match. Never re-approves a channel Krew removed. */
export async function linkChannel(tw: TwitchRow, y: Cand): Promise<{ id: string | null; why?: string }> {
  const handle = y.handle.replace(/^@/, "").toLowerCase();
  if (!validHandle(handle)) return { id: null, why: "no @handle (needed for the credit link)" };
  const twitchId = `yt:${y.channelId}`;
  const have = await prisma.streamer.findUnique({ where: { twitchId } });
  if (have?.approved) {
    if (have.linkedFromId && have.linkedFromId !== tw.id) return { id: null, why: "already linked to another creator" };
    if (!have.linkedFromId) await prisma.streamer.update({ where: { id: have.id }, data: { linkedFromId: tw.id } });
    return { id: have.id };
  }
  // Approved once and then removed by Krew: his call stands.
  if (have?.approvedAt) return { id: null, why: "you removed this channel before, so it wasn't added again" };
  if (await loginTakenBy("youtube", handle, twitchId)) return { id: null, why: "another YouTube channel in Clip Factory already uses that name" };
  const data = { approved: true, approvedAt: new Date(), approvalNote: autoNote(tw.login), linkedFromId: tw.id, login: handle, name: y.title || handle, ...(y.avatar ? { profileImage: y.avatar } : {}), platform: "youtube" };
  const s = await prisma.streamer.upsert({ where: { twitchId }, update: data, create: { twitchId, ...data } });
  await prisma.suggestion.updateMany({ where: { streamerId: s.id }, data: { status: "approved" } });
  return { id: s.id };
}

/** An unsure match as a YouTube suggestion card (never approves). Returns false when it can't or shouldn't be shown. */
async function suggest(tw: TwitchRow, y: Cand, m: NonNullable<Match>): Promise<boolean> {
  const handle = y.handle.replace(/^@/, "").toLowerCase();
  if (!validHandle(handle)) return false;
  const twitchId = `yt:${y.channelId}`;
  const have = await prisma.streamer.findUnique({ where: { twitchId }, include: { suggestion: true } });
  if (have?.approved || have?.approvedAt) return false; // already approved, or Krew removed it
  const sg = have?.suggestion;
  if (sg?.status === "dismissed" && sg.dismissedUntil && sg.dismissedUntil > new Date()) return false; // "Not now"
  if (await loginTakenBy("youtube", handle, twitchId)) return false;
  const info = { login: handle, name: y.title || handle, ...(y.avatar ? { profileImage: y.avatar } : {}) };
  const s = await prisma.streamer.upsert({ where: { twitchId }, update: info, create: { twitchId, platform: "youtube", approved: false, ...info } });
  if (s.platform !== "youtube") return false;
  const subs = y.subscribers;
  const data = {
    platform: "youtube", linkedFromId: tw.id, status: "pending", dismissedUntil: null, viewers: 0, gameName: null,
    score: youtubeSuggestionScore({ subscribers: subs ?? 0, trendingViews: 0, trendingCount: 0, evidence: false }) + 2,
    reasons: JSON.stringify([`maybe the YouTube of Twitch @${tw.login}`, m.reason, subs == null ? "subscribers hidden" : `${subs.toLocaleString("en-US")} subscribers`]),
    subscribers: subs == null ? null : Math.min(subs, 2_147_483_647), evidence: null, evidenceSource: null, videoId: null, videoTitle: null, videoViews: null,
  };
  await prisma.suggestion.upsert({ where: { streamerId: s.id }, update: data, create: { streamerId: s.id, ...data } });
  return true;
}
