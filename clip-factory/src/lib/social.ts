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
