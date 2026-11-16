// Fills the dashboard with demo data so you can see it working before Twitch keys are in.
// Usage: npm run db:seed-demo        (remove with: npm run db:seed-demo -- --clear)
import fs from "node:fs";
import { prisma } from "../src/lib/db";
import { run } from "../src/lib/media";
import { ensureStorage, storagePath } from "../src/lib/paths";
import { enqueueCut, redis } from "../src/lib/queues";
import { defaultCaption, defaultTitle } from "../src/lib/social";

const DEMO = [
  { twitchId: "demo-1", login: "demo_streamer", name: "DemoStreamer", approved: true, viewers: 18432, title: "GTA 6 DAY ONE — FULL STORY BLIND", chat: [7.2, 2.1] },
  { twitchId: "demo-2", login: "demo_racer", name: "DemoRacer", approved: true, viewers: 6120, title: "Vice City street racing, chill vibes", chat: [1.4, 1.2] },
  { twitchId: "demo-3", login: "demo_unapproved", name: "NotApprovedYet", approved: false, viewers: 2210, title: "first heist!! !discord", chat: [0, 0] },
];

async function main() {
  if (process.argv.includes("--clear")) {
    await prisma.streamer.deleteMany({ where: { twitchId: { startsWith: "demo-" } } });
    console.log("Demo data removed.");
    return;
  }
  ensureStorage();
  const raw = storagePath("raw", "demo-source.mp4");
  if (!fs.existsSync(raw)) {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=40",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=40", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", raw]);
  }
  for (const d of DEMO) {
    const s = await prisma.streamer.upsert({
      where: { twitchId: d.twitchId },
      update: { isLive: true, viewers: d.viewers, chatRate: d.chat[0], chatAvg: d.chat[1] },
      create: {
        twitchId: d.twitchId, login: d.login, name: d.name, approved: d.approved, approvalNote: d.approved ? "Demo data" : null,
        isLive: true, viewers: d.viewers, peakViewers: d.viewers, streamTitle: d.title, liveSince: new Date(Date.now() - 95 * 60_000),
        lastSeenAt: new Date(), chatRate: d.chat[0], chatAvg: d.chat[1],
      },
    });
    if (!d.approved) continue;
    for (const [i, t] of ["NO WAY he pulled that off", "Chat lost it at the bank job"].entries()) {
      const title = defaultTitle(t, s.name);
      const m = await prisma.moment.create({
        data: {
          streamerId: s.id, timestamp: new Date(), source: "twitch_clip", spikeScore: 900 - i * 300, sourceTitle: t, sourceViews: 900 - i * 300,
          sourceUrl: `https://twitch.tv/${s.login}`,
          clips: { create: { title, caption: defaultCaption(title, s.name, s.login), rawPath: "raw/demo-source.mp4", stage: "cut" } },
        },
        include: { clips: true },
      });
      await enqueueCut(m.clips[0].id);
    }
  }
  console.log("Demo data added. The worker will cut the demo clips in a few seconds.");
}

main().finally(async () => { await prisma.$disconnect(); redis().disconnect(); });
