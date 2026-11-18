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
