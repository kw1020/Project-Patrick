"use server";

// v1.9.4 Settings → Storage (its own file so it merges cleanly next to app/actions.ts).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { setStatus } from "@/lib/queues";
import { parseRetentionForm } from "@/lib/storage";
import { runRetention } from "@/workers/retention";

function refresh() {
  try { for (const p of ["/", "/queue", "/settings"]) revalidatePath(p); } catch { /* outside a request */ }
}

export async function saveStorageSettings(form: FormData) {
  const data = parseRetentionForm(form);
  await prisma.settings.upsert({ where: { id: "main" }, create: { id: "main", ...data }, update: data });
  refresh();
}

/** "Free up space now": retention right away in disk-pressure mode (every window halved, oldest unreviewed videos go if still short). */
export async function freeUpSpaceNow() {
  let msg: string;
  try {
    msg = await runRetention(Date.now(), { pressure: true });
    await setStatus("retention", true, msg).catch(() => {});
  } catch (e) {
    msg = `Couldn't free space: ${(e as Error).message}`;
  }
  refresh();
  redirect(`/settings?storage=${encodeURIComponent(msg.slice(0, 300))}#storage`);
}
