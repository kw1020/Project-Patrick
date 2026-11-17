"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Live" },
  { href: "/queue", label: "Queue" },
  { href: "/posted", label: "Posted" },
  { href: "/analytics", label: "Analytics" },
  { href: "/streamers", label: "Streamers" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ pending, suggestions = 0 }: { pending: number; suggestions?: number }) {
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
            {l.href === "/streamers" && suggestions > 0 && (
              <span title="New suggestions" className="ml-1.5 rounded-full bg-sun px-1.5 py-0.5 text-[11px] font-bold text-black">{suggestions}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
