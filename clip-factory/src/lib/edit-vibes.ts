// v2.0.0 Edits: the choices the UI shows. No Node imports here: client components read this file too.

export type Vibe = "hype" | "funny" | "smooth";
export const VIBES: { key: Vibe; label: string; hint: string }[] = [
  { key: "hype", label: "Hype", hint: "Hard cuts on the beat, a flash and one zoom on the drop, slow-mo into the hit." },
  { key: "funny", label: "Funny", hint: "Longer slices around the laughs, a freeze-frame on the punchline, little flashing." },
  { key: "smooth", label: "Smooth", hint: "Crossfades and whip-pans, a softer look, few effects." },
];
export const parseVibe = (s: unknown): Vibe => (s === "funny" || s === "smooth" || s === "hype" ? s : "hype");
export const vibeLabel = (s: string | null | undefined) => VIBES.find((v) => v.key === s)?.label ?? "Hype";

// v2.0.5: the "Top 5" countdown compilation is the default (Krew: "top 5 funniest parts... a montage of multiple clips").
export type EditFormat = "top5" | "montage" | "clipedit";
export const FORMATS: { key: EditFormat; label: string; hint: string }[] = [
  { key: "top5", label: "Top 5", hint: "Countdown of the 5 best moments (#5 to #1), each its own tight cut with its sound and captions, a number card between them." },
  { key: "montage", label: "Montage", hint: "5-12 of one creator's best moments cut on the beat." },
  { key: "clipedit", label: "Clip → Edit", hint: "One moment plays normally with captions, then the drop hits on the payoff and it turns into an edit." },
];
export const DEFAULT_FORMAT: EditFormat = "top5";
/** Stored rows: null / unknown = "montage" (every edit before v2.0.5 was one). */
export const parseFormat = (s: unknown): EditFormat => (s === "clipedit" || s === "top5" ? s : "montage");

// v2.0.5 Top 5 themes (what the 5 moments are picked from).
export type Top5Theme = "funny" | "gaming" | "gta" | "creator";
export const TOP5_THEMES: { key: Top5Theme; label: string; hint: string }[] = [
  { key: "funny", label: "Top 5 funniest", hint: "The funniest moments of all your creators." },
  { key: "gaming", label: "Top 5 craziest plays", hint: "The biggest gaming moments." },
  { key: "gta", label: "Top 5 GTA 6 moments", hint: "The best GTA 6 moments, funny or not." },
  { key: "creator", label: "One creator's top 5", hint: "The 5 best moments of one creator (like Kai Cenat's top 5)." },
];
export const parseTheme = (s: unknown): Top5Theme => (s === "gaming" || s === "gta" || s === "creator" ? s : "funny");
export const themeLabel = (s: string | null | undefined) => TOP5_THEMES.find((t) => t.key === s)?.label ?? "Top 5";
/** A Top 5 needs this many different moments. */
export const TOP5_COUNT = 5;
export const formatLabel = (s: string | null | undefined) => FORMATS.find((f) => f.key === s)?.label ?? "Montage";

export const EDIT_LENGTHS = [15, 20, 30] as const;
export const parseLength = (s: unknown): number => {
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? Math.max(12, Math.min(30, n)) : 20;
};
export const parseBpm = (s: unknown): number => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(Math.max(70, Math.min(180, n)) * 10) / 10 : 128;
};

/** A montage needs this many usable moments (fewer = the "Make edit" button is off); the daily auto edit needs more. */
export const MIN_MOMENTS = 5;
export const AUTO_MIN_MOMENTS = 8;

export const MUSIC_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;

export const STAGE_LABEL: Record<string, string> = {
  picking: "Picking moments", cutting: "Cutting the moments", downloading: "Downloading", beats: "Finding the beat", rendering: "Rendering", post: "Sending",
};
