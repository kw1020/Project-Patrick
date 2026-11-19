// Today's schema turned back into the v1.9.6 (7fb3948) one: the v1.9.8 columns removed, the minScore default put back.
export function toV196Schema(now: string): string {
  return now
    .replace(/^ {2}(judgeHookOk|judgePayoffIn|judgePayoff|judgeAudio|platformInfo|maxPerCreatorPerHour|migratedMinScore7)\s.*\n/gm, "")
    .replace(/^ {2}\/\/ v1\.9\.8.*\n/gm, "")
    .replace(/^ {2}minScore .*\n/m, "  minScore         Float   @default(6) // Judge auto-reject below this\n");
}

// Today's schema turned back into the v1.9.5 one: the v1.9.6 columns (Supreme Judge, video checks) and AiSpend removed.
export function toV195Schema(now: string): string {
  return toV196Schema(now)
    .replace(/^ {2}\w+ +\w+\??(?: +@default\([^)]*\))? *\/\/ v1\.9\.6.*\n/gm, "")
    .replace(/\/\/ v1\.9\.6: what the Supreme Judge[\s\S]*?\nmodel AiSpend \{[\s\S]*?\n\}\n\n/, "");
}

// Today's schema turned back into the v1.9.4 (de19280) one: the v1.9.5 columns (Channels, manual accounts, followers)
// and the Channel model removed.
export function toV194Schema(now: string): string {
  return toV195Schema(now)
    .replace(/^ {2}\w+ +\w+\??(?: +@default\([^)]*\))? *\/\/ v1\.9\.5.*\n/gm, "")
    .replace(/^\/\/ v1\.9\.5: mode "manual".*\n\/\/ platform "twitch".*\n/m, "")
    .replace("  platform     String    // youtube | tiktok | instagram | twitch (follower counts only)\n", "  platform     String    // youtube | tiktok\n")
    .replace(/\n\/\/ v1\.9\.5: one of Krew's brands[\s\S]*?\nmodel Channel \{[\s\S]*?\n\}\n/, "");
}

// Today's schema turned back into the v1.9.1 (1ac085c) one: the v1.9.4 Judge columns, Storage settings and comments removed.
export function toV191Schema(now: string): string {
  return toV194Schema(now)
    .replace(/^ {2}(judgeObservations|judgeFrames|judgeTokensIn|judgeTokensOut|retainRejectedHrs|retainPendingHrs|retainApprovedDays|retainPostedDays|retainRawHrs|retainRowsDays)\s.*\n/gm, "")
    .replace(/^ {2}\/\/ v1\.9\.4.*\n/gm, "");
}

// Today's schema turned back into the v1.9.0 (028c1be) one: the v1.9.1 columns and the Campaign model removed.
export function toV190Schema(now: string): string {
  return toV191Schema(now)
    .replace(/^ {2}(campaignId|campaign|campaignLink|channelName|watermark)\s.*\n/gm, "")
    .replace(/\n\/\/ v1\.9\.1 Campaign mode:[\s\S]*?\nmodel Campaign \{[\s\S]*?\n\}\n/, "");
}

// Today's schema turned back into the v1.8.0 (9bf0915) one: the v1.9.0 columns removed, the layout default put back.
export function toV180Schema(now: string): string {
  return toV190Schema(now)
    .replace(/^ {2}(facecamAuto|layout|camInfo)\s+String\?.*\n/gm, "")
    .replace(/^ {2}migratedAutoLayout\s.*\n/m, "")
    .replace(/^ {2}layout {11}String {2}@default\("auto"\).*\n/m, '  layout           String  @default("blur") // blur | facecam\n');
}

// Today's schema turned back into the v1.7.3 (bf79233) one: the v1.8.0 columns removed and the three changed
// defaults put back. The older db-push upgrade tests derive their old schemas from this.
export function toV173Schema(now: string): string {
  return toV180Schema(now)
    .replace(/^ {2}(standoutMin|maxPerCreatorPerRun|jumpCuts|migratedAnyGame|payoffAt|wordsFull)\s.*\n/gm, "")
    .replace(/^ {2}clipMaxSec .*\n/m, "  clipMaxSec       Int     @default(45)\n")
    .replace(/^ {2}clipLookbackHrs .*\n/m, "  clipLookbackHrs  Int     @default(24)\n")
    .replace(/^ {2}gameMode .*\n/m, '  gameMode         String  @default("gta6") // gta6 | any (approved streamers in any game)\n');
}
