// Captions for the post itself (TikTok / Shorts / Reels). Always credits the streamer.

/** Who made the original: a Twitch streamer or a YouTube channel (a Streamer row). */
export type Creator = { platform?: string | null; login: string; name: string };

/** The ONE place a creator's channel link is built. Twitch → twitch.tv/<login>, YouTube → youtube.com/@<handle>. */
export function creatorUrl(c: Creator) {
  return c.platform === "youtube" ? `https://youtube.com/@${c.login}` : `https://twitch.tv/${c.login}`;
}
/** The credit as burned into the video and required in every caption, e.g. "twitch.tv/name" / "youtube.com/@name". */
export function creatorCreditText(c: Creator) {
  return creatorUrl(c).replace(/^https:\/\//, "");
}
/** The caption credit line. */
export function creditLine(c: Creator) {
  return `🎥 Credit: ${c.name} — ${creatorUrl(c)}`;
}

export const GTA6_NAME = "Grand Theft Auto VI";

/** True for Twitch's GTA 6 category name (and the usual ways people write it). */
export function isGta6(game: string | null | undefined) {
  return !!game && /\b(grand theft auto (vi|6)|gta ?(vi|6))\b/i.test(game);
}

/** Short name for text: "GTA 6" for GTA 6, else the category name as Twitch writes it (null = unknown). */
export function gameLabel(game: string | null | undefined) {
  return isGta6(game) ? "GTA 6" : game?.trim() || null;
}

/** The game a moment is from. Rows made before any-game mode have no gameName and were all GTA 6. */
export function momentGame(m: { gameName: string | null; source: string }) {
  return m.gameName ?? (m.source === "youtube" ? null : GTA6_NAME);
}

/** "#Fortnite" from "Fortnite", "#CallOfDutyWarzone" from "Call of Duty: Warzone". */
export function gameTag(game: string) {
  return game
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("")
    .slice(0, 30);
}

/** Hashtags for the game: the original GTA set for GTA 6, "#<Game>" otherwise, none when unknown. */
export function gameHashtags(game: string | null | undefined) {
  if (isGta6(game)) return ["GTA6", "GTAVI", "GrandTheftAuto"];
  const t = game ? gameTag(game) : "";
  return t ? [t] : [];
}

export function defaultTitle(sourceTitle: string | null | undefined, streamerName: string, game: string | null = GTA6_NAME) {
  const t = (sourceTitle || "").trim();
  const label = gameLabel(game);
  return (t && t.length > 3 ? t : label ? `${streamerName} in ${label}` : `${streamerName} clip`).slice(0, 90);
}

export function defaultCaption(title: string, creator: Creator, game: string | null = GTA6_NAME) {
  const tag = creator.login.replace(/[^a-z0-9_]/gi, "");
  const platformTags = creator.platform === "youtube" ? ["youtube", "fyp"] : ["twitch", "gaming", "fyp"];
  return [
    title,
    "",
    creditLine(creator),
    "",
    [...gameHashtags(game), tag, ...platformTags].filter(Boolean).map((t) => "#" + t).join(" "),
  ].join("\n");
}

/** Clean model-written hashtags: letters/digits only, no dupes, the game's tag (#GTA6 for GTA 6) first, max 8. */
export function cleanHashtags(tags: string[], login: string, game: string | null = GTA6_NAME) {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of [...gameHashtags(game).slice(0, 1), ...tags, login]) {
    const t = raw.replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 30);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push("#" + t);
    if (out.length >= 8) break;
  }
  return out;
}

/** Caption from the Judge's output. The credit line is added here, in code, so it can never be dropped. */
export function judgedCaption(title: string, hashtags: string[], creator: Creator) {
  return [title, "", creditLine(creator), "", hashtags.join(" ")].join("\n");
}

