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
