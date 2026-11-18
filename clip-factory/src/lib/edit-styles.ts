// Editing styles (v1.7.3). No Node imports here: the Queue's client components read this list too.

export type EditStyle = "hype" | "clean" | "meme";

export const EDIT_STYLES: { key: EditStyle; label: string; hint: string }[] = [
  { key: "hype", label: "Hype", hint: "Yellow word-by-word captions, jump cuts, zoom punches, whoosh + boom, pink progress bar." },
  { key: "clean", label: "Clean", hint: "White captions, jump cuts, gentle fade-in hook. No zooms or sound effects." },
  { key: "meme", label: "Meme", hint: "Big tilted green captions, harder zooms, yellow hook, sound effects. Loud and silly." },
];

export const DEFAULT_EDIT_STYLE: EditStyle = "hype";

export function parseEditStyle(s: unknown): EditStyle {
  return s === "clean" || s === "meme" || s === "hype" ? s : DEFAULT_EDIT_STYLE;
}

export function editStyleLabel(s: string | null | undefined) {
  return EDIT_STYLES.find((x) => x.key === s)?.label ?? null;
}

// v1.8.0 jump cuts: only real silence is cut. light = rare and gentle (default), normal = a bit more, off = never.
export type JumpCutMode = "off" | "light" | "normal";
export const JUMP_CUT_MODES: { key: JumpCutMode; label: string; hint: string }[] = [
  { key: "light", label: "Light", hint: "Only cuts long, truly silent pauses (1.2s+), at most 4 per clip." },
  { key: "normal", label: "Normal", hint: "Cuts silent pauses of 0.8s+, up to a quarter of the clip." },
  { key: "off", label: "Off", hint: "Never cuts inside the clip." },
];
export function parseJumpCuts(s: unknown): JumpCutMode {
  return s === "off" || s === "normal" || s === "light" ? s : "light";
}

// v1.9.0 layouts. "facecam" is the pre-1.9 name of "split" (old Settings rows keep working).
export type LayoutKind = "split" | "fullcam" | "blur";
export type LayoutSetting = "auto" | LayoutKind;
export const LAYOUTS: { key: LayoutSetting; label: string; short: string; hint: string }[] = [
  { key: "auto", label: "Auto (recommended)", short: "Auto", hint: "Finds the streamer's face in each clip and picks the best layout below." },
  { key: "split", label: "Cam on top + game below", short: "Cam + game", hint: "The webcam fills the top third, the game sits underneath. The webcam spot is found automatically." },
  { key: "fullcam", label: "Full streamer cam", short: "Full cam", hint: "The whole screen is the streamer's face. Best for funny moments and Just Chatting." },
  { key: "blur", label: "Blurred background", short: "Blur", hint: "The whole frame in the middle with a blurred copy behind it. Works for everything." },
];
export const DEFAULT_LAYOUT: LayoutSetting = "auto";
export function parseLayoutSetting(s: unknown): LayoutSetting {
  if (s === "facecam") return "split";
  return s === "split" || s === "fullcam" || s === "blur" || s === "auto" ? s : DEFAULT_LAYOUT;
}
/** Short chip text for a clip's layout (null = unknown / older clip). */
export function layoutChip(s: string | null | undefined): string | null {
  return s === "split" || s === "facecam" ? "Cam + game" : s === "fullcam" ? "Full cam" : s === "blur" ? "Blur" : null;
}
