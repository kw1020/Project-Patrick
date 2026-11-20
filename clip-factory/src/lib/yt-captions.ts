// v2.0.8 captions route (YouTube scout): find moments in a normal YouTube video from its auto-captions, for videos that have
// no "most replayed" heatmap yet (every new upload). Pure: parseVtt + captionPeaks. The yt-dlp call is videoCaptions in ytdlp.ts.
//
// YouTube auto-captions (VTT) roll: each cue shows the previous line again plus the new one, with inline word times
// (<00:00:03.199><c> word</c>), and a 10ms cue in between repeats the finished line. parseVtt keeps each line once, at the
// time it first appears (word times when present).
//
// Signals (weights in SIGNALS): sound tags [Laughter] [Screaming] [Applause] [Music], reaction phrases ("oh my god", "no way",
// "bro", "let's go"...), ALL-CAPS lines (YouTube writes shouting in capitals), and short exclamations piling up. A moment is the
// best 10s window (score >= CAPTION_MIN_SCORE), centred on its strongest signal; peaks are >= 45s apart, never in the first 20s,
// the last 20s, the outro ("thanks for watching") or a sponsor read ("sponsored", "use code", "link in the description").

export type CaptionLine = { start: number; end: number; text: string };

const ts = (s: string) => {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
};

const clean = (s: string) => s
  .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, " ")
  .replace(/<\/?[a-z][^>]*>/gi, "")
  .replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, "\"").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/**
 * The VTT's lines, each once, in time order. YouTube's rolling cues: a cue shorter than 50ms only repeats the finished line
 * (skipped), and a cue's first line that equals the last line kept is the carried-over line (skipped). A line said twice in a
 * row ("[Music]", "[Music]") is kept twice. Cues are separated by truly empty lines (YouTube's " " lines are part of a cue).
 */
export function parseVtt(vtt: string): CaptionLine[] {
  const blocks = vtt.replace(/\r/g, "").split(/\n{2,}/);
  const out: CaptionLine[] = [];
  for (const b of blocks) {
    const rows = b.split("\n");
    const i = rows.findIndex((r) => r.includes("-->"));
    if (i < 0) continue;
    const [a, z] = rows[i].split("-->");
    const start = ts(a), end = ts((z ?? "").trim().split(/\s+/)[0] ?? "");
    if (start == null || end == null || end - start < 0.05) continue;
    const texts = rows.slice(i + 1).map(clean).filter(Boolean);
    if (texts.length > 1 && out.length && texts[0] === out[out.length - 1].text) texts.shift();
    for (const text of texts) out.push({ start, end, text });
  }
  // A line's end = the next line's start (cues overlap while rolling).
  for (let k = 0; k < out.length - 1; k++) out[k].end = Math.max(out[k].start, out[k + 1].start);
  return out;
}

export const SIGNALS = {
  laughter: 3, screaming: 3, applause: 2, music: 0.75, cheering: 2, gasps: 2,
  phrase: 1.5,   // a reaction phrase
  shout: 2,      // an ALL-CAPS line
  short: 0.75,   // a short exclamation line ("oh!", "no no no", "what?!")
} as const;

