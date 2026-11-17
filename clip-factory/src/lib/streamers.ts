// Streamer.login is unique PER PLATFORM (since v1.7.1): the same name can be a Twitch streamer and a YouTube channel.
// The database only has a plain (platform, login) index (a unique one makes `prisma db push` ask about data loss on
// existing databases), so every add flow checks here first. twitchId stays the real unique identity.
import { prisma } from "./db";

export type Platform = "twitch" | "youtube";

/** Another row on the SAME platform that already uses this login (e.g. an old Twitch row after a rename), or null. */
export function loginTakenBy(platform: Platform, login: string, twitchId: string) {
  return prisma.streamer.findFirst({ where: { platform, login, twitchId: { not: twitchId } }, select: { id: true, name: true } });
}
