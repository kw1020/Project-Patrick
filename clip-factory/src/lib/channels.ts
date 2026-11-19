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

/** What the Upload row for this account does: Post (YouTube upload), Send to TikTok (draft / direct), Post to Instagram (Reel; v2.0.3) or by hand. */
export function accountAction(a: Pick<AccountLite, "platform" | "mode">): "post" | "tiktok" | "instagram" | "manual" {
  if (a.mode === "manual") return "manual";
  if (a.platform === "tiktok") return "tiktok";
  if (a.platform === "instagram") return "instagram";
  return "post";
}

/** Accounts that can be posted to (any mode), i.e. not the Twitch follower-count login. */
export const isPostingAccount = (a: Pick<AccountLite, "platform">) => (POST_PLATFORMS as readonly string[]).includes(a.platform);
/** Accounts the Poster may upload to through the API (Queue buttons, auto-post on approve). v2.0.3: Instagram too. */
export const isApiPostingAccount = (a: Pick<AccountLite, "platform" | "mode">) => (POST_PLATFORMS as readonly string[]).includes(a.platform) && (a.mode ?? "api") === "api";

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
  // v2.0.6: the same pool the Judge's pick is checked against (an edits-only channel never gets a plain clip).
  const pool = clip.category === "edits" ? [first] : channelPool(channels, clip);
  const weight = (c: C) => (clip.gta && isGtaFocus(c) ? 2 : 1);
  const order = (c: C) => (c.id === first.id ? 0 : 1);
  return [...pool].sort((a, b) => (load[a.id] ?? 0) / weight(a) - (load[b.id] ?? 0) / weight(b) || order(a) - order(b))[0] ?? first;
}

// ---------- v2.0.6: the Judge picks the channel, each channel has its own editing ----------

/** A channel whose only type is Edits (ClipFactoryGG): never gets a plain clip. */
export function isEditsOnly(c: Pick<ChannelLite, "kinds">) {
  const k = parseKinds(c.kinds);
  return k.length > 0 && k.every((x) => x === "edits");
}

/**
 * The channels a clip may go to (the same rules as balancedChannel): it takes the clip's type (funny | gaming), and a GTA-focus
 * channel only gets GTA 6 clips. Edits-only channels never take a plain clip.
 */
export function channelPool<C extends ChannelLite>(channels: C[], clip: { category?: string | null; gta?: boolean }): C[] {
  const cat = clip.category === "funny" || clip.category === "gaming" ? clip.category : "gaming";
  return channels.filter((c) => parseKinds(c.kinds).includes(cat) && !isEditsOnly(c) && (clip.gta || !isGtaFocus(c)));
}

/** One plain line about a channel for the Judge (from its focus + types, so a renamed or new channel still describes itself). */
export function channelBlurb(c: Pick<ChannelLite, "kinds" | "focus">): string {
  const k = parseKinds(c.kinds).filter((x) => x !== "edits");
  if (isEditsOnly(c)) return "edits only (beat-synced montages); never give it a plain clip";
  if (isGtaFocus(c)) return `GTA 6 anything (${k.join(" or ") || "any type"}); never a clip from another game`;
  if (k.includes("funny") && !k.includes("gaming")) return "funny streamer moments from any game or Just Chatting: laughs, banter, reactions, fails";
  if (k.includes("gaming") && !k.includes("funny")) return "big plays and clutches from any game: chases, insane moves, wins";
  return `${k.join(" and ") || "no"} clips from any game`;
}

const normName = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/^@+/, "").replace(/[^a-z0-9]/g, "");

/**
 * The Judge's channel pick, checked in code: it must name (or be the id of) a channel in `channelPool` for this clip. Anything
 * else (unknown name, the GTA channel for a non-GTA clip, an edits-only channel, empty) → null, and the caller balances instead.
 */
export function validChannelPick<C extends ChannelLite>(channels: C[], clip: { category?: string | null; gta?: boolean }, pick: string | null | undefined): C | null {
  const p = normName(pick);
  if (!p) return null;
  return channelPool(channels, clip).find((c) => c.id === pick || normName(c.name) === p) ?? null;
}

export type ChannelStyle = { name?: string | null; editStyle?: string | null; layout?: string | null; captionStyle?: string | null };
/** "" / unknown → null (= use the global Settings value). */
export function parseChannelStyle(v: unknown): "hype" | "clean" | "meme" | null {
  return v === "hype" || v === "clean" || v === "meme" ? v : null;
}
export function parseChannelLayout(v: unknown): "auto" | "split" | "fullcam" | "blur" | null {
  return v === "auto" || v === "split" || v === "fullcam" || v === "blur" ? v : null;
}

/**
 * v2.0.6: how the Cutter renders a clip: its channel's style (null fields = the global Settings); a Re-cut choice wins.
 * The watermark is the clip's channel name (Settings.channelName only when the clip has no channel); none when Settings has it
 * off. The channel's caption style only applies when the editing style wasn't picked by hand in Re-cut.
 */
