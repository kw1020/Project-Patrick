/* eslint-disable @next/next/no-img-element */
export function Avatar({ src, name, size = 44 }: { src: string | null; name: string; size?: number }) {
  const style = { width: size, height: size };
  if (src) return <img src={src} alt="" style={style} className="shrink-0 rounded-full bg-zinc-800 object-cover" />;
  return (
    <div style={style} className="grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-zinc-700 to-zinc-800 text-sm font-black text-zinc-300">
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
