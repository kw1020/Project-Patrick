// Today's schema turned back into the v1.7.3 (bf79233) one: the v1.8.0 columns removed and the three changed
// defaults put back. The older db-push upgrade tests derive their old schemas from this.
export function toV173Schema(now: string): string {
  return now
    .replace(/^ {2}(standoutMin|maxPerCreatorPerRun|jumpCuts|migratedAnyGame|payoffAt|wordsFull)\s.*\n/gm, "")
    .replace(/^ {2}clipMaxSec .*\n/m, "  clipMaxSec       Int     @default(45)\n")
    .replace(/^ {2}clipLookbackHrs .*\n/m, "  clipLookbackHrs  Int     @default(24)\n")
    .replace(/^ {2}gameMode .*\n/m, '  gameMode         String  @default("gta6") // gta6 | any (approved streamers in any game)\n');
}
