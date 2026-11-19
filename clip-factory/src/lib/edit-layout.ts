// v2.0.0 Edits: the v1.9 layout (full cam / cam + game / blur) for each moment of an edit, and where the face ends up.
import { parseFacecam } from "./media";
import { detectCam } from "./camdetect";
import { probeSize } from "./edit";
import { chooseLayout, faceInOutput, parseCamInfo, planLayout, type CamInfo, type LayoutPlan } from "./layout";
import type { Focus } from "./edit-plan";

/**
 * Auto layout per moment: a typed / remembered webcam box skips the face check (split), else the clip's cached detection
 * (box positions are fractions of the frame, so they hold for a re-downloaded section of the same video) or a fresh check
 * on 6s around the payoff. The Funny vibe and clip -> edits count the moment as funny (big cams go full screen).
 */
export async function editLayout(o: {
  file: string; payoff: number; dur: number; camInfo: string | null; category: string | null; funny: boolean;
  streamer: { facecam: string | null; facecamAuto: string | null };
}): Promise<{ layout: LayoutPlan; focus: Focus | null; why: string; det: CamInfo | null }> {
  const manual = parseFacecam(o.streamer.facecam), remembered = parseFacecam(o.streamer.facecamAuto);
  const cached = parseCamInfo(o.camInfo);
  let det: CamInfo | null = cached && !cached.error && cached.found ? cached : null;
  if (!det && !manual && !remembered) {
    const start = Math.max(0, Math.min(o.payoff - 3, o.dur - 6));
    det = await detectCam(o.file, start, Math.min(6, o.dur));
  }
  const category = o.funny ? "funny" : o.category;
  const choice = chooseLayout({ mode: "auto", det, category, manual, remembered });
  const src = await probeSize(o.file).catch(() => ({ w: 1920, h: 1080 }));
  const layout = planLayout({ choice, det, src, category });
  const face = faceInOutput({ layout: layout.kind, src, det, cam: choice.cam, crop: layout.kind === "fullcam" ? layout.crop : null });
  const focus = face && layout.kind !== "blur" ? { x: Math.round(face.x + face.w / 2), y: Math.round(face.y + face.h / 2) } : null;
  return { layout, focus, why: choice.why, det };
}
