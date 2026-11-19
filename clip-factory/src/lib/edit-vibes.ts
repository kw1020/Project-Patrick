// v2.0.0 Edits: the choices the UI shows. No Node imports here: client components read this file too.

export type Vibe = "hype" | "funny" | "smooth";
export const VIBES: { key: Vibe; label: string; hint: string }[] = [
  { key: "hype", label: "Hype", hint: "Hard cuts, flashes, zoom pulses, shakes and an RGB split on the drop, slow-mo into the hit." },
  { key: "funny", label: "Funny", hint: "Longer slices around the laughs, zoom on faces, freeze-frame on the punchline, less flashing." },
  { key: "smooth", label: "Smooth", hint: "Crossfades and whip-pans, gentle zoom drift, a softer look, few effects." },
];
export const parseVibe = (s: unknown): Vibe => (s === "funny" || s === "smooth" || s === "hype" ? s : "hype");
export const vibeLabel = (s: string | null | undefined) => VIBES.find((v) => v.key === s)?.label ?? "Hype";

export type EditFormat = "montage" | "clipedit";
export const FORMATS: { key: EditFormat; label: string; hint: string }[] = [
  { key: "montage", label: "Montage", hint: "5-12 of the creator's best moments cut on the beat." },
  { key: "clipedit", label: "Clip → Edit", hint: "One moment plays normally with captions, then the drop hits on the payoff and it turns into an edit." },
];
export const parseFormat = (s: unknown): EditFormat => (s === "clipedit" ? "clipedit" : "montage");
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
  picking: "Picking moments", downloading: "Downloading", beats: "Finding the beat", rendering: "Rendering", post: "Sending",
};