// ---------- v1.9.1: ViceCityClips captions + Campaign mode ----------
// Every caption (Clip.caption) is exactly:
//   <short hook>
//
//   🎥 @<streamer login>
//
//   #GTA6 #GTAVI #ViceCity <1-2 of EXTRA_TAGS>
//   <campaign-required lines that aren't in it yet>
// Only campaign-required hashtags may push the hashtag line past 5 tags.
// (defaultCaption / judgedCaption above are the pre-1.9.1 formats, kept for old tests only.)

/** Always on the hashtag line, first, in this order. */
export const BRAND_TAGS = ["GTA6", "GTAVI", "ViceCity"] as const;
/** The only extra hashtags (the Judge picks 1-2). */
export const EXTRA_TAGS = ["GTA6Clips", "GTA6Funny", "Gaming", "StreamerMoments"] as const;
export type ExtraTag = (typeof EXTRA_TAGS)[number];
export const HOOK_MAX = 60;

/** What brandedCaption / checkCampaignCaption need from a Campaign row. */
export type CampaignRules = {
  name?: string | null; rules?: string | null; requiredText?: string | null; bannedWords?: string | null;
  maxCaptionChars?: number | null; active?: boolean | null;
};

/** "@login": the caption credit (Twitch login or YouTube @handle). */
export function creatorHandle(c: Pick<Creator, "login">) {
  return "@" + c.login.replace(/^@/, "");
}

/** Extras from anything (the Judge's list, a stored hashtag line): known ones only, deduped, max 2; none → `fallback`. */
export function cleanExtras(tags: unknown, fallback: readonly ExtraTag[] = ["StreamerMoments"]): ExtraTag[] {
  const out: ExtraTag[] = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const k = String(raw).replace(/^#/, "").trim().toLowerCase();
    const t = EXTRA_TAGS.find((x) => x.toLowerCase() === k);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 2) break;
  }
  return out.length ? out : [...fallback].slice(0, 2);
}

/** Without the Judge: funny → GTA6Funny; GTA 6 → GTA6Clips; neither → StreamerMoments (2 when both apply). */
export function defaultExtras(category: string | null | undefined, game: string | null | undefined): ExtraTag[] {
  const out: ExtraTag[] = [];
  if (category === "funny") out.push("GTA6Funny");
  if (isGta6(game)) out.push("GTA6Clips");
  return out.length ? out : ["StreamerMoments"];
}

