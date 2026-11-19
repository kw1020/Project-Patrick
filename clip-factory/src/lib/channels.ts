// v1.9.5 Channels + Upload: pure helpers, no Node imports (the Upload card and the Settings page use them).
// A Channel is one of Krew's brands (e.g. "ViceCityClips") = a set of accounts that all get the same clips.

export const CHANNEL_KINDS = [
  { key: "gaming", label: "Gaming" },
  { key: "funny", label: "Funny" },
  { key: "edits", label: "Edits" },
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number]["key"];
const KIND_KEYS = new Set<string>(CHANNEL_KINDS.map((k) => k.key));

/** Platforms a clip can go to. "twitch" accounts only read follower counts and never post. */
export const POST_PLATFORMS = ["youtube", "tiktok", "instagram"] as const;
export type PostPlatform = (typeof POST_PLATFORMS)[number];
export const PLATFORM_LABEL: Record<string, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", twitch: "Twitch" };

/** "gaming, Funny,x" → ["gaming", "funny"] (known kinds only, deduped, in the fixed order). */
export function parseKinds(s: string | null | undefined): ChannelKind[] {
  const got = new Set(String(s ?? "").toLowerCase().split(/[\s,]+/).filter((k) => KIND_KEYS.has(k)));
  return CHANNEL_KINDS.map((k) => k.key).filter((k) => got.has(k));
}
export const kindsString = (kinds: Iterable<string>) => parseKinds([...kinds].join(","));

export type ChannelLite = { id: string; name: string; kinds: string; focus?: string | null; createdAt?: Date | string };

/** Channel focus: "gta" = GTA 6 clips of any type (ViceCityClips), "any" = any game, by kinds. Free text is kept as typed. */
export const CHANNEL_FOCUS = [
  { key: "gta", label: "GTA 6", hint: "GTA 6 clips of any type (funny, gaming, edits)" },
  { key: "any", label: "Any game", hint: "Clips from any game whose type is ticked" },
] as const;
export function parseFocus(v: unknown): string {
  const t = String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9 _-]/g, "").slice(0, 20);
  return t === "gta6" || t === "gta 6" ? "gta" : t || "any";
}
export const isGtaFocus = (c: Pick<ChannelLite, "focus">) => parseFocus(c.focus) === "gta";

/**
 * Which channel a clip goes to: the one Krew picked (Clip.channelId, if it still exists); else, for a GTA 6 clip, the
 * first "gta" channel (oldest first) whose kinds include its type; else the first non-gta channel whose kinds include its
 * type (funny | gaming; edits come from the v2.0 Edit flow); a GTA 6 clip falls back to any channel taking its type.
 * null = no channel fits (Upload asks Krew to pick one) — a Fortnite clip never lands on a GTA-only channel by itself.
 */
export function channelForClip<C extends ChannelLite>(channels: C[], clip: { channelId?: string | null; category?: string | null; gta?: boolean }): C | null {
  if (!channels.length) return null;
  const sorted = [...channels].sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
  if (clip.channelId) {
    const picked = sorted.find((c) => c.id === clip.channelId);
    if (picked) return picked;
  }
  const cat = clip.category === "funny" || clip.category === "gaming" || clip.category === "edits" ? clip.category : "gaming";
  const takes = (c: C) => parseKinds(c.kinds).includes(cat);
  if (clip.gta) return sorted.find((c) => isGtaFocus(c) && takes(c)) ?? sorted.find((c) => !isGtaFocus(c) && takes(c)) ?? null;
  return sorted.find((c) => !isGtaFocus(c) && takes(c)) ?? null;
}

/** One account per platform per channel: the account in that slot (oldest wins if there are ever two). */
export function slotAccount<A extends AccountLite & { createdAt?: Date | string }>(accounts: A[], channelId: string, platform: string): A | null {
  return accounts.filter((a) => a.homeChannelId === channelId && a.platform === platform)
    .sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime())[0] ?? null;
}

export type AccountLite = { id: string; platform: string; mode?: string | null; homeChannelId?: string | null; error?: string | null };

/** What the Upload row for this account does: Post (YouTube API upload), Send to TikTok (inbox draft) or by hand. */
export function accountAction(a: Pick<AccountLite, "platform" | "mode">): "post" | "tiktok" | "manual" {
  if (a.mode === "manual" || a.platform === "instagram") return "manual";
  if (a.platform === "tiktok") return "tiktok";
  return "post";
}

