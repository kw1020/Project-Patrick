// Today's schema turned back into the v1.9.0 (028c1be) one: the v1.9.1 columns and the Campaign model removed.
export function toV190Schema(now: string): string {
  return now
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
