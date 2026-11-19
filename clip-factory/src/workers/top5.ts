// v2.0.5 Top 5 worker (runs inside the v2.0.0 "edit" queue: runEdit hands format "top5" here).
// picking (done when the edit is made, so the Edits page can say "only 3 funny moments" right away) -> downloading -> cutting
// -> rendering -> pending (Krew reviews). Never posts; never adds music. Each entry keeps its own sound + captions.
import fs from "node:fs";
import path from "node:path";
import { getSettings, prisma } from "../lib/db";
import { hasAudio } from "../lib/media";
import { probeSize } from "../lib/edit";
import { storageDir, storagePath } from "../lib/paths";
import { enqueueEdit } from "../lib/queues";
import { freeGb, minFreeGb } from "../lib/guards";
import { channelForClip } from "../lib/channels";
import { parseLayoutSetting, type LayoutSetting } from "../lib/layout";
import { probeFinal, renderFacts } from "../lib/platform-file";
import { watermarkText } from "../lib/layout";
import { editLayout } from "../lib/edit-layout";
import { TOP5_COUNT, parseTheme, type Top5Theme } from "../lib/edit-vibes";
import {
  countdown, describeTop5, entryCaptions, entryWindow, fitTotal, isGtaMoment, pickTop5, top5Caption, top5Titles,
  LOOKBACK_WIDE_DAYS, type Top5Cand, type Top5Ranked,
} from "../lib/top5";
import { renderTop5, type Top5RenderEntry } from "../lib/top5-render";
import { clipWords, getSource, toCandidates, type EditSource } from "./edit";

const r3 = (t: number) => Math.round(t * 1000) / 1000;

