import fs from "node:fs";
import { Readable } from "node:stream";
import { prisma } from "@/lib/db";
import { resolveStored } from "@/lib/paths";

export const dynamic = "force-dynamic";

/**
 * v2.0.0: streams an edit with Range support. ?variant=final (default, the no-music edit to post) | beat (preview with the
 * beat mixed in, never to be posted); ?download=1 saves it.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const beat = q.get("variant") === "beat";
  const edit = await prisma.edit.findUnique({ where: { id }, include: { streamer: true } });
  const rel = beat ? edit?.finalWithBeatPath : edit?.finalPath;
  if (!edit || !rel) return new Response("Not found", { status: 404 });
  let file: string;
  try { file = resolveStored(rel); } catch { return new Response("Bad path", { status: 400 }); }
  if (!fs.existsSync(file)) return new Response("File missing", { status: 404 });

  const size = fs.statSync(file).size;
  const headers: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (q.get("download")) {
    const name = `${edit.streamer.login}-${edit.vibe}-edit${beat ? "-PREVIEW-with-beat-dont-post" : ""}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
    headers["Content-Disposition"] = `attachment; filename="${name}.mp4"`;
  }
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? parseInt(range[1]) : 0;
    const end = range[2] ? Math.min(parseInt(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers: { ...headers, "Content-Length": String(size) } });
}
