// v1.9.5: Krew's real brands (2026-11-19), made on first start only when there are no channels yet (`ensureChannels`).
// Handles are public. Krew's later edits are never overwritten: this runs once (Settings.migratedChannels).
// focus/kinds map onto v2.0's Account.purpose: gta+all kinds -> "all", funny -> "funny", gaming -> "gaming", edits -> "edits".

export type SeedAccount = { platform: "youtube" | "tiktok" | "instagram"; handle: string; youtubeChannelId?: string; disabled?: string };
export type SeedChannel = { id: string; name: string; focus: "gta" | "any"; kinds: string; accounts: SeedAccount[] };

export const DISABLED_IG_NOTE = "Instagram disabled this account, appeal in the app";

export const CHANNEL_SEEDS: SeedChannel[] = [
  {
    id: "main", name: "ViceCityClips", focus: "gta", kinds: "gaming,funny,edits",
    accounts: [
      { platform: "youtube", handle: "@ViceCityClips1-r2c" },
      { platform: "tiktok", handle: "@vicecityclips997" },
      { platform: "instagram", handle: "@vicecityclips116" },
    ],
  },
  {
    id: "streamheist", name: "StreamHeistClips", focus: "any", kinds: "funny",
    accounts: [
      { platform: "youtube", handle: "@StreamHeistClips-k4f" },
      { platform: "tiktok", handle: "@streamheistclips0" },
      { platform: "instagram", handle: "@streamheistclips3" },
    ],
  },
  {
    id: "wantedlevel", name: "WantedLevelClips", focus: "any", kinds: "gaming",
    accounts: [
      { platform: "youtube", handle: "@WantedLevelClips-k1e", youtubeChannelId: "UCqnlrJu2A_P-OLH2zvT_IBg" },
      { platform: "tiktok", handle: "@wantedlevelclips02" },
    ],
  },
  {
    id: "clipfactorygg", name: "ClipFactoryGG", focus: "any", kinds: "edits",
    accounts: [
      { platform: "youtube", handle: "@ClipFactoryGG-b9l" },
      { platform: "tiktok", handle: "@clipfactorygg1" },
      { platform: "instagram", handle: "@clipfactorygg", disabled: DISABLED_IG_NOTE },
    ],
  },
];

const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]/g, "");

/**
 * Is this already-connected account the seeded one? Same platform and the same handle/username, the same YouTube
 * channel id, or (YouTube) a channel title equal to the brand name ("ViceCityClips" for @ViceCityClips1-r2c).
 */
export function matchesSeed(a: { platform: string; handle?: string | null; username?: string | null; channelTitle?: string | null; channelId?: string | null }, ch: SeedChannel, s: SeedAccount) {
  if (a.platform !== s.platform) return false;
  const h = norm(s.handle);
  if ([a.handle, a.username, a.channelTitle].some((x) => x && norm(x) === h)) return true;
  if (s.youtubeChannelId && a.channelId === s.youtubeChannelId) return true;
  return s.platform === "youtube" && norm(a.channelTitle) === norm(ch.name);
}
