// Moment type: "funny" (comedy, banter, reactions, funny fails; doesn't have to be gaming) or "gaming" (plays,
// clutches, chases, game moments). Every source makes a first guess here; the Judge's label replaces it on the Clip.
// Settings → "What to clip" can switch either kind off.

export type Category = "funny" | "gaming";
export const CATEGORIES: Category[] = ["funny", "gaming"];

export const isCategory = (x: unknown): x is Category => x === "funny" || x === "gaming";
export const categoryLabel = (c: string | null | undefined) => (c === "funny" ? "Funny" : c === "gaming" ? "Gaming" : null);

/** Twitch categories that aren't a game: clips from these are funny moments (Sports counts as gaming). */
export const NON_GAME_CATEGORIES = new Set(
  ["Just Chatting", "IRL", "Talk Shows & Podcasts", "Pools, Hot Tubs, and Beaches", "Pools Hot Tubs & Beaches", "Music", "Art", "ASMR", "Special Events"]
    .map((n) => norm(n)),
);

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\band\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Laugh words in a clip / video title. */
export const TITLE_LAUGH = /(\b(lmf?ao+|lo+l+|dead|crying|funny|funniest|hilarious|i ?can[’']?t)\b|😂|🤣|💀)/i;
/** Gaming words in a YouTube title. */
export const TITLE_GAMING = new RegExp(
  "\\b(" + [
    "gameplay", "gta ?(v|vi|5|6|online|rp)?", "grand theft auto", "fortnite", "minecraft", "speed ?runs?", "roblox", "valorant", "warzone",
    "call of duty", "cod", "apex( legends)?", "league of legends", "elden ring", "rocket league", "overwatch", "counter[- ]?strike", "cs ?2",
    "fifa", "ea fc", "nba 2k", "2k2\\d", "pubg", "rust", "dark souls", "zelda", "pok[eé]mon", "mario", "let'?s play", "playthrough", "walkthrough",
    "no ?hit", "boss fight", "ranked", "gaming",
  ].join("|") + ")\\b",
  "i",
);

/** True for Twitch categories that aren't a game (Just Chatting, IRL, podcasts...). */
export const isNonGame = (gameName: string | null | undefined) => Boolean(gameName && NON_GAME_CATEGORIES.has(norm(gameName)));

/** Twitch viewer clip: funny when its Twitch category isn't a game or the title laughs, else gaming. */
export function twitchClipCategory(gameName: string | null | undefined, title: string | null | undefined): Category {
  if (gameName && NON_GAME_CATEGORIES.has(norm(gameName))) return "funny";
  if (title && TITLE_LAUGH.test(title)) return "funny";
  return "gaming";
}

/**
 * YouTube peak: YouTube's own "Gaming" category → gaming, "Comedy" → funny; otherwise a gaming title → gaming;
 * everything else (Entertainment, People & Blogs, no category) → funny.
 */
export function youtubeCategory(title: string | null | undefined, categories: string[] = []): Category {
  const cats = categories.map((c) => c.toLowerCase().trim());
  if (cats.includes("gaming")) return "gaming";
  if (cats.includes("comedy")) return "funny";
  if (title && TITLE_GAMING.test(title)) return "gaming";
  return "funny";
}

type Switches = { clipFunny: boolean; clipGaming: boolean };
/** True when Settings → "What to clip" has this kind switched off. Unknown/null categories are never off. */
export function categoryOff(s: Switches, c: string | null | undefined) {
  return (c === "funny" && !s.clipFunny) || (c === "gaming" && !s.clipGaming);
}
export const offReason = (c: Category) => `${c === "funny" ? "Funny" : "Gaming"} clips are off in Settings`;

/** "skipped 2 funny, 1 gaming (off in Settings)" or null. */
export function skippedNote(skipped: Record<Category, number>) {
  const parts = CATEGORIES.filter((c) => skipped[c] > 0).map((c) => `${skipped[c]} ${c}`);
  return parts.length ? `skipped ${parts.join(", ")} (off in Settings)` : null;
}