const TAGS: [RegExp, keyof typeof SIGNALS, string][] = [
  [/\[(?:laughter|laughs|laughing|chuckles)\]/gi, "laughter", "[laughter]"],
  [/\[(?:screaming|screams|yelling|shouting)\]/gi, "screaming", "[screaming]"],
  [/\[(?:applause|clapping)\]/gi, "applause", "[applause]"],
  [/\[(?:cheering|cheers)\]/gi, "cheering", "[cheering]"],
  [/\[(?:gasps?|gasping)\]/gi, "gasps", "[gasps]"],
  [/\[music\]/gi, "music", "[music]"],
];
export const REACTION_PHRASES = [
  "oh my god", "oh my gosh", "omg", "no way", "bro", "let's go", "lets go", "what the", "wtf", "holy", "oh no", "no no no", "yo",
  "dude", "wait what", "are you serious", "are you kidding", "i can't", "insane", "crazy", "let's goo",
];
const PHRASE_RE = new RegExp(`(?<![a-z'])(?:${REACTION_PHRASES.map((p) => p.replace(/'/g, "'?").replace(/ /g, "\\s+")).join("|")})(?![a-z])`, "gi");
const EXCLAIM_RE = /^(?:oh+|ah+|no+|what\??|yo+|wow|ayo|bro+|dude|yes+|go+|huh|wait|stop|nah|bruh|let's go+|oh no|no no+|what what)(?:[\s,!?.]+(?:oh+|ah+|no+|what\??|yo+|wow|bro+|yes+|go+|huh|wait|stop|nah|bruh|dude))*[!?.\s]*$/i;
/** Outro and sponsor reads: never a moment here. */
const SPONSOR_RE = /\b(?:sponsor(?:ed)?|use (?:my )?code|promo code|link in (?:the )?description|links? (?:are )?(?:down )?below|brought to you by|today's video is|check out \w+ (?:at|below)|sign up (?:at|with|using))\b/i;
const OUTRO_RE = /\b(?:thanks? (?:you )?(?:so much )?for watching|see you (?:guys )?(?:in the )?next|don't forget to (?:like|subscribe)|smash (?:that|the) (?:like|subscribe)|hit (?:that|the) subscribe|peace out)\b/i;

export type CaptionSignal = { at: number; weight: number; label: string };

/** Every signal in the captions (time = the line's start). Pure. */
export function captionSignals(lines: CaptionLine[]): CaptionSignal[] {
  const out: CaptionSignal[] = [];
  for (const l of lines) {
    let tagged = false;
    for (const [re, k, label] of TAGS) {
      const n = (l.text.match(re) ?? []).length;
      for (let i = 0; i < n; i++) out.push({ at: l.start, weight: SIGNALS[k], label });
      if (n && k !== "music") tagged = true;
    }
    const words = l.text.replace(/\[[^\]]*\]/g, " ").trim();
    if (!words) continue;
    const phrases = (words.match(PHRASE_RE) ?? []).length;
    for (let i = 0; i < Math.min(phrases, 3); i++) out.push({ at: l.start, weight: SIGNALS.phrase, label: "reaction words" });
    const letters = words.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 4 && letters === letters.toUpperCase() && /[A-Z]{2,}/.test(words) && words.split(/\s+/).length >= 2) out.push({ at: l.start, weight: SIGNALS.shout, label: "shouting (ALL CAPS)" });
    else if (!tagged && EXCLAIM_RE.test(words)) out.push({ at: l.start, weight: SIGNALS.short, label: "short exclamations" });
  }
  return out;
}

/** Stretches where no moment may be: sponsor reads (10s before to 45s after the line) and the outro (from its line to the end). */
export function skipZones(lines: CaptionLine[], duration: number): [number, number][] {
  const z: [number, number][] = [];
  for (const l of lines) {
    if (SPONSOR_RE.test(l.text)) z.push([l.start - 10, l.start + 45]);
    if (OUTRO_RE.test(l.text) && l.start >= duration * 0.75) z.push([l.start - 5, duration + 1]);
  }
  return z;
}

export type CaptionPeak = { center: number; value: number; score: number; snippet: string; signals: string[] };

export const CAPTION_MIN_SCORE = 4.5; // e.g. [laughter] + a reaction phrase, or a shouted line + 2 reaction phrases
const WINDOW = 10;                    // seconds a moment's signals are summed over

/**
 * The best moments in a video's captions. `value` = score / 20 capped at 1 (same 0-1 scale as the heatmap's replay value,
 * so the Judge queue order treats both alike). Pure.
 */
export function captionPeaks(lines: CaptionLine[], duration: number | null, n: number, opts: { minGap?: number; head?: number; tail?: number; minScore?: number } = {}): CaptionPeak[] {
  const { minGap = 45, head = 20, tail = 20, minScore = CAPTION_MIN_SCORE } = opts;
  if (!lines.length || n <= 0) return [];
  const end = duration ?? lines[lines.length - 1].end;
  const zones = skipZones(lines, end);
  const blocked = (t: number) => t < head || t > end - tail || zones.some(([a, b]) => t >= a && t <= b);
  const sig = captionSignals(lines).filter((s) => !blocked(s.at));
  // Music alone is not a moment (intros, background beds): a window needs at least one non-music signal.
  const cands: CaptionPeak[] = [];
  for (const s of sig) {
    const inWin = sig.filter((x) => x.at >= s.at - WINDOW / 2 && x.at <= s.at + WINDOW / 2);
    if (!inWin.some((x) => x.label !== "[music]")) continue;
    const score = inWin.reduce((a, x) => a + x.weight, 0);
    if (score < minScore) continue;
    // The centre: the strongest signal in the window (earliest of the strongest), i.e. the reaction itself.
    const best = inWin.reduce((b, x) => (x.weight > b.weight || (x.weight === b.weight && x.at < b.at) ? x : b));
    const counts = new Map<string, number>();
    for (const x of inWin) counts.set(x.label, (counts.get(x.label) ?? 0) + 1);
    const signals = [...counts].sort((a, b) => b[1] - a[1]).map(([k, c]) => (c > 1 ? `${k} x${c}` : k));
    cands.push({ center: Math.round(best.at), value: Math.min(1, Math.round((score / 20) * 1000) / 1000), score: Math.round(score * 100) / 100, snippet: snippetAt(lines, best.at), signals });
  }
  cands.sort((a, b) => b.score - a.score || a.center - b.center);
  const out: CaptionPeak[] = [];
  for (const c of cands) {
    if (out.length >= n) break;
    if (out.every((q) => Math.abs(q.center - c.center) >= minGap)) out.push(c);
  }
  return out;
}

/** What was said around a moment (12s before to 6s after), for the Judge. <= 300 chars. */
export function snippetAt(lines: CaptionLine[], at: number): string {
  const text = lines.filter((l) => l.start >= at - 12 && l.start <= at + 6).map((l) => l.text).join(" / ");
  return text.length > 300 ? text.slice(0, 299) + "…" : text;
}
