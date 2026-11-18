// v1.9.1 Campaign mode (Whop Content Rewards) + branding: pure form parsing, no Node imports (pages and actions use it).

export const DEFAULT_CHANNEL = "ViceCityClips";

/** Settings "Channel name": letters, digits, _ and . only (it becomes "@name"), max 30; empty → ViceCityClips. */
export function parseChannelName(v: unknown) {
  const t = String(v ?? "").trim().replace(/^@+/, "").replace(/[^\p{L}\p{N}_.]/gu, "").slice(0, 30);
  return t || DEFAULT_CHANNEL;
}

export type CampaignData = {
  name: string; link: string | null; rules: string | null; requiredText: string | null; bannedWords: string | null;
  maxCaptionChars: number | null; active: boolean;
};

const text = (v: unknown, max: number) => {
  const t = String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
  return t || null;
};

/** The Campaigns card form. Missing name → "Campaign". Max length 20-5000 or empty (= no limit). */
export function parseCampaignForm(form: FormData): CampaignData {
  const max = Number(String(form.get("maxCaptionChars") ?? "").replace(/[^0-9]/g, ""));
  const link = text(form.get("link"), 500);
  return {
    name: text(form.get("name"), 80) ?? "Campaign",
    link: link && !/^https?:\/\//i.test(link) ? `https://${link}` : link,
    rules: text(form.get("rules"), 4000),
    requiredText: text(form.get("requiredText"), 1000),
    bannedWords: text(form.get("bannedWords"), 1000),
    maxCaptionChars: Number.isFinite(max) && max > 0 ? Math.min(5000, Math.max(20, Math.round(max))) : null,
    active: form.get("active") === "on",
  };
}

/** A pasted link: trimmed, https:// added when missing, null when empty. */
export function parseLink(v: unknown) {
  const t = String(v ?? "").trim().slice(0, 500);
  if (!t) return null;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}