const chars = (s: string) => [...s];
/** A hook for the caption: one line, no hashtags / emoji, at most `max` characters (cut at a word). */
export function shortHook(text: string | null | undefined, max = HOOK_MAX) {
  let t = (text || "")
    .replace(/#[\p{L}\p{N}_]+/gu, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (max <= 0) return "";
  if (chars(t).length > max) {
    const cut = chars(t).slice(0, max + 1).join("");
    const sp = cut.lastIndexOf(" ");
    t = (sp > max * 0.5 ? cut.slice(0, sp) : chars(t).slice(0, max).join("")).replace(/[\s,;:–—-]+$/u, "");
  }
  return t;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** "a, b\nc" → ["a", "b", "c"] (byComma false: one item per line). */
export function splitList(s: string | null | undefined, byComma = true) {
  return (s || "").split(byComma ? /[,\n\r]+/ : /[\r\n]+/).map((x) => x.trim()).filter(Boolean);
}
/** Whole-word, case-insensitive match (works for "#ad", "@kai" and plain words). */
function wordRe(w: string, flags = "iu") {
  return new RegExp(`(?<![\\p{L}\\p{N}_#@])${escRe(w)}(?![\\p{L}\\p{N}_])`, flags);
}
const isTagLine = (line: string) => /^(#[\p{L}\p{N}_]+\s*)+$/u.test(line.trim());
const hasText = (text: string, line: string) =>
  line.startsWith("@") || line.startsWith("#") ? wordRe(line).test(text) : text.toLowerCase().includes(line.toLowerCase());

/** Banned words removed from a hook (whole words, any case). */
export function removeBanned(text: string, banned: string[]) {
  let t = text;
  for (const w of banned) t = t.replace(wordRe(w, "giu"), " ");
  return t.replace(/\s+([,.!?])/g, "$1").replace(/\s+/g, " ").replace(/^[\s,.;:!?–—-]+/u, "").trim();
}

/**
 * THE caption builder (moment creation, the Judge, "Rebuild caption"). The credit and brand hashtags are added here, in
 * code, so they can never be dropped. A campaign adds its required lines/hashtags, strips its banned words from the hook
 * (falling back to `fallbackHook`, then "<name> in <game>") and trims the hook so the caption fits its max length.
 */
export function brandedCaption(o: {
  hook: string | null | undefined; streamer: Creator; extras?: unknown; campaign?: CampaignRules | null;
  fallbackHook?: string | null; category?: string | null; game?: string | null;
}) {
  const camp = o.campaign && o.campaign.active !== false ? o.campaign : null;
  const banned = camp ? splitList(camp.bannedWords) : [];
  const extras = cleanExtras(o.extras, defaultExtras(o.category, o.game ?? null));
  let hook = removeBanned(shortHook(o.hook), banned);
  if (!hook) hook = removeBanned(shortHook(o.fallbackHook), banned);
  if (!hook) hook = removeBanned(shortHook(defaultTitle(null, o.streamer.name, o.game ?? null)), banned);
  if (!hook) hook = "Wait for it";

  const tags: string[] = [...BRAND_TAGS, ...extras];
  const has = (t: string) => tags.some((x) => x.toLowerCase() === t.toLowerCase());
  const credit = `🎥 ${creatorHandle(o.streamer)}`;
  const lines: string[] = [];
  for (const line of camp ? splitList(camp.requiredText, false) : []) {
    if (isTagLine(line)) {
      // Required hashtags go on the hashtag line (after #GTA6 #GTAVI #ViceCity + extras).
      for (const t of line.split(/\s+/)) if (t && !has(t.slice(1))) tags.push(t.slice(1));
      continue;
    }
    // A text line ("@kaicenat", "Use code KAI"): only when it isn't in the caption already.
    if (!hasText([hook, credit, ...lines].join("\n"), line)) lines.push(line);
  }
  const build = (h: string) => [h, "", credit, "", tags.map((t) => "#" + t).join(" "), ...lines].join("\n");
  const max = camp?.maxCaptionChars && camp.maxCaptionChars > 0 ? camp.maxCaptionChars : null;
  if (max && chars(build(hook)).length > max) {
    const room = max - chars(build("")).length;
    hook = shortHook(hook, room) || hook.split(" ")[0]; // never an empty hook line
  }
  return build(hook);
}

/** The hashtags in a caption, space-separated (stored on Clip.hashtags; YouTube tags come from it). */
export function captionHashtags(caption: string) {
  return (caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).join(" ");
}

/** Campaign checks for the Queue card (✅ / ⚠️). Never blocks anything: Krew decides. */
export function checkCampaignCaption(caption: string, campaign: CampaignRules | null | undefined): { rule: string; ok: boolean }[] {
  if (!campaign) return [];
  const out: { rule: string; ok: boolean }[] = [];
  for (const line of splitList(campaign.requiredText, false)) {
    if (isTagLine(line)) for (const t of line.split(/\s+/).filter(Boolean)) out.push({ rule: `Has ${t}`, ok: wordRe(t).test(caption) });
    else out.push({ rule: `Has “${line}”`, ok: hasText(caption, line) });
  }
  for (const w of splitList(campaign.bannedWords)) out.push({ rule: `No “${w}”`, ok: !wordRe(w).test(caption) });
  if (campaign.maxCaptionChars && campaign.maxCaptionChars > 0) {
    const n = chars(caption).length;
    out.push({ rule: `At most ${campaign.maxCaptionChars} characters (now ${n})`, ok: n <= campaign.maxCaptionChars });
  }
  return out;
}

/** The caption credits the creator: "@login" (v1.9.1 format) or the channel link (captions made before it). */
export function captionCredits(caption: string, c: Creator) {
  return wordRe(creatorHandle(c)).test(caption) || caption.includes(creatorCreditText(c));
}