export function cutChoices(channel: ChannelStyle | null, s: { editStyle: string; layout: string; watermark: boolean; channelName: string }, over: { style?: string; layout?: string } = {}) {
  const style = parseChannelStyle(over.style) ?? parseChannelStyle(channel?.editStyle) ?? parseChannelStyle(s.editStyle) ?? "hype";
  return {
    style,
    captionStyle: over.style ? null : parseChannelStyle(channel?.captionStyle),
    layout: over.layout ?? parseChannelLayout(channel?.layout) ?? s.layout,
    watermark: s.watermark ? (channel?.name || s.channelName || null) : null,
  };
}

/** An account that Upload / approve sends to by itself: API YouTube/TikTok/Instagram (v2.0.3), switched on, login working. */
export const isAutoUploadAccount = (a: Pick<AccountLite, "platform" | "mode" | "error"> & { disabled?: boolean | null }) => isApiPostingAccount(a) && !a.disabled && !a.error;

/**
 * v2.0.6 (Krew: "a button for YouTube that says upload and just uploads it"): what the always-visible Upload button does for a
 * clip, and the plain-English blocker for the "Why can't I upload?" line. kind:
 * upload = one click uploads every connected account of the channel; connect = YouTube isn't connected (or its login broke):
 * the button goes to Connect YouTube for the clip's channel and uploads when it comes back (`href`); keys = the .env lines are
 * missing; blocked = not approved / no channel / Platform check fail / YouTube switched off; done = already on YouTube.
 * `restNow` = other connected accounts (TikTok, Instagram) that could upload right away.
 */
export type UploadButtonState = { kind: "upload" | "connect" | "keys" | "blocked" | "done"; label: string; href?: string; why: string | null; restNow: number };
export type UploadSlot = { platform: string; mode?: string | null; error?: string | null; disabled?: boolean | null; done: boolean };
export function uploadButton(o: {
  clipId: string; status: string; channel: { id: string; name: string } | null; slots: UploadSlot[];
  ytKeysMissing: string[]; platformFail: string | null; uploading?: boolean;
}): UploadButtonState {
  const label = (l: string) => (o.uploading ? "Uploading…" : l);
  const auto = (s: UploadSlot) => isAutoUploadAccount({ platform: s.platform, mode: s.mode ?? "api", error: s.error ?? null, disabled: s.disabled });
  if (!o.channel) return { kind: "blocked", label: "Upload", why: "It has no channel yet: use Move to… to pick one.", restNow: 0 };
  if (o.status !== "approved" && o.status !== "posted") return { kind: "blocked", label: "Upload", why: "Approve it first.", restNow: 0 };
  if (o.platformFail) return { kind: "blocked", label: "Upload", why: `The Platform check failed: ${o.platformFail}`, restNow: 0 };
  const yt = o.slots.find((s) => s.platform === "youtube") ?? null;
  const rest = o.slots.filter((s) => s.platform !== "youtube" && !s.done && auto(s)).length;
  if (yt && !yt.done && !yt.disabled && auto(yt)) return { kind: "upload", label: label("Upload"), why: null, restNow: rest };
  if (yt?.done) return rest ? { kind: "upload", label: label("Upload"), why: null, restNow: rest } : { kind: "done", label: "Live on YouTube ✓", why: null, restNow: 0 };
  if (yt?.disabled) {
    const why = `${o.channel.name}'s YouTube is switched off (Settings → Channels → Turn on).`;
    return rest ? { kind: "upload", label: label("Upload"), why, restNow: rest } : { kind: "blocked", label: "Upload", why, restNow: 0 };
  }
  if (o.ytKeysMissing.length) {
    return { kind: "keys", label: "Upload to YouTube (keys missing)", why: `YouTube isn't set up: add ${o.ytKeysMissing.join(" and ")} to .env, then restart Clip Factory.`, restNow: rest };
  }
  const href = `/api/youtube/connect?channel=${encodeURIComponent(o.channel.id)}&then=${encodeURIComponent(`upload:${o.clipId}`)}`;
  if (yt && yt.mode !== "manual" && yt.error) {
    return { kind: "connect", label: label("Reconnect + upload"), href, why: `${o.channel.name}'s YouTube login stopped working (${yt.error.slice(0, 120)}). The button signs in again, then uploads.`, restNow: rest };
  }
  return { kind: "connect", label: label("Upload to YouTube (connect first)"), href, why: `${o.channel.name}'s YouTube isn't connected yet${yt ? " (it's a by-hand handle)" : ""}. The button connects it, then uploads.`, restNow: rest };
}

/** v2.0.6 button text: "YouTube + TikTok now, Instagram by hand" (disabled accounts are left out). */
export function uploadSummary(rows: { platform: string; auto: boolean }[]): string {
  const now = rows.filter((r) => r.auto).map((r) => PLATFORM_LABEL[r.platform] ?? r.platform);
  const hand = rows.filter((r) => !r.auto).map((r) => PLATFORM_LABEL[r.platform] ?? r.platform);
  if (!now.length && !hand.length) return "no accounts yet";
  if (!now.length) return `${hand.join(" + ")} by hand`;
  return `${now.join(" + ")} now${hand.length ? `, ${hand.join(" + ")} by hand` : ""}`;
}
