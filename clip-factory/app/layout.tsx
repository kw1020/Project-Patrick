import type { Metadata } from "next";
import "./globals.css";
import { getSettings, prisma } from "@/lib/db";
import { DEFAULT_CHANNEL } from "@/lib/campaigns";
import { Nav } from "@/components/Nav";
import { ensureChannels, toPostCount } from "@/lib/to-post";
import { VersionChip } from "@/components/VersionChip";
import { getVersion } from "@/lib/version";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Clip Factory", description: "GTA 6 clip pipeline" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await ensureChannels().catch(() => null); // v1.9.5 one-time: ViceCityClips channel + existing accounts in it
  const [pending, suggestions, inLine, channel, toPost] = await Promise.all([
    prisma.clip.count({ where: { status: "pending" } }).catch(() => 0),
    prisma.suggestion.count({ where: { status: "pending", streamer: { approved: false } } }).catch(() => 0),
    prisma.clip.count({ where: { status: "processing" } }).catch(() => 0),
    getSettings().then((s) => s.channelName || DEFAULT_CHANNEL).catch(() => DEFAULT_CHANNEL),
    toPostCount().catch(() => 0),
  ]);
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="sticky top-0 z-20 border-b border-line bg-ink/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <div className="flex items-center gap-2 font-black tracking-tight">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-hot to-sun text-sm text-black">CF</span>
              <span className="text-lg">Clip Factory <span className="font-semibold text-zinc-400" data-testid="channel-name">· {channel}</span></span>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-zinc-400">GTA 6</span>
              <VersionChip version={getVersion()} />
            </div>
            <Nav pending={pending} suggestions={suggestions} inLine={inLine} toPost={toPost} />
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
