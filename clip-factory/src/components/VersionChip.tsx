"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const SEEN_KEY = "cf-seen-version";

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(version: string) {
  try {
    window.localStorage.setItem(SEEN_KEY, version);
  } catch {
    /* private window / storage blocked: the dot just stays */
  }
}

/** "v1.6.0" in the header, linking to /whats-new. A dot shows until the patch notes for this version were opened. */
export function VersionChip({ version }: { version: string }) {
  const path = usePathname();
  const [unread, setUnread] = useState(false);
  const onPage = path === "/whats-new";

  useEffect(() => {
    if (onPage) {
      writeSeen(version);
      setUnread(false);
    } else {
      setUnread(readSeen() !== version);
    }
  }, [onPage, version]);

  return (
    <Link href="/whats-new" title={unread ? "New update: see what's new" : "What's new"}
      className={`relative rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums transition ${onPage ? "bg-panel text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"}`}>
      v{version}
      {unread && (
        <span aria-label="new" className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-hot ring-2 ring-ink" />
      )}
    </Link>
  );
}
