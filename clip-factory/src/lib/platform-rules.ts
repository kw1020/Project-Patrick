// v1.9.8 "Platform check" (Krew: "we need the videos to follow the guidelines of every social media").
// Pure, no Node imports (the Queue card runs it in the browser). Rules checked on Krew's three platforms, from the
// platforms' own pages (read 2026-11-19):
//
// YouTube Shorts
//   - Square or vertical, up to 3 minutes = a Short: https://support.google.com/youtube/answer/15424877
//     and https://support.google.com/youtube/answer/12779649 (upload Shorts: "Up to 3 minutes")
//   - Title max 100 characters: https://support.google.com/youtube/answer/57407 ; description 5,000 characters (Data API).
//   - Encoding: MP4, H.264, AAC-LC, 48 kHz, 8 Mbps for 1080p: https://support.google.com/youtube/answer/1722171
//   - More than 60 hashtags = YouTube ignores all of them: https://support.google.com/youtube/answer/6390658
//   - Reused content (YPP): content from someone else without "significant original commentary, substantive modifications,
//     or educational or entertainment value" isn't monetised: https://support.google.com/youtube/answer/1311392
// TikTok
//   - Content Posting API (what our TikTok drafts use): MP4 (recommended)/WebM/MOV, H.264 (recommended), 23-60 FPS,
//     360-4096 px per side, max 4 GB; every creator can post 3-minute videos (some 5/10):
//     https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
//   - Caption max 2,200 UTF-16 units, hashtags and mentions count inside it: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
//   - For You feed: not eligible = "Reproduced or unoriginal content ... without any new or creative edits, such as content
//     with someone else's visible watermark or superimposed logo": https://www.tiktok.com/community-guidelines/en/fyf-standards
//     and https://www.tiktok.com/safety/en/policies-and-engagement/integrity-authenticity ; fake engagement ("like-for-like").
// Instagram Reels
//   - Graph API Reels spec: MP4/MOV, moov atom at the front, H.264/HEVC, AAC <= 48 kHz, 23-60 FPS, max 1920 px wide,
//     VBR <= 25 Mbps, 3 s - 15 min, <= 300 MB; caption <= 2,200 characters, 30 hashtags, 20 @tags:
//     https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
//   - Help Center (newer, stricter): "You can use up to 5 tags on a post. If you include more than 5 ... your comment won't
//     post" (help.instagram.com hashtags article); Reels over 3 minutes aren't recommended to new audiences.
//   - Original content guidelines: borders, watermarks, "just crediting the original creator" and same-language subtitle
//     transcripts alone are NOT material edits: https://creators.instagram.com/original-content-guidelines
//
// Safe zones: none of the three publish one for organic posts, only for ads (TikTok In-Feed template file: top 240, bottom
// 660, sides 120, a 180px button rail on the right from y 840; Meta Reels ads: top 14% / bottom 35% / sides 6%; Google
// vertical ads: top 288, bottom 672, left 48, right 192). The ad bottoms include the ad's call-to-action button, which
// organic posts don't have; measured organic overlays are about TikTok bottom 484 / right 140, Shorts top ~290-380 /
// bottom 390 / right 201, Reels bottom ~320 / right 120. Our text box (TEXT_SAFE) takes the ad tops, the organic bottoms
// and the widest right rail, so nothing we burn in sits under the top bar, the caption/username block or the buttons.

export const VIDEO_W = 1080, VIDEO_H = 1920;
/** Where burned-in text may go on the 1080x1920 frame (px from each edge). See the comment above for the sources. */
export const TEXT_SAFE = { top: 290, bottom: 480, left: 60, right: 190 } as const;
/** Centre line for centred text inside the safe box (the right button rail is wider than the left margin). */
export const TEXT_X = Math.round((TEXT_SAFE.left + VIDEO_W - TEXT_SAFE.right) / 2); // 475
/** The widest a centred line may be (symmetric around TEXT_X). */
export const TEXT_MAX_W = VIDEO_W - TEXT_SAFE.right - TEXT_SAFE.left;
export const SAFE_Y_TOP = TEXT_SAFE.top;
export const SAFE_Y_BOTTOM = VIDEO_H - TEXT_SAFE.bottom;

export type Platform = "youtube" | "tiktok" | "instagram";
export const PLATFORM_NAMES: Record<Platform, string> = { youtube: "YouTube Shorts", tiktok: "TikTok", instagram: "Instagram Reels" };