/** Accounts that can be posted to (any mode), i.e. not the Twitch follower-count login. */
export const isPostingAccount = (a: Pick<AccountLite, "platform">) => (POST_PLATFORMS as readonly string[]).includes(a.platform);
/** Accounts the Poster may upload to through the API (Queue buttons, auto-post on approve). */
export const isApiPostingAccount = (a: Pick<AccountLite, "platform" | "mode">) => (a.platform === "youtube" || a.platform === "tiktok") && (a.mode ?? "api") === "api";

export type PostLite = { accountId: string | null; status: string; url?: string | null };
/** The post that counts as "done" for this account (a TikTok draft counts: it's in Krew's inbox), or null. */
export function donePost<P extends PostLite>(posts: P[], accountId: string): P | null {
  return posts.find((p) => p.accountId === accountId && p.status !== "failed") ?? null;
}
/** Every account of the channel has it. A channel with no accounts is never "done" (the clip waits on Upload). */
export function isFullyPosted(posts: PostLite[], accounts: { id: string }[]) {
  return accounts.length > 0 && accounts.every((a) => donePost(posts, a.id));
}

/** The media route's download link (Content-Disposition: attachment). */
export const downloadUrl = (clipId: string) => `/api/media/${clipId}?download=1`;

/** "@ViceCity.Clips" / "vicecityclips" → "@ViceCity.Clips" / "@vicecityclips"; null when it isn't a handle. */
export function parseHandle(v: unknown): string | null {
  const t = String(v ?? "").trim().replace(/^https?:\/\/(www\.)?(tiktok\.com|instagram\.com|youtube\.com)\//i, "").replace(/[/?#].*$/, "").replace(/^@+/, "");
  return /^[A-Za-z0-9_.-]{2,30}$/.test(t) ? `@${t}` : null;
}

/** Channel name: plain text, max 40; empty → null. */
export function parseChannelLabel(v: unknown): string | null {
  const t = String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 40);
  return t || null;
}

/**
 * v1.9.7: which "post when I approve" accounts an approved clip goes to. channelId undefined = no channels set up (old
 * behaviour: every auto account); null = the clip has no channel (nothing auto-posts, Krew picks on Upload); else only
 * the accounts in that channel's slots.
 */
export function autoPostTargets<A extends { homeChannelId?: string | null }>(auto: A[], channelId: string | null | undefined): A[] {
  if (channelId === undefined) return auto;
  if (channelId === null) return [];
  return auto.filter((a) => a.homeChannelId === channelId);
}

/**
 * v2.0.1 (Krew: "it only does the videos for one channel. I want it to do all of them"): spread clips over every channel
 * that can take them instead of always the first. A GTA 6 clip can go to the GTA channel (weight 2, so it still gets about
 * 2 of 3) or to a non-GTA channel taking its type; a non-GTA clip only to non-GTA channels taking its type. Lowest
 * load / weight wins; ties keep channelForClip's order. Krew's own pick (clip.channelId) always wins.
 * `load` = clips already given to each channel recently (see assignChannels).
 */
export function balancedChannel<C extends ChannelLite>(channels: C[], clip: { channelId?: string | null; category?: string | null; gta?: boolean }, load: Record<string, number>): C | null {
  if (clip.channelId) {
    const picked = channels.find((c) => c.id === clip.channelId);
    if (picked) return picked;
  }
  const first = channelForClip(channels, { ...clip, channelId: null });
  if (!first) return null;
  const cat = clip.category === "funny" || clip.category === "gaming" || clip.category === "edits" ? clip.category : "gaming";
  const takes = (c: C) => parseKinds(c.kinds).includes(cat);
  const pool = channels.filter((c) => takes(c) && (clip.gta || !isGtaFocus(c)));
  const weight = (c: C) => (clip.gta && isGtaFocus(c) ? 2 : 1);
  const order = (c: C) => (c.id === first.id ? 0 : 1);
  return [...pool].sort((a, b) => (load[a.id] ?? 0) / weight(a) - (load[b.id] ?? 0) / weight(b) || order(a) - order(b))[0] ?? first;
}
