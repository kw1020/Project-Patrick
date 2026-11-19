"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Live" },
  { href: "/queue", label: "Queue" },
  { href: "/upload", label: "Upload" },
  { href: "/workroom", label: "Workroom" },
  { href: "/posted", label: "Posted" },
  { href: "/analytics", label: "Analytics" },
  { href: "/streamers", label: "Streamers" },
  { href: "/creators", label: "Creators" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ pending, suggestions = 0, inLine = 0, toPost = 0 }: { pending: number; suggestions?: number; inLine?: number; toPost?: number }) {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto">
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href}
            className={`relative whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition ${active ? "bg-panel text-white" : "text-zinc-400 hover:text-white"}`}>
            {l.label}
            {l.href === "/queue" && pending > 0 && (
              <span className="ml-1.5 rounded-full bg-hot px-1.5 py-0.5 text-[11px] font-bold text-white">{pending}</span>
            )}
            {l.href === "/upload" && toPost > 0 && (
              <span title="Approved clips not on every account of their channel yet" className="ml-1.5 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[11px] font-bold text-black">{toPost}</span>
            )}
            {l.href === "/workroom" && inLine > 0 && (
              <span title="Clips in the line right now" className="ml-1.5 rounded-full bg-zinc-700 px-1.5 py-0.5 text-[11px] font-bold text-white">{inLine}</span>
            )}
            {l.href === "/streamers" && suggestions > 0 && (
              <span title="New suggestions" className="ml-1.5 rounded-full bg-sun px-1.5 py-0.5 text-[11px] font-bold text-black">{suggestions}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
