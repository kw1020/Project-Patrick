// Queue page filters: status tab, type (`cat` = all | funny | gaming) and one creator (`creator` = Streamer.id).
import type { Prisma } from "@prisma/client";

export const QUEUE_TABS = [
  { key: "pending", label: "To review" },
  { key: "approved", label: "Approved" },
  { key: "processing", label: "In the line" },
  { key: "posted", label: "Posted" },
  { key: "rejected", label: "Rejected" },
  { key: "failed", label: "Failed" },
  // v1.9.4: clips nobody reviewed in time (video auto-deleted). Only shown on this tab, never counted as "to review".
  { key: "expired", label: "Expired" },
] as const;
export type QueueTab = (typeof QUEUE_TABS)[number]["key"];

export const QUEUE_CATS = [
  { key: "all", label: "All" },
  { key: "funny", label: "Funny" },
  { key: "gaming", label: "Gaming" },
] as const;
export type QueueCat = (typeof QUEUE_CATS)[number]["key"];

export type QueueFilter = { tab: QueueTab; cat: QueueCat; creator: string | null };

/** Read the page's search params; anything unknown falls back to the default. */
export function parseQueueParams(p: { tab?: string; cat?: string; creator?: string }): QueueFilter {
  const tab = QUEUE_TABS.find((x) => x.key === p.tab)?.key ?? "pending";
  const cat = QUEUE_CATS.find((x) => x.key === p.cat)?.key ?? "all";
  const creator = typeof p.creator === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p.creator) ? p.creator : null;
  return { tab, cat, creator };
}

/** Prisma `where` for the clips shown. `omit` leaves one part out (used for the counts on the tabs). */
export function queueWhere(f: QueueFilter, omit?: "tab" | "cat"): Prisma.ClipWhereInput {
  const where: Prisma.ClipWhereInput = {};
  if (omit !== "tab") where.status = f.tab;
  if (omit !== "cat" && f.cat !== "all") where.category = f.cat;
  if (f.creator) where.moment = { streamerId: f.creator };
  return where;
}

/** Link to the queue with some params changed (default values are left out of the URL). */
export function queueHref(f: QueueFilter, change: Partial<QueueFilter>) {
  const n = { ...f, ...change };
  const q = new URLSearchParams();
  if (n.tab !== "pending") q.set("tab", n.tab);
  if (n.cat !== "all") q.set("cat", n.cat);
  if (n.creator) q.set("creator", n.creator);
  const s = q.toString();
  return s ? `/queue?${s}` : "/queue";
}
