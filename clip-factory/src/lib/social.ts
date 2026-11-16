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

/** Clean model-written hashtags: letters/digits only, no dupes, #GTA6 always first, max 8. */
export function cleanHashtags(tags: string[], login: string) {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of ["GTA6", ...tags, login]) {
    const t = raw.replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 30);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push("#" + t);
    if (out.length >= 8) break;
  }
  return out;
}

/** Caption from the Judge's output. The credit line is added here, in code, so it can never be dropped. */
export function judgedCaption(title: string, hashtags: string[], streamerName: string, login: string) {
  return [title, "", `🎥 Credit: ${streamerName} — https://twitch.tv/${login}`, "", hashtags.join(" ")].join("\n");
}
