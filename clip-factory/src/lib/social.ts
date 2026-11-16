// Captions for the post itself (TikTok / Shorts / Reels). Always credits the streamer.
export function defaultTitle(sourceTitle: string | null | undefined, streamerName: string) {
  const t = (sourceTitle || "").trim();
  return (t && t.length > 3 ? t : `${streamerName} in GTA 6`).slice(0, 90);
}

export function defaultCaption(title: string, streamerName: string, login: string) {
  const tag = login.replace(/[^a-z0-9_]/gi, "");
  return [
    title,
    "",
    `🎥 Credit: ${streamerName} — https://twitch.tv/${login}`,
    "",
    `#GTA6 #GTAVI #GrandTheftAuto #${tag} #twitch #gaming #fyp`,
  ].join("\n");
}