export const SPECS = {
  youtube: { maxSec: 180, minSec: 1, titleMax: 100, captionMax: 5000, maxHashtags: 60, maxBytes: 256 * 1024 ** 3, maxFps: 60, minFps: 1, maxMbps: 50 },
  tiktok: { maxSec: 180, minSec: 3, titleMax: null, captionMax: 2200, maxHashtags: null, maxBytes: 4 * 1024 ** 3, maxFps: 60, minFps: 23, maxMbps: 50 },
  instagram: { maxSec: 180, minSec: 3, titleMax: null, captionMax: 2200, maxHashtags: 5, maxBytes: 300 * 1024 ** 2, maxFps: 60, minFps: 23, maxMbps: 25 },
} as const;
/** Our own cap: more hashtags than this reads as spam on every app (Instagram's hard limit is 5 now). */
export const KEEP_HASHTAGS = 5;

/** Words that get a clip removed or limited: GTA 6 "leak" posts are taken down by Take-Two, and engagement bait is against all three. */
export const BANNED_PHRASES: { re: RegExp; why: string }[] = [
  { re: /\bleak(s|ed|ing)?\b/i, why: "says \"leak\" (GTA 6 leak posts get taken down, and this isn't one)" },
  { re: /\b(like|follow|sub)\s*(4|for)\s*(like|follow|sub)\b/i, why: "asks for like-for-like / follow-for-follow (fake engagement)" },
  { re: /\bnot\s+clickbait\b/i, why: "says \"not clickbait\" (misleading-title flag)" },
  { re: /\b(free\s+(robux|v-?bucks|money|shark\s*cards?))\b/i, why: "promises free money/currency (scam flag)" },
  { re: /\bgiveaway\b/i, why: "mentions a giveaway (needs official rules, scam flag otherwise)" },
  { re: /\b(official\s+trailer|rockstar\s+confirmed)\b/i, why: "claims to be official Rockstar content" },
];
/** Other apps' names in OUR watermark/credit text, or sources downloaded from them (their watermark would be in the video). */
const OTHER_APPS = /\b(tiktok|instagram|reels|youtube\s*shorts|capcut|snapchat)\b/i;
const OTHER_APP_HOST = /(^|\.)(tiktok\.com|instagram\.com|snapchat\.com|capcut\.com|douyin\.com)$/i;

export type Level = "ok" | "warn" | "fail";
export type CheckItem = { level: Level; text: string; platforms?: Platform[] };
export type PlatformCheck = { items: CheckItem[]; fails: number; warns: number; summary: string };

/** What ffprobe says about the finished file (stored on Clip.platformInfo by the Cutter). */
export type FileFacts = { width: number; height: number; vcodec: string; acodec: string | null; fps: number; seconds: number; bytes: number; kbps: number; faststart: boolean | null };
/** What the render put in (also stored on Clip.platformInfo). */
export type RenderFacts = {
  captions: boolean; hook: boolean; credit: boolean; watermark: string | null; styled: boolean; layout: string | null;
  /** Text boxes that ended up outside TEXT_SAFE (should be none; see test/v198.test.ts). */
  unsafeText: string[];
  /** Host of the source we downloaded (twitch.tv, youtube.com, …). */
  sourceHost?: string | null;
};
export type PlatformInfo = { file: FileFacts | null; render: RenderFacts | null; at?: string };

export function parsePlatformInfo(s: string | null | undefined): PlatformInfo | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? { file: o.file ?? null, render: o.render ?? null, at: o.at } : null;
  } catch { return null; }
}

