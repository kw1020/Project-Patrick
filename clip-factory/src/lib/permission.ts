// Permission evidence: does a streamer's own Twitch bio or stream title (or a YouTube channel's own description)
// say clips / reposts are allowed?
// Pure functions, no I/O. Used by the Suggestions scanner. This never approves anyone: it only finds a quote
// Krew can check (and use as his approval reason) before he approves.

export type PermissionHit = {
  /** The matched phrase, as written (e.g. "Clips welcome"). */
  match: string;
  /** The match with a little surrounding context from the same line, at most 160 chars. */
  snippet: string;
};
export type PermissionEvidence = PermissionHit & { source: "bio" | "title" | "description" };

const MAX_SNIPPET = 160;
const CONTEXT = 50;

// Phrases that show clipping / reposting is allowed, or that a clipping program exists.
const POSITIVE: RegExp[] = [
  /\bclip(?:s|ping)?\s+(?:are\s+|is\s+)?(?:always\s+|very\s+|totally\s+|more\s+than\s+)?(?:welcome|allowed|encouraged|okay|ok|fine|appreciated)\b/i,
  /\bfeel\s+free\s+to\s+(?:clip|repost|re-?upload)\w*/i,
  /\bclippers?\s+(?:are\s+)?(?:always\s+|very\s+)?(?:welcome|wanted|needed|allowed|encouraged)\b/i,
  /\bclip(?:ping)?\s+(?:campaign|program|programme|contest|competition)s?\b/i,
  // YouTube descriptions: "clippers program", "you can clip my videos", "clip my videos and post them".
  /\bclippers?\s+(?:campaign|program|programme)s?\b/i,
  /\b(?:you\s+can|you\s+may|anyone\s+can|free\s+to|allowed\s+to|welcome\s+to|go\s+ahead\s+and)\s+clip\s+(?:my|our)\s+(?:videos?|content|streams?|vods?)\b/i,
  /\bclip\s+(?:my|our)\s+(?:videos?|content|streams?)\s+(?:and|&)\s+(?:post|upload|repost|earn|get\s+paid)\w*/i,
  /\brepost(?:s|ing)?\s+(?:are\s+|is\s+)?(?:always\s+)?(?:allowed|welcome|encouraged|okay|ok|fine)\b/i,
  /\bcontent\s+rewards\b/i,
  /\bwhop\.com\/[^\s)\]]{0,60}/i,
];

// Phrases that say the opposite. Any of these anywhere in the same text cancels every positive in it
// (better to miss a real permission than to quote a fake one).
const NEGATIVE: RegExp[] = [
  /\b(?:no|not|never|don'?t|dont|do\s+not|please\s+don'?t|without|can'?t|cannot|may\s+not|must\s+not)\s+(?:any\s+|more\s+|my\s+)?(?:clip|clips|clipping|clippers?|repost|reposts|reposting|re-?uploads?|re-?uploading)\b/i,
  /\b(?:clip|clips|clipping|clippers?|repost|reposts|reposting|re-?uploads?)\s+(?:are\s+|is\s+)?(?:not|never|aren'?t|isn'?t)\b/i,
  /\b(?:clip|clips|clipping|clippers?|repost|reposts|reposting|re-?uploads?)\s+(?:are\s+|is\s+)?(?:prohibited|forbidden|banned|disallowed|not\s+allowed)\b/i,
  /\b(?:aren'?t|isn'?t|not)\s+(?:allowed|permitted)\s+to\s+(?:clip|repost|re-?upload)/i,
  /\b(?:don'?t|do\s+not|never)\s+(?:have|run|do)\s+(?:a\s+|any\s+)?(?:clip|clipping)/i,
];

function normalize(text: string) {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

/** Cut `line` to ≤160 chars around [start, end), on word boundaries where possible. */
function snippetAround(line: string, start: number, end: number): string {
  let a = Math.max(0, start - CONTEXT), b = Math.min(line.length, end + CONTEXT);
  if (a > 0) { const sp = line.indexOf(" ", a); if (sp !== -1 && sp < start) a = sp + 1; }
  if (b < line.length) { const sp = line.lastIndexOf(" ", b); if (sp > end) b = sp; }
  let s = line.slice(a, b).trim();
  if (s.length > MAX_SNIPPET) s = line.slice(start, end).slice(0, MAX_SNIPPET).trim();
  return s;
}

/** True when the text says clips / reposts are NOT allowed ("no clips", "don't clip", "clips not allowed"…). */
export function saysNo(text: string | null | undefined): boolean {
  return Boolean(text) && NEGATIVE.some((re) => re.test(normalize(text!)));
}

/** The first permission phrase in `text`, or null (also null when the text says "no clips" etc.). */
export function findPermission(text: string | null | undefined): PermissionHit | null {
  if (!text) return null;
  const clean = normalize(text);
  if (saysNo(clean)) return null;
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    let best: RegExpExecArray | null = null;
    for (const re of POSITIVE) {
      const m = re.exec(line);
      if (m && (!best || m.index < best.index)) best = m;
    }
    if (best) {
      const match = best[0].slice(0, MAX_SNIPPET);
      return { match, snippet: snippetAround(line, best.index, best.index + best[0].length) };
    }
  }
  return null;
}

/** Look in the Twitch bio first, then the current stream title. A "no" in either cancels both. */
export function findPermissionEvidence(bio: string | null | undefined, title: string | null | undefined): PermissionEvidence | null {
  if (saysNo(bio) || saysNo(title)) return null; // a "no clips" anywhere wins
  const b = findPermission(bio);
  if (b) return { ...b, source: "bio" };
  const t = findPermission(title);
  if (t) return { ...t, source: "title" };
  return null;
}

/** YouTube: only the channel's own description counts (video titles are not the creator's permission). */
export function findDescriptionEvidence(description: string | null | undefined): PermissionEvidence | null {
  const d = findPermission(description); // already null when the description says "no clips" anywhere
  return d ? { ...d, source: "description" } : null;
}

/** The approval reason Krew sees pre-filled. Only ever built from a real quote. */
export function approvalReasonFromEvidence(ev: { evidence: string | null; evidenceSource: string | null }): string {
  if (!ev.evidence) return "";
  const who = ev.evidenceSource === "title" ? "Stream title says" : ev.evidenceSource === "description" ? "Channel description says" : "Bio says";
  return `${who}: "${ev.evidence}"`;
}
