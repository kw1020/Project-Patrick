// v2.0.8 YouTube scout: is this YouTube channel the same person as an approved Twitch creator? Pure rules (tests: test/v208.test.ts).
//
// CONFIDENT (linked automatically as an approved YouTube row, the same creator Krew already approved):
//   1. the Twitch bio links this YouTube channel (youtube.com/@handle or /channel/UC...), or
//   2. the YouTube channel's description links back to twitch.tv/<login>, or
//   3. its @handle or title equals the Twitch login / display name (ignoring case, spaces, _ . -) AND it has >= BIG_SUBS
//      subscribers (a big channel with exactly that name).
// UNSURE (a one-click card in Suggestions -> YouTube): the name is in the title/handle (or the other way round) but none of the
//   above holds, e.g. "<name> Clips" without a link back, or the exact name with few/hidden subscribers.
// Clips / second channels ("<name> Clips", "<name> 2", "More <name>") count too, but only through rules 1-2 (never by name alone).

/** Lowercase letters + digits only (same as creator-lookup's squash; kept here so this file stays import-free). */
const squash = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export const BIG_SUBS = 100_000;

export type TwitchSide = { login: string; name: string; bio?: string | null };
export type YtCandidate = { channelId: string; handle: string; title: string; subscribers: number | null; description?: string | null };
export type MatchKind = "main" | "second";
export type Match = { confident: boolean; reason: string; kind: MatchKind } | null;

/** YouTube channel links in a Twitch bio: @handles and channel ids (lowercased handles). */
export function bioYouTubeLinks(bio: string | null | undefined): { handles: string[]; ids: string[]; other: string[] } {
  const text = String(bio ?? "");
  const handles = [...text.matchAll(/(?:youtube\.com\/|youtu\.be\/)@([A-Za-z0-9._-]{3,30})/gi)].map((m) => m[1].toLowerCase().replace(/[.]+$/, ""));
  const ids = [...text.matchAll(/youtube\.com\/channel\/(UC[\w-]{22})/gi)].map((m) => m[1]);
  const other = [...text.matchAll(/youtube\.com\/(?:c|user)\/([A-Za-z0-9._-]{2,60})/gi)].map((m) => `https://www.youtube.com/${m[0].split("youtube.com/")[1]}`);
  return { handles: [...new Set(handles)], ids: [...new Set(ids)], other: [...new Set(other)] };
}

/** The channel description links twitch.tv/<login> (whole login, any case; www./m./https optional). */
export function linksBackToTwitch(description: string | null | undefined, login: string): boolean {
  if (!description || !login) return false;
  const esc = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`twitch\\.tv/(?:#!/)?${esc}(?![a-z0-9_])`, "i").test(description);
}

const SECOND = /(clips?|highlights?|vods?|archive|moments|extra|plus|more|reacts?|live|shorts|gaming|2|two|second|best of|uncut)/i;

/** How the YouTube channel relates to the Twitch creator, or null when it's somebody else. */
export function matchConfidence(tw: TwitchSide, yt: YtCandidate): Match {
  const login = squash(tw.login), name = squash(tw.name);
  const h = squash(yt.handle), t = squash(yt.title);
  const exact = !!(h || t) && [h, t].some((x) => x && (x === login || x === name));
  const contains = [h, t].some((x) => x.length >= 3 && [login, name].some((q) => q.length >= 3 && (x.includes(q) || q.includes(x))));
  const kind: MatchKind = exact ? "main" : contains && SECOND.test(`${yt.title} ${yt.handle}`) ? "second" : "main";
  const links = bioYouTubeLinks(tw.bio);
  if (links.ids.includes(yt.channelId) || links.handles.includes(yt.handle.toLowerCase())) return { confident: true, reason: `their Twitch bio links youtube.com/@${yt.handle}`, kind };
  if (linksBackToTwitch(yt.description, tw.login)) return { confident: true, reason: `the channel links back to twitch.tv/${tw.login}`, kind };
  if (exact && yt.subscribers != null && yt.subscribers >= BIG_SUBS) return { confident: true, reason: `same name and ${fmt(yt.subscribers)} subscribers`, kind: "main" };
  if (exact) return { confident: false, reason: yt.subscribers == null ? "same name, subscribers hidden" : `same name, only ${fmt(yt.subscribers)} subscribers`, kind: "main" };
  if (contains) return { confident: false, reason: `name matches (${yt.title}), no link back to twitch.tv/${tw.login}`, kind };
  return null;
}

const fmt = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1e3 ? `${Math.round(n / 100) / 10}K` : String(n));