/** Every approved creator's moments of the last 30 days as Top 5 candidates (newest clip of each moment). */
export async function loadTop5Cands(now = new Date(), momentIds?: string[]): Promise<Top5Cand[]> {
  const rows = await prisma.moment.findMany({
    where: momentIds ? { id: { in: momentIds } } : { createdAt: { gte: new Date(now.getTime() - LOOKBACK_WIDE_DAYS * 86_400_000) }, streamer: { approved: true } },
    orderBy: { createdAt: "desc" }, take: momentIds ? undefined : 1500,
    include: { streamer: true, clips: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const base = toCandidates(rows);
  return rows.map((m, i) => {
    const c = m.clips[0];
    return {
      ...base[i], streamerId: m.streamerId, login: m.streamer.login, name: m.streamer.name, platform: m.streamer.platform, approved: m.streamer.approved && !m.streamer.paused,
      gameName: m.gameName, spikeScore: m.spikeScore, judgePayoff: c?.judgePayoff ?? null, winStart: c?.winStart ?? null, winLength: c?.winLength ?? c?.duration ?? null,
    };
  });
}

/** Edits page: how many different moments each theme could use right now (dedupe + per-creator cap applied, max 25). */
export async function top5ThemeCounts(now = new Date()): Promise<Record<string, number>> {
  const cands = await loadTop5Cands(now);
  const out: Record<string, number> = {};
  for (const theme of ["funny", "gaming", "gta"] as const) {
    const r = pickTop5(cands, { theme, now, want: TOP5_COUNT, spares: 20 });
    out[theme] = r.picks.length + r.spares.length;
  }
  return out;
}

type Top5State ={ theme: Top5Theme; creatorId: string | null; picks: string[]; spares: string[] };
const readState = (slices: string | null): Top5State | null => {
  try { const j = JSON.parse(slices ?? "{}").top5; return j && Array.isArray(j.picks) ? j : null; } catch { return null; }
};

/** Moments used in the last 3 Top 5s of this theme (a new one / Re-make picks others first). */
async function recentTop5Moments(theme: Top5Theme, creatorId: string | null): Promise<string[]> {
  const prev = await prisma.edit.findMany({ where: { format: "top5", theme, ...(theme === "creator" && creatorId ? { streamerId: creatorId } : {}) }, orderBy: { createdAt: "desc" }, take: 3, select: { slices: true } });
  return prev.flatMap((p) => readState(p.slices)?.picks ?? []);
}

export type NewTop5 = { theme: Top5Theme; creatorId?: string | null };

/** Pick the 5 moments and queue the edit. Throws a readable error when there aren't 5. */
export async function createTop5Edit(o: NewTop5) {
  const theme = parseTheme(o.theme);
  const creatorId = theme === "creator" ? o.creatorId ?? null : null;
  if (theme === "creator") {
    const s = creatorId ? await prisma.streamer.findUnique({ where: { id: creatorId } }) : null;
    if (!s || !s.approved) throw new Error("Pick an approved creator.");
  }
  const cands = await loadTop5Cands();
  const { picks, spares, enough } = pickTop5(cands, { theme, creatorId, avoid: await recentTop5Moments(theme, creatorId) });
  if (!enough) {
    const what = theme === "creator" ? `${cands.find((c) => c.streamerId === creatorId)?.name ?? "That creator"} has` : "There are";
    const kind = theme === "funny" ? "funny " : theme === "gaming" ? "gaming " : theme === "gta" ? "GTA 6 " : "";
    throw new Error(`${what} only ${picks.length} different ${kind}moment${picks.length === 1 ? "" : "s"} with a video (a Top 5 needs ${TOP5_COUNT}${theme === "creator" ? "" : ", at most 2 per creator"}). Approve more clips first.`);
  }
  const state: Top5State = { theme, creatorId, picks: picks.map((p) => p.momentId), spares: spares.map((p) => p.momentId) };
  const e = await prisma.edit.create({
    data: {
      streamerId: creatorId ?? picks[0].streamerId, format: "top5", theme, vibe: theme === "funny" ? "funny" : "hype", lengthSec: 50, bpm: 0,
      creatorAudio: true, captions: true, slices: JSON.stringify({ top5: state }),
      creators: JSON.stringify(creatorsOf(picks)), status: "processing", stage: "picking", stageAt: new Date(),
    },
  });
  await enqueueEdit(e.id);
  return e;
}

const creatorsOf = (cs: Pick<Top5Cand, "streamerId" | "login" | "name" | "platform">[]) =>
  cs.filter((c, i) => cs.findIndex((x) => x.streamerId === c.streamerId) === i).map((c) => ({ id: c.streamerId, login: c.login, name: c.name, platform: c.platform }));

async function setStage(id: string, stage: string) {
  await prisma.edit.update({ where: { id }, data: { stage, stageAt: new Date() } });
}

export async function runTop5(editId: string): Promise<string> {
  const edit = await prisma.edit.findUniqueOrThrow({ where: { id: editId }, include: { streamer: { include: { campaign: true } } } });
  const state = readState(edit.slices);
  if (!state) throw new Error("This Top 5 has no moments picked. Make a new one.");
  const free = await freeGb(storageDir()).catch(() => Infinity);
  if (free < minFreeGb()) throw new Error(`Only ${free.toFixed(1)} GB free on the disk. Free some space, then press Retry.`);
  const t0 = Date.now();
  const settings = await getSettings();
  const dir = storagePath("edits", editId), work = path.join(dir, "work");
  fs.mkdirSync(work, { recursive: true });

  // 1) the picked moments, as they are now (a creator may have been removed / un-approved since)
  await setStage(editId, "picking");
  const ids = [...state.picks, ...state.spares];
  const fresh = new Map((await loadTop5Cands(new Date(), ids)).map((c) => [c.momentId, c]));
  const queue = ids.map((id) => fresh.get(id)).filter((c): c is Top5Cand => Boolean(c && c.approved));

  // 2) downloading (raw file reused when it's still there): best first, spares replace failures
  await setStage(editId, "downloading");
  const got: { cand: Top5Cand; src: EditSource }[] = [];
  const problems: string[] = [];
  for (let i = 0; i < queue.length && got.length < TOP5_COUNT; i++) {
    const c = queue[i];
    try { got.push({ cand: c, src: await getSource(editId, i, c, await clipWords(c.clipId), { before: 14, after: 12 }) }); }
    catch (e) { problems.push(`${c.login}: ${(e as Error).message.split("\n").pop()}`); }
  }
  if (got.length < TOP5_COUNT) throw new Error(`Only ${got.length} of the moments could be downloaded (a Top 5 needs ${TOP5_COUNT}). ${problems[0] ?? ""}`.trim());

  // 3) cutting: each moment's own tight window + its v1.9 layout
  await setStage(editId, "cutting");
  const prepared = [] as { cand: Top5Cand; src: EditSource; layout: Top5RenderEntry["layout"]; cropKeysFrom: number | null; why: string; hasAudio: boolean; size: { w: number; h: number } }[];
  for (const { cand, src } of got) {
    const clip = cand.clipId ? await prisma.clip.findUnique({ where: { id: cand.clipId }, select: { camInfo: true, layout: true } }) : null;
    const streamer = await prisma.streamer.findUniqueOrThrow({ where: { id: cand.streamerId }, select: { facecam: true, facecamAuto: true } });
    const mode: LayoutSetting = clip?.layout ? parseLayoutSetting(clip.layout) : "auto";
    const lay = await editLayout({ file: src.file, payoff: src.payoff, dur: src.dur, camInfo: clip?.camInfo ?? null, category: cand.category, funny: cand.category === "funny", streamer, mode });
    const shift = cand.payoffAt != null ? src.payoff - cand.payoffAt : src.reused ? 0 : null; // raw seconds -> this file's seconds
    const cropKeysFrom = lay.det ? (lay.cached ? (shift != null ? lay.det.winStart + shift : null) : lay.det.winStart) : null;
    prepared.push({ cand, src, layout: lay.layout, cropKeysFrom, why: lay.why, hasAudio: await hasAudio(src.file).catch(() => false), size: await probeSize(src.file).catch(() => ({ w: 1920, h: 1080 })) });
  }
  const wins = prepared.map(({ cand, src }) => {
    const shift = cand.payoffAt != null ? src.payoff - cand.payoffAt : src.reused ? 0 : null;
    const win = shift != null && cand.winStart != null && cand.winLength ? { start: cand.winStart + shift, end: cand.winStart + cand.winLength + shift } : null;
    return entryWindow({ payoff: src.payoff, dur: src.dur, words: src.words, win });
  });
  const fitted = fitTotal(wins, prepared.map((p) => p.src.dur));

  // 4) rendering: countdown order (#5 first, the best last)
  await setStage(editId, "rendering");
  const order = countdown(prepared.map((p, i) => ({ ...p, win: fitted[i] })));
  const entries: Top5RenderEntry[] = order.map((p, k) => ({
    n: order.length - k, login: p.cand.login, file: p.src.file, hasAudio: p.hasAudio, src: p.size, layout: p.layout, win: p.win,
    captions: entryCaptions(p.src.words, p.win), cropKeysFrom: p.cropKeysFrom,
  }));
  const channels = await prisma.channel.findMany({ orderBy: { createdAt: "asc" } });
  const channel = channelForClip(channels, { category: "edits" })?.name ?? settings.channelName;
  const watermark = settings.watermark ? channel : null; // the EDIT channel's name (ClipFactoryGG), not the clip brand
  const theme = state.theme;
  const best = prepared[0].cand;
  const titles = top5Titles(theme, {
    allGta: prepared.every((p) => isGtaMoment(p.cand)), creatorName: theme === "creator" ? best.name : null,
    funnyShare: prepared.filter((p) => p.cand.category === "funny").length / prepared.length,
  });
  const finalRel = `edits/${editId}/final.mp4`;
  const r = await renderTop5({ entries, title: titles.card, channel, watermark, workDir: work, final: storagePath(finalRel) });

  const file = await probeFinal(storagePath(finalRel)).catch(() => null);
  const kinds = entries.map((e) => e.layout.kind);
  const render = renderFacts({
    captions: entries.some((e) => e.captions.length > 0), hook: true, watermark: watermarkText(watermark) || null, styled: true,
    layout: kinds.includes("split") ? "split" : kinds.includes("fullcam") ? "fullcam" : "blur", place: entries[0].layout.place,
    sourceUrl: best.sourceUrl ?? null,
  });
  const used = order.map((p) => p.cand); // as they appear: #5 ... #1
  const creators = creatorsOf(used);
  const lead = theme === "creator" && state.creatorId ? state.creatorId : best.streamerId;
  const title = edit.title ?? titles.hook;
  const caption = edit.caption ?? top5Caption(title, creators, { theme, campaign: theme === "creator" ? edit.streamer.campaign : null, game: isGtaMoment(best) ? null : best.gameName });
  const report = {
    top5: { ...state, picks: prepared.map((p) => p.cand.momentId) },
    entries: describeTop5(entries.map((e, k) => ({ n: e.n, login: e.login, start: e.win.start, end: e.win.end, payoff: e.win.payoff, layout: `${e.layout.kind} (${order[k].why})` }))),
    picks: order.map((p) => ({ n: 0, momentId: p.cand.momentId, clipId: p.cand.clipId, login: p.cand.login, strength: (p.cand as Top5Ranked).strength ?? null, reused: p.src.reused })),
    slices: entries.map((e) => `#${e.n}`), renderMs: r.ms, entryMs: r.entryMs, totalMs: Date.now() - t0, problems,
  };
  report.picks.forEach((p, k) => { p.n = order.length - k; });
  for (const name of fs.readdirSync(dir)) if (name.startsWith("src-")) fs.rmSync(path.join(dir, name), { force: true });
  fs.rmSync(work, { recursive: true, force: true });
  await prisma.edit.update({
    where: { id: editId },
    data: {
      status: "pending", stage: null, stageAt: new Date(), error: null, finalPath: finalRel, finalWithBeatPath: null, streamerId: lead,
      duration: r3(r.duration), lengthSec: Math.round(r.duration), platformInfo: JSON.stringify({ file, render, at: new Date().toISOString() }),
      slices: JSON.stringify(report), creators: JSON.stringify(creators), title, caption,
    },
  });
  return `Top 5 (${theme}): ${entries.map((e) => `#${e.n} @${e.login}`).join(", ")}, ${r3(r.duration)}s, rendered in ${(r.ms / 1000).toFixed(1)}s`;
}
