// v2.0.5 Edits: the "Top 5" countdown compilation (Krew: "the montage moments to be like top 5 funniest parts... Just like a
// montage of multiple clips"). Pure (test/v205.test.ts); src/lib/top5-render.ts renders it, src/workers/top5.ts runs it.
//   title card (1.4s, the hook + "#5") -> #5 -> number card "#4" (0.7s) -> #4 -> ... -> "#1" -> #1 -> end card "Follow @<channel>"
// Each entry is the moment's own tight cut (setup -> payoff -> reaction, 6-12s) with its own sound + captions in its v1.9 layout.
// Effects only where they earn it: ONE punch-in per entry on its payoff, nothing else moves.
import { isUsable, sameMoment, type Candidate } from "./edit-pick";
import { chunkWords, type Word } from "./media";
import { sentences } from "./window";
import { TOP5_COUNT, type Top5Theme } from "./edit-vibes";
import { isGta6, momentGame, brandedCaption, creatorHandle, type CampaignRules, type Creator } from "./social";
import { KEEP_HASHTAGS, TEXT_MAX_W, TEXT_SAFE, TEXT_X, fitScale } from "./platform-rules";
import { watermarkPlace, watermarkStyle, watermarkText, type OverlayPlace } from "./layout";

export const FPS = 30;
export const TITLE_FRAMES = 42; // 1.4s: the hook, then "#5" pops in under it
export const CARD_FRAMES = 21; // 0.7s number card between entries
export const END_FRAMES = 45; // 1.5s "Follow @channel"
export const ENTRY_MIN = 6, ENTRY_MAX = 12;
export const TOTAL_MIN = 45, TOTAL_MAX = 75;
/** Most entries one creator may have (unless it's that creator's own top 5). */
export const MAX_PER_CREATOR = 2;
/** How far back "recent" goes (days); widened once when there aren't 5 moments. */
export const LOOKBACK_DAYS = 7, LOOKBACK_WIDE_DAYS = 30;
const r3 = (t: number) => Math.round(t * 1000) / 1000;

// ---------- Picking ----------
export type Top5Cand = Candidate & {
  streamerId: string; login: string; name: string; platform: string; approved: boolean;
  gameName: string | null;     // Moment.gameName (null = GTA 6 on older rows)
  spikeScore: number;          // Moment.spikeScore (standout for Twitch clips)
  judgePayoff: string | null;  // the Judge named the payoff in one line (v1.9.8)
  winStart: number | null; winLength: number | null; // the clip's (v1.9.8 tightened) window in raw seconds
};
export type Top5Ranked = Top5Cand & { strength: number; why: string };

export const isGtaMoment = (c: Pick<Top5Cand, "gameName" | "source">) => isGta6(momentGame({ gameName: c.gameName, source: c.source }));

/** Does the moment fit the theme? funny / gaming = its (Judge) category; gta = a GTA 6 moment; creator = that creator. */
export function fitsTheme(c: Top5Cand, theme: Top5Theme, creatorId?: string | null): boolean {
  if (theme === "creator") return c.streamerId === creatorId;
  if (theme === "funny") return c.category === "funny";
  if (theme === "gaming") return c.category === "gaming";
  return isGtaMoment(c);
}

/**
 * Strength 0..1: Judge score (unscored 0.5) x 0.55 + standout (log, 1 at 8x the creator's usual) x 0.25 + a named / known payoff
 * 0.12 + recency up to 0.08 (3-day half-life). Only approved creators and usable moments (edit-pick isUsable).
 */
