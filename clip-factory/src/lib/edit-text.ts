// v2.0.0 Edits: title + caption, in the v1.9.1 ViceCityClips caption format (src/lib/social.ts brandedCaption):
//   <hook>
//
//   🎥 @<login>
//
//   #GTA6 #GTAVI #ViceCity <extras> #edit
// The credit + brand hashtags come from brandedCaption, so they can never be dropped; a creator's campaign rules apply too.
import { brandedCaption, captionCredits, creditLine, type CampaignRules, type Creator } from "./social";
import type { EditFormat, Vibe } from "./edit-vibes";
import { KEEP_HASHTAGS } from "./platform-rules";

export function editTitle(creator: Creator, vibe: Vibe, format: EditFormat, clipTitle?: string | null) {
  if (format === "clipedit" && clipTitle && clipTitle.trim().length > 3) return clipTitle.trim().slice(0, 90);
  return `${creator.name} ${vibe === "funny" ? "funniest moments" : "edit"}`.slice(0, 90);
}

/** brandedCaption + "#edit" on the hashtag line (unless a campaign's max length has no room for it). */
export function editCaption(title: string, creator: Creator, o: { vibe?: Vibe; campaign?: CampaignRules | null; game?: string | null } = {}) {
  // one extra + #edit keeps it at 5 hashtags (v1.9.8 Platform check: Instagram won't post more than 5)
  const extras = o.vibe === "funny" ? ["GTA6Funny"] : ["StreamerMoments"];
  const cap = brandedCaption({ hook: title, streamer: creator, extras, campaign: o.campaign ?? null, category: o.vibe === "funny" ? "funny" : null, game: o.game ?? null });
  const lines = cap.split("\n");
  const i = lines.findIndex((l) => /^#\S/.test(l));
  if (i < 0 || /(^|\s)#edit(\s|$)/i.test(lines[i])) return cap;
  if ((cap.match(/#[\p{L}\p{N}_]+/gu) ?? []).length >= KEEP_HASHTAGS) return cap; // a campaign's required tags already fill it
  lines[i] += " #edit";
  const out = lines.join("\n");
  const max = o.campaign && o.campaign.active !== false && o.campaign.maxCaptionChars ? o.campaign.maxCaptionChars : null;
  return max && [...out].length > max ? cap : out;
}

/** The caption with the credit put back if Krew edited it out (the @login or the channel link both count). */
export function ensureCredit(caption: string, creator: Creator) {
  return captionCredits(caption, creator) ? caption : `${caption}\n\n${creditLine(creator)}`;
}
