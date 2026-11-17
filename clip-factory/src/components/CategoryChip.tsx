/** "😂 Funny" / "🎮 Gaming" label. Nothing for older clips without a category. */
export function CategoryChip({ category, className = "" }: { category: string | null | undefined; className?: string }) {
  if (category !== "funny" && category !== "gaming") return null;
  const funny = category === "funny";
  return (
    <span
      data-category={category}
      title={funny ? "Funny moment" : "Gaming moment"}
      className={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-bold ${funny ? "bg-amber-400/20 text-amber-200" : "bg-sky-500/20 text-sky-200"} ${className}`}
    >
      <span aria-hidden>{funny ? "😂" : "🎮"}</span> {funny ? "Funny" : "Gaming"}
    </span>
  );
}