export function rankTop5(cands: Top5Cand[], now = new Date()): Top5Ranked[] {
  return cands.filter((c) => c.approved && isUsable(c)).map((c) => {
    const score = c.score == null ? 0.5 : Math.max(0, Math.min(1, c.score / 10));
    const standout = c.spikeScore > 0 ? Math.max(0, Math.min(1, Math.log2(1 + c.spikeScore) / 3)) : 0.2;
    const payoff = c.judgePayoff && c.judgePayoff.trim().split(/\s+/).length >= 3 ? 0.12 : c.payoffAt != null ? 0.08 : 0;
    const ageDays = Math.max(0, (now.getTime() - c.createdAt.getTime()) / 86_400_000);
    const recency = 0.08 * Math.pow(0.5, ageDays / 3);
    const strength = Math.round((0.55 * score + 0.25 * standout + payoff + recency) * 1000) / 1000;
    return { ...c, strength, why: `score ${c.score ?? "-"}, standout ${c.spikeScore.toFixed(1)}x${c.judgePayoff ? `, payoff: ${c.judgePayoff}` : ""}` };
  }).sort((a, b) => b.strength - a.strength || b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * The moments for a Top 5, best first: theme filter, recent first (7 days, else 30), never the same moment twice, at most 2 per
 * creator (not for a one-creator top 5), moments of the last Top 5s (`avoid`) only when there aren't enough others.
 * Returns `want` picks + up to `spares` more (a failed download is replaced by the next one).
 */
export function pickTop5(cands: Top5Cand[], o: { theme: Top5Theme; creatorId?: string | null; now?: Date; avoid?: string[]; want?: number; spares?: number }) {
  const now = o.now ?? new Date();
  const want = o.want ?? TOP5_COUNT, spares = o.spares ?? 3;
  const themed = cands.filter((c) => fitsTheme(c, o.theme, o.creatorId));
  const avoid = new Set(o.avoid ?? []);
  const run = (days: number) => {
    const recent = rankTop5(themed.filter((c) => now.getTime() - c.createdAt.getTime() <= days * 86_400_000), now);
    const ordered = [...recent.filter((c) => !avoid.has(c.momentId)), ...recent.filter((c) => avoid.has(c.momentId))];
    const out: Top5Ranked[] = [];
    const per = new Map<string, number>();
    for (const c of ordered) {
      if (out.some((x) => sameMoment(x, c) || (x.clipId && x.clipId === c.clipId))) continue;
      if (o.theme !== "creator" && (per.get(c.streamerId) ?? 0) >= MAX_PER_CREATOR) continue;
      out.push(c);
      per.set(c.streamerId, (per.get(c.streamerId) ?? 0) + 1);
      if (out.length >= want + spares) break;
    }
    return out;
  };
  let picked = run(LOOKBACK_DAYS);
  if (picked.length < want) picked = run(LOOKBACK_WIDE_DAYS);
  return { picks: picked.slice(0, want), spares: picked.slice(want), enough: picked.length >= want };
}

/** Countdown order: the weakest of the 5 first (#5), the best last (#1). */
export const countdown = <T>(bestFirst: T[]): T[] => [...bestFirst].reverse();

// ---------- Each entry's cut ----------
export type EntryWindow = { start: number; end: number; payoff: number };

/**
 * The entry's tight cut in file seconds: setup -> payoff -> reaction, 6-12s. Opens at the sentence start (0.25s early) 2.5-6s
 * before the payoff closest to `lead` before it, ends `tail` after it (moved to the end of a word it would cut, else its start),
 * inside the clip's own (v1.9.8 tightened) window when that leaves >= 6s, never past the file.
 */
export function entryWindow(o: { payoff: number; dur: number; words: Word[]; win?: { start: number; end: number } | null; lead?: number; tail?: number }): EntryWindow {
  const lead = o.lead ?? 4, tail = o.tail ?? 4.5;
  const fileLo = 0, fileHi = Math.max(0.5, o.dur - 0.05);
  let lo = fileLo, hi = fileHi;
  if (o.win && o.win.end - o.win.start >= ENTRY_MIN) { lo = Math.max(fileLo, o.win.start - 0.3); hi = Math.min(fileHi, o.win.end + 0.3); }
  const p = Math.max(lo + Math.min(2, (hi - lo) / 2), Math.min(hi - 1, o.payoff));
  const starts = sentences(o.words).map((s) => s.start - 0.25).filter((t) => t >= p - 6 && t <= p - 2.5 && t >= lo);
  let start = starts.length ? starts.reduce((a, b) => (Math.abs(b - (p - lead)) < Math.abs(a - (p - lead)) ? b : a)) : p - lead;
  start = Math.max(lo, start);
  const inWord = (t: number) => o.words.find((w) => w.start < t && w.end > t);
  const ws = inWord(start);
  if (ws) start = Math.max(lo, ws.start - 0.1);
  let end = Math.min(hi, p + tail);
  const we = inWord(end);
  if (we) end = we.end + 0.15 <= Math.min(hi, start + ENTRY_MAX) ? we.end + 0.15 : Math.max(p + 1, we.start - 0.05);
  // 6s minimum: more reaction first, then more setup; then the file's own edges
  if (end - start < ENTRY_MIN) end = Math.min(hi, start + ENTRY_MIN);
  if (end - start < ENTRY_MIN) start = Math.max(lo, end - ENTRY_MIN);
  if (end - start < ENTRY_MIN) { end = Math.min(fileHi, start + ENTRY_MIN); start = Math.max(fileLo, end - ENTRY_MIN); }
  if (end - start > ENTRY_MAX) end = start + ENTRY_MAX;
  return { start: r3(start), end: r3(end), payoff: r3(p) };
}

/** The total length of the finished Top 5 for these entry lengths (cards included). */
export const top5Total = (lens: number[]) => r3(lens.reduce((n, l) => n + Math.round(l * FPS), 0) / FPS + (TITLE_FRAMES + Math.max(0, lens.length - 1) * CARD_FRAMES + END_FRAMES) / FPS);

/**
 * Stretch short entries (more reaction, then more setup, 0.25s at a time, each <= 12s and inside its file) until the whole
 * Top 5 is >= 45s; trim the longest ones (from the end) when it's over 75s.
 */
export function fitTotal(wins: EntryWindow[], durs: number[], o: { min?: number; max?: number } = {}): EntryWindow[] {
  const min = o.min ?? TOTAL_MIN, max = o.max ?? TOTAL_MAX;
  const out = wins.map((w) => ({ ...w }));
  const total = () => top5Total(out.map((w) => w.end - w.start));
  for (let guard = 0; total() < min && guard < 400; guard++) {
    let grew = false;
    for (let i = 0; i < out.length && total() < min; i++) {
      const w = out[i], len = w.end - w.start;
      if (len >= ENTRY_MAX - 1e-6) continue;
      const step = Math.min(0.25, ENTRY_MAX - len);
      if (w.end - w.payoff < 7 && w.end + step <= durs[i] - 0.05) { w.end = r3(w.end + step); grew = true; }
      else if (w.payoff - w.start < 7 && w.start - step >= 0) { w.start = r3(w.start - step); grew = true; }
    }
    if (!grew) break;
  }
  for (let guard = 0; total() > max && guard < 400; guard++) {
    const i = out.reduce((bi, w, k) => (w.end - w.start > out[bi].end - out[bi].start ? k : bi), 0);
    const w = out[i];
    if (w.end - w.start <= ENTRY_MIN || w.end - 0.25 <= w.payoff + 1.5) break;
    w.end = r3(w.end - 0.25);
  }
  return out;
}

/** The punch-in on the payoff (entry seconds): eases in 0.2s, holds 0.9s, eases out 0.3s. The only zoom in a Top 5. */
export const PUNCH = { amp: 0.12, in: 0.2, hold: 0.9, out: 0.3 };
export function punchExpr(at: number | null, len: number): string | null {
  if (at == null || at < 0.3 || at > len - 0.6) return null;
  const a = r3(at - 0.1), b = r3(a + PUNCH.in), c = r3(b + PUNCH.hold), d = r3(Math.min(len, c + PUNCH.out));
  const u = `if(lt(t,${a}),0,if(lt(t,${b}),(t-${a})/${PUNCH.in},if(lt(t,${c}),1,if(lt(t,${d}),(${d}-t)/${r3(d - c) || 0.01},0))))`;
  return `(1+${PUNCH.amp}*(${u})*(${u})*(3-2*(${u})))`;
}

/** Word captions of the entry (entry seconds), v1.9 chunks of <= 3 words. */
export function entryCaptions(words: Word[], w: EntryWindow) {
  const len = w.end - w.start;
  const inside = words.filter((x) => x.start >= w.start - 0.05 && x.end <= w.end + 0.3)
    .map((x) => ({ word: x.word, start: r3(Math.max(0, x.start - w.start)), end: r3(Math.min(len, x.end - w.start)) }));
  return chunkWords(inside).map((c) => ({ ...c, start: r3(c.start), end: r3(Math.min(len, c.end)) })).filter((c) => c.end > c.start);
}

// ---------- Text ----------
/** On-screen title (no emoji: the burned-in font has none) + the caption hook (with one). */
export function top5Titles(theme: Top5Theme, o: { allGta: boolean; creatorName?: string | null; funnyShare?: number }): { card: string; hook: string } {
  const gta = o.allGta ? "GTA 6 " : "";
  if (theme === "creator") {
    const name = (o.creatorName || "Their").trim();
    const emoji = (o.funnyShare ?? 0) >= 0.5 ? "😂" : "🔥";
    return { card: `${name}'s top 5 ${o.allGta ? "GTA 6 moments" : "moments"}`.toUpperCase(), hook: `${name}'s top 5 ${o.allGta ? "GTA 6 moments" : "moments"} ${emoji}` };
  }
  if (theme === "funny") return { card: `TOP 5 FUNNIEST ${o.allGta ? "GTA 6" : "STREAMER"} MOMENTS`, hook: `Top 5 funniest ${o.allGta ? "GTA 6" : "streamer"} moments 😂` };
  if (theme === "gaming") return { card: `TOP 5 CRAZIEST ${gta}PLAYS`, hook: `Top 5 craziest ${gta}plays 🔥` };
  return { card: "TOP 5 GTA 6 MOMENTS", hook: "Top 5 GTA 6 moments 🔥" };
}

/** The title split into lines that each fit the safe zone at the title size ("TOP 5" on its own line, big). */
export function titleLines(card: string): string[] {
  const m = card.match(/^(.*?)(TOP 5)(.*)$/);
  const head = m ? `${m[1]}${m[2]}`.trim() : null, rest = (m ? m[3] : card).trim();
  const words = rest.replace(/GTA 6/g, "GTA 6").split(/ +/).filter(Boolean); // "GTA 6" never splits over two lines
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > 13) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return (head ? [head, ...lines] : lines).map((l) => l.replace(/ /g, " "));
}

/**
 * Caption: brandedCaption (the hook = the title; a one-creator top 5 keeps that creator's campaign rules) with EVERY creator on
 * the credit line ("🎥 @a @b @c") and #edit on the hashtag line when there's room (<= 5 hashtags).
 */
export function top5Caption(hook: string, creators: Creator[], o: { theme: Top5Theme; campaign?: CampaignRules | null; game?: string | null }) {
  const uniq = creators.filter((c, i) => creators.findIndex((x) => creatorHandle(x).toLowerCase() === creatorHandle(c).toLowerCase()) === i);
  const lead = uniq[0] ?? { login: "clips", name: "Clips" };
  const extras = o.theme === "funny" ? ["GTA6Funny"] : o.theme === "gaming" ? ["Gaming"] : o.theme === "gta" ? ["GTA6Clips"] : ["StreamerMoments"];
  const cap = brandedCaption({ hook, streamer: lead, extras, campaign: o.theme === "creator" ? o.campaign ?? null : null, category: o.theme === "funny" ? "funny" : null, game: o.game ?? null });
  const lines = cap.split("\n");
  // brandedCaption drops emoji from hooks; the Top 5 hook keeps its one closing emoji ("... moments 😂") when nothing else changed it
  if (lines[0] === hook.replace(/\s*[\p{Extended_Pictographic}\u{FE0F}]+$/u, "").trim()) lines[0] = hook.trim();
  const ci =lines.indexOf(`🎥 ${creatorHandle(lead)}`);
  if (ci >= 0 && uniq.length > 1) lines[ci] = `🎥 ${uniq.map(creatorHandle).join(" ")}`;
  const hi = lines.findIndex((l) => /^#\S/.test(l));
  if (hi >= 0 && !/(^|\s)#edit(\s|$)/i.test(lines[hi]) && (lines[hi].match(/#[\p{L}\p{N}_]+/gu) ?? []).length < KEEP_HASHTAGS) lines[hi] += " #edit";
  const out = lines.join("\n");
  const max = o.theme === "creator" && o.campaign && o.campaign.active !== false && o.campaign.maxCaptionChars ? o.campaign.maxCaptionChars : null;
  return max && [...out].length > max ? cap : out;
}

// ---------- ASS ----------
function assTime(t: number) {
  const cs = Math.round(Math.max(0, t) * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = (cs % 6000) / 100;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
const esc = (s: string) => s.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\r?\n/g, " ").trim();
const scaleTag = (k: number) => (k < 1 ? `\\fscx${Math.round(k * 100)}\\fscy${Math.round(k * 100)}` : "");
const YELLOW = "&H0000E6FF"; // BGR: #FFE600

function header(font: string) {
  return [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Big,${font},120,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,2,0,1,10,5,5,${TEXT_SAFE.left},${TEXT_SAFE.right},0,1`,
    `Style: Num,${font},380,${YELLOW},&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,4,0,1,16,8,5,${TEXT_SAFE.left},${TEXT_SAFE.right},0,1`,
    `Style: Who,${font},64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,1,0,1,6,3,5,${TEXT_SAFE.left},${TEXT_SAFE.right},0,1`,
    `Style: Cap,${font},86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,1,0,1,7,3,5,${TEXT_SAFE.left},${TEXT_SAFE.right},0,1`,
    `Style: Credit,${font},46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,-1,0,0,0,100,100,0,0,1,5,2,8,${TEXT_SAFE.left},${TEXT_SAFE.right},0,1`,
    watermarkStyle(font),
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
}
const fontOf = (f?: string) => f || process.env.CAPTION_FONT || "DejaVu Sans";
const pos = (y: number, an = 5) => `\\an${an}\\pos(${TEXT_X},${y})`;

/** Title card (0..1.4s): the title pops in on frame 0 (it IS the hook), "#5" pops under it at 0.65s. */
export function titleAss(o: { card: string; first: number; watermark?: string | null; font?: string }) {
  const lines = header(fontOf(o.font));
  const tl = titleLines(o.card);
  const D = TITLE_FRAMES / FPS;
  const sizes = tl.map((l, i) => (i === 0 && l.endsWith("TOP 5") ? 190 : 118));
  const heights = sizes.map((s) => s * 1.12);
  let y = 820 - heights.reduce((a, b) => a + b, 0) / 2;
  tl.forEach((l, i) => {
    const k = fitScale(l, sizes[i], TEXT_MAX_W, { spacing: 2, outline: 10 });
    const s = Math.round(sizes[i] * Math.min(1, k));
    const yc = Math.round(y + heights[i] / 2);
    y += heights[i];
    const col = i === 0 && sizes[i] > 150 ? `\\c${YELLOW}&` : "";
    lines.push(`Dialogue: 2,${assTime(0)},${assTime(D)},Big,,0,0,0,,{${pos(yc)}\\fs${s}${col}\\fscx70\\fscy70\\t(0,${80 + i * 30},\\fscx104\\fscy104)\\t(${80 + i * 30},${160 + i * 30},\\fscx100\\fscy100)}${esc(l)}`);
  });
  const at = 0.65;
  lines.push(`Dialogue: 3,${assTime(at)},${assTime(D)},Num,,0,0,0,,{${pos(1225)}\\fs260\\fscx160\\fscy160\\t(0,110,\\fscx100\\fscy100)}#${o.first}`);
  pushMark(lines, D, o.watermark, null);
  return lines.join("\n") + "\n";
}

/** Number card (0.7s): a big "#3" pops in over the blurred freeze, the creator under it. */
export function cardAss(o: { n: number; login: string; watermark?: string | null; font?: string }) {
  const lines = header(fontOf(o.font));
  const D = CARD_FRAMES / FPS;
  lines.push(`Dialogue: 3,${assTime(0)},${assTime(D)},Num,,0,0,0,,{${pos(860)}\\fscx150\\fscy150\\t(0,120,\\fscx96\\fscy96)\\t(120,200,\\fscx100\\fscy100)}#${o.n}`);
  const who = esc(`@${o.login}`);
  lines.push(`Dialogue: 2,${assTime(0.12)},${assTime(D)},Who,,0,0,0,,{${pos(1110)}${scaleTag(fitScale(who, 64, TEXT_MAX_W, { outline: 6 }))}\\fad(80,0)}${who}`);
  pushMark(lines, D, o.watermark, null);
  return lines.join("\n") + "\n";
}

/** End card (1.5s): "FOLLOW" + "@<channel>". */
export function endAss(o: { channel: string; font?: string }) {
  const lines = header(fontOf(o.font));
  const D = END_FRAMES / FPS;
  const ch = watermarkText(o.channel) || "@ClipFactory";
  lines.push(`Dialogue: 2,${assTime(0)},${assTime(D)},Big,,0,0,0,,{${pos(790)}\\fs130\\fscx70\\fscy70\\t(0,120,\\fscx100\\fscy100)}FOLLOW`);
  const k = fitScale(ch, 104, TEXT_MAX_W, { spacing: 2, outline: 10 });
  lines.push(`Dialogue: 2,${assTime(0.1)},${assTime(D)},Big,,0,0,0,,{${pos(950)}\\fs104\\c${YELLOW}&${scaleTag(k)}\\fad(100,0)}${esc(ch)}`);
  lines.push(`Dialogue: 2,${assTime(0.25)},${assTime(D)},Who,,0,0,0,,{${pos(1090)}\\fad(120,0)}for more top 5s`);
  return lines.join("\n") + "\n";
}

/** An entry: "#3 · @login" credit (where the layout puts it), its captions (where the layout puts them), the channel watermark. */
export function entryAss(o: { n: number; login: string; captions: { start: number; end: number; text: string }[]; len: number; place: OverlayPlace; watermark?: string | null; font?: string }) {
  const lines = header(fontOf(o.font));
  const P = o.place;
  const plain = `#${o.n}  @${o.login}`;
  const k = fitScale(plain, 46, TEXT_MAX_W, { outline: 5 });
  lines.push(`Dialogue: 3,${assTime(0)},${assTime(o.len)},Credit,,0,0,0,,{\\an${P.creditAlign}\\pos(${TEXT_X},${P.creditY})${scaleTag(k)}}{\\c${YELLOW}&}#${o.n}{\\c&H00FFFFFF&}  ${esc(`@${o.login}`)}`);
  for (const c of o.captions) {
    const t = esc(c.text).toUpperCase();
    if (t) lines.push(`Dialogue: 1,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,{${pos(P.capY)}${scaleTag(fitScale(t, 86, TEXT_MAX_W, { spacing: 1, outline: 7 }))}\\fad(50,0)}${t}`);
  }
  pushMark(lines, o.len, o.watermark, P);
  return lines.join("\n") + "\n";
}

function pushMark(lines: string[], D: number, name: string | null | undefined, place: OverlayPlace | null) {
  const mark = watermarkText(name);
  if (mark) lines.push(`Dialogue: 4,${assTime(0)},${assTime(D)},Mark,,0,0,0,,${watermarkPlace(place).tag}${mark}`);
}

/** Plain-English list for the report / Edits page. */
export function describeTop5(entries: { n: number; login: string; start: number; end: number; payoff: number; layout: string }[]) {
  return entries.map((e) => `#${e.n} @${e.login} ${e.start.toFixed(2)}-${e.end.toFixed(2)}s (${(e.end - e.start).toFixed(1)}s, payoff at +${(e.payoff - e.start).toFixed(1)}s, ${e.layout})`);
}

export { isGta6 };
