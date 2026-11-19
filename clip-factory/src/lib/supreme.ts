// v1.9.6 Supreme Judge: ONE claude-opus-5-5 request picks the best clips per channel (3x a day + "Pick now").
// Pure parts (summaries, the request, the safety net that enforces the rules again) are exported for tests.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { loadPromptFile } from "./prompt-file";
import { SUPREME_MODEL } from "./ai-spend";

export const SupremePicks = z.object({
  channels: z.array(z.object({
    channel_id: z.string(),
    picks: z.array(z.object({ clip_id: z.string(), reason: z.string().describe("One short plain sentence") })).describe("Best first"),
  })),
});
export type SupremeAnswer = z.infer<typeof SupremePicks>;

export type ClipSummary = {
  id: string; creator: string; creatorId: string; category: string | null; game: string | null; score: number | null; reason: string | null; hook: string | null;
  standout: number | null; ageHours: number; length: number | null; campaign: string | null; layout: string | null; style: string | null;
  status: string; autoChannelId: string | null; qa: "ok" | "issues" | "unchecked";
  /** v2.0.6: Clip.channelId is set (the Judge or Krew chose it): the clip may only be picked for that channel. */
  channelSet?: boolean;
};
export type ChannelContext = {
  id: string; name: string; focus: string; kinds: string; postsToday: number; want: number;
  creatorsToday: Record<string, number>; // creatorId → posts today on this channel
  performance: string[]; // "By creator: Kai Cenat 2.1x (4 posts)…" lines
};

const cut = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function renderSupremeInput(channels: ChannelContext[], clips: ClipSummary[]): string {
  const ch = channels.map((c) => [
    `- id=${c.id} name="${c.name}" focus=${c.focus} types=${c.kinds} posts_today=${c.postsToday} picks_wanted=${c.want}`,
    ...(Object.keys(c.creatorsToday).length ? [`  already posted today by creator: ${Object.entries(c.creatorsToday).map(([k, n]) => `${clips.find((x) => x.creatorId === k)?.creator ?? k} ${n}`).join(", ")}`] : []),
    ...(c.performance.length ? c.performance.map((l) => `  ${l}`) : ["  no settled posts in the last 14 days yet"]),
  ].join("\n"));
  const cl = clips.map((k) => [
    `- id=${k.id}`, `creator="${k.creator}"`, `type=${k.category ?? "?"}`, `game="${cut(k.game, 40) || "?"}"`, `score=${k.score ?? "unscored"}`,
    `standout=${k.standout != null ? `${Math.round(k.standout * 10) / 10}x` : "?"}`, `age=${Math.round(k.ageHours)}h`, `length=${k.length != null ? Math.round(k.length) : "?"}s`,
    `status=${k.status}`, `campaign=${k.campaign ? `"${cut(k.campaign, 40)}"` : "none"}`, `layout=${k.layout ?? "?"}/${k.style ?? "plain"}`,
    k.channelSet && k.autoChannelId ? `channel=${k.autoChannelId}(set)` : `auto_channel=${k.autoChannelId ?? "none"}`, `video_check=${k.qa}`, `hook="${cut(k.hook, 70)}"`, `judge="${cut(k.reason, 160)}"`,
  ].join(" "));
  return ["<channels>", ...ch, "</channels>", "", `<clips count="${clips.length}">`, ...cl, "</clips>", "",
    "For each channel, pick up to picks_wanted clips, best first, with a one-line reason each."].join("\n");
}

let SUPREME_SYSTEM: string | null = null;
export const supremeSystem = () => (SUPREME_SYSTEM ??= loadPromptFile("prompts/supreme.md"));

export async function askSupreme(text: string, client = new Anthropic()) {
  const res = await client.beta.messages.parse({
    model: SUPREME_MODEL,
    max_tokens: 16000,
    system: [{ type: "text", text: supremeSystem(), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: text }],
    output_config: { effort: "medium", format: zodOutputFormat(SupremePicks) },
    // A declined request is re-run on Anthropic's recommended fallback model (same as the per-clip Judge).
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  const refused = res.stop_reason === "refusal";
  return { refused, answer: refused ? null : res.parsed_output ?? null, usage: res.usage, model: (res as { model?: string }).model ?? SUPREME_MODEL };
}

export type FinalPick = { clipId: string; channelId: string; rank: number; reason: string };
export const MAX_PER_CREATOR_PER_DAY = 2;

/**
 * Safety net: the rules again, in code. Known channels + candidate clips only; a clip goes to one channel; at most
 * `perChannel` per channel; at most 2 of one creator per channel per day (today's posts count); never a clip whose video
 * check found problems; a clip must suit the channel (its auto channel, or a "gta"/kinds match is left to the model
 * unless the clip has no auto channel at all — then anything is allowed as Krew can still move it).
 */
export function enforcePicks(answer: SupremeAnswer | null, channels: ChannelContext[], clips: ClipSummary[], perChannel: number): { picks: FinalPick[]; dropped: string[] } {
  const picks: FinalPick[] = [], dropped: string[] = [];
  if (!answer) return { picks, dropped };
  const byId = new Map(clips.map((c) => [c.id, c]));
  const used = new Set<string>();
  for (const ch of answer.channels ?? []) {
    const c = channels.find((x) => x.id === ch.channel_id);
    if (!c) { dropped.push(`unknown channel ${ch.channel_id}`); continue; }
    const perCreator = { ...c.creatorsToday };
    let rank = 0;
    for (const p of ch.picks ?? []) {
      const k = byId.get(p.clip_id);
      if (!k) { dropped.push(`unknown clip ${p.clip_id}`); continue; }
      if (used.has(k.id)) { dropped.push(`${k.id}: already picked for another channel`); continue; }
      if (k.channelSet && k.autoChannelId && k.autoChannelId !== c.id) { dropped.push(`${k.id}: belongs to channel ${k.autoChannelId}`); continue; }
      if (k.qa === "issues") { dropped.push(`${k.id}: video check found problems`); continue; }
      if (rank >= Math.min(perChannel, c.want)) { dropped.push(`${k.id}: over ${c.name}'s limit`); continue; }
      if ((perCreator[k.creatorId] ?? 0) >= MAX_PER_CREATOR_PER_DAY) { dropped.push(`${k.id}: 3rd ${k.creator} clip for ${c.name} today`); continue; }
      perCreator[k.creatorId] = (perCreator[k.creatorId] ?? 0) + 1;
      used.add(k.id);
      picks.push({ clipId: k.id, channelId: c.id, rank: ++rank, reason: cut(p.reason, 200) || "Supreme pick" });
    }
  }
  return { picks, dropped };
}