const hashtagsOf = (s: string) => s.match(/#[\p{L}\p{N}_]+/gu) ?? [];
/** UTF-16 length (what TikTok and Instagram count). */
const u16 = (s: string) => s.length;

/** Format + length checks on the finished file. */
export function checkFile(f: FileFacts | null): CheckItem[] {
  if (!f) return [{ level: "warn", text: "Not measured yet (re-cut it to check the file)" }];
  const out: CheckItem[] = [];
  const all: Platform[] = ["youtube", "tiktok", "instagram"];
  if (f.width !== VIDEO_W || f.height !== VIDEO_H) {
    const vertical = f.height > f.width;
    out.push({ level: vertical ? "warn" : "fail", text: `Video is ${f.width}x${f.height}, not 1080x1920 (9:16)${vertical ? "" : ": it isn't vertical, so YouTube won't make it a Short"}` });
  } else out.push({ level: "ok", text: "1080x1920, 9:16" });
  const codecOk = /^(h264|avc)/i.test(f.vcodec), audioOk = f.acodec == null || /^aac/i.test(f.acodec);
  if (!codecOk) out.push({ level: "fail", text: `Video codec is ${f.vcodec}, the apps want H.264` });
  if (!audioOk) out.push({ level: "fail", text: `Audio codec is ${f.acodec}, the apps want AAC` });
  if (codecOk && audioOk) out.push({ level: "ok", text: `H.264${f.acodec ? " + AAC" : " (no sound)"}` });
  if (f.fps > 60.5) out.push({ level: "fail", text: `${Math.round(f.fps)} fps: TikTok and Instagram take at most 60` });
  else if (f.fps < 22.5) out.push({ level: "fail", text: `${Math.round(f.fps)} fps: TikTok and Instagram need at least 23` });
  if (f.kbps > SPECS.instagram.maxMbps * 1000) out.push({ level: "fail", text: `Bitrate ${(f.kbps / 1000).toFixed(1)} Mbps: Instagram allows 25 Mbps`, platforms: ["instagram"] });
  else if (f.kbps > 0 && f.kbps < 1500) out.push({ level: "warn", text: `Bitrate only ${(f.kbps / 1000).toFixed(1)} Mbps: may look blurry` });
  for (const p of all) if (f.bytes > SPECS[p].maxBytes) out.push({ level: "fail", text: `File is ${Math.round(f.bytes / 1024 ** 2)} MB, over ${PLATFORM_NAMES[p]}'s limit`, platforms: [p] });
  if (f.seconds > 180) out.push({ level: "fail", text: `${Math.round(f.seconds)}s long: Shorts, TikTok (API) and Reels reach all stop at 3:00` });
  else if (f.seconds < 3) out.push({ level: "fail", text: `${f.seconds.toFixed(1)}s long: TikTok and Instagram need at least 3s` });
  else if (f.seconds > 60) out.push({ level: "warn", text: `${Math.round(f.seconds)}s long: fine everywhere, but short clips do better` });
  else out.push({ level: "ok", text: `${Math.round(f.seconds)}s: inside every app's length limit` });
  if (f.faststart === false) out.push({ level: "warn", text: "File index is at the end (Instagram wants it at the front); re-cut to fix" });
  return out;
}

/** Caption + title text checks. `creditOk` = the caption credits the creator (src/lib/social.ts captionCredits). */
export function checkCaption(o: { caption: string; title?: string | null; creditOk: boolean }): CheckItem[] {
  const out: CheckItem[] = [];
  const cap = o.caption || "";
  if (!cap.trim()) return [{ level: "fail", text: "Caption is empty" }];
  // YouTube uploads add the credit line to the description by themselves (src/workers/poster.ts), so this blocks TikTok/Reels.
  if (!o.creditOk) out.push({ level: "fail", text: "Caption doesn't credit the creator (@name or channel link)", platforms: ["tiktok", "instagram"] });
  else out.push({ level: "ok", text: "Creator credited" });
  if (u16(cap) > SPECS.tiktok.captionMax) out.push({ level: "fail", text: `Caption is ${u16(cap)} characters: TikTok and Instagram allow 2,200`, platforms: ["tiktok", "instagram"] });
  const tags = hashtagsOf(cap);
  if (tags.length > SPECS.instagram.maxHashtags) out.push({ level: "fail", text: `${tags.length} hashtags: Instagram won't post more than 5 (keep it to ${KEEP_HASHTAGS})`, platforms: ["instagram"] });
  else out.push({ level: "ok", text: `${tags.length} hashtag${tags.length === 1 ? "" : "s"} (5 or fewer)` });
  const dupes = tags.filter((t, i) => tags.findIndex((x) => x.toLowerCase() === t.toLowerCase()) !== i);
  if (dupes.length) out.push({ level: "warn", text: `Repeated hashtag ${dupes[0]}` });
  const title = (o.title || "").trim();
  if (title && [...title].length > SPECS.youtube.titleMax) out.push({ level: "fail", text: `Title is ${[...title].length} characters: YouTube allows 100`, platforms: ["youtube"] });
  for (const b of BANNED_PHRASES) {
    if (b.re.test(cap) || b.re.test(title)) out.push({ level: "fail", text: `Caption/title ${b.why}` });
  }
  if (OTHER_APPS.test(cap.replace(/#\S+/g, ""))) out.push({ level: "warn", text: "Caption names another app (TikTok/Instagram/…); each app ranks that down" });
  if (/[A-Z]{12,}/.test(cap.replace(/#\S+|@\S+/g, ""))) out.push({ level: "warn", text: "Lots of ALL CAPS in the caption reads as clickbait" });
  return out;
}

/**
 * Originality (YouTube reused content, TikTok unoriginal content, Meta original content). All three say a credit, a
 * watermark or a same-language transcript alone is not enough; what counts is real editing: a hook/commentary line,
 * a new layout (cam + game), zooms/cuts/sound design. Our standard render (styled edit + hook + captions + credit) clears it.
 */
export function checkOriginality(r: RenderFacts | null): CheckItem[] {
  if (!r) return [{ level: "warn", text: "Edits not recorded yet (re-cut it to check)" }];
  const out: CheckItem[] = [];
  const edits = [r.hook && "hook text", r.styled && "zooms/cuts/sound effects", (r.layout === "split" || r.layout === "fullcam") && "new layout", r.captions && "captions"].filter(Boolean) as string[];
  const creative = [r.hook, r.styled, r.layout === "split" || r.layout === "fullcam"].filter(Boolean).length;
  if (!r.credit) out.push({ level: "fail", text: "No creator credit burned into the video" });
  if (creative === 0) out.push({ level: "fail", text: `Too little editing to count as original (${edits.length ? `only ${edits.join(", ")}` : "a plain re-upload"}): add a hook or re-cut in a styled edit` });
  else if (creative === 1 && !r.captions) out.push({ level: "warn", text: `Light editing (${edits.join(", ")}): add captions or a hook so it isn't seen as reused` });
  else out.push({ level: "ok", text: `Edited, not a re-upload (${edits.join(", ")})` });
  if (r.unsafeText?.length) out.push({ level: "warn", text: `Text under the app buttons/captions: ${r.unsafeText.join(", ")} (re-cut to move it)` });
  else out.push({ level: "ok", text: "All text inside every app's safe zone" });
  if (r.watermark && /tiktok|instagram|reels|shorts|capcut|snapchat/i.test(r.watermark)) out.push({ level: "fail", text: `Watermark "${r.watermark}" names another app` });
  if (r.sourceHost && OTHER_APP_HOST.test(r.sourceHost)) out.push({ level: "fail", text: `Source came from ${r.sourceHost}: it carries that app's watermark` });
  else out.push({ level: "ok", text: "No other app's watermark" });
  return out;
}

/** Everything for one clip (Queue card "Platform check" + the Poster's block). */
export function platformCheck(o: { caption: string; title?: string | null; creditOk: boolean; info: PlatformInfo | null; qa?: { type: string; detail: string; source?: string }[] | null }): PlatformCheck {
  // v1.9.6's video check (src/lib/qa.ts: ffmpeg black/freeze/silence/loudness) is reused, not re-run: its picture/sound
  // findings show here as warnings (it has its own Fix it box).
  const qa: CheckItem[] = (o.qa ?? []).filter((i) => ["black", "frozen", "audio"].includes(i.type)).map((i) => ({ level: "warn", text: `Video check: ${i.detail}` }));
  const items = [...checkFile(o.info?.file ?? null), ...qa, ...checkOriginality(o.info?.render ?? null), ...checkCaption(o)];
  const fails = items.filter((i) => i.level === "fail").length, warns = items.filter((i) => i.level === "warn").length;
  const summary = fails ? `${fails} problem${fails === 1 ? "" : "s"} block posting` : warns ? `OK to post, ${warns} warning${warns === 1 ? "" : "s"}` : "Ready for Shorts, TikTok and Reels";
  return { items, fails, warns, summary };
}

/** The Poster's guard: a plain-English reason when a hard fail blocks posting to `platform`, else null. */
export function postBlockReason(check: PlatformCheck, platform: string): string | null {
  const p = (platform === "youtube" || platform === "tiktok" || platform === "instagram" ? platform : null) as Platform | null;
  const hard = check.items.filter((i) => i.level === "fail" && (!i.platforms || !p || i.platforms.includes(p)));
  return hard.length ? `Platform check failed: ${hard.map((i) => i.text).join("; ")}` : null;
}

/** Rough on-screen width (px) of bold sans text (DejaVu Sans Bold metrics, checked against real renders in test/v198). */
export function textWidth(text: string, size: number, opts: { spacing?: number; outline?: number } = {}): number {
  let em = 0;
  for (const ch of text) {
    if (ch === " ") em += 0.35;
    else if (/[MWmw@]/.test(ch)) em += 0.95;
    else if (/[A-Z]/.test(ch)) em += 0.76;
    else if (/[iljI.,:;!'|]/.test(ch)) em += 0.36;
    else if (/[a-z]/.test(ch)) em += 0.64;
    else if (/[0-9]/.test(ch)) em += 0.7;
    else em += 0.8;
  }
  return em * size + [...text].length * (opts.spacing ?? 0) + 2 * (opts.outline ?? 0);
}
/** Scale (<= 1) that makes a line fit `maxW` px. */
export function fitScale(text: string, size: number, maxW = TEXT_MAX_W, opts: { spacing?: number; outline?: number } = {}): number {
  const w = textWidth(text, size, opts);
  return w <= maxW ? 1 : Math.max(0.5, Math.floor((maxW / w) * 100) / 100);
}
