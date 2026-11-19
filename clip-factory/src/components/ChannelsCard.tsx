"use client";
import { useActionState, useState, useTransition } from "react";
import { addManualAccount, createChannel, deleteChannel, disconnectAccount, saveChannel, setAccountChannel, setAccountDisabled } from "../../app/actions";
import { CHANNEL_FOCUS, CHANNEL_KINDS, PLATFORM_LABEL, POST_PLATFORMS, isEditsOnly, parseFocus, parseKinds } from "../lib/channels";
import { EDIT_STYLES, LAYOUTS, editStyleLabel } from "../lib/edit-styles";

export type ChannelAccountView = { id: string; platform: string; label: string; mode: string; error: string | null; homeChannelId: string | null; posts: number; disabled?: boolean };
export type ChannelView = { id: string; name: string; kinds: string; focus: string; editStyle?: string | null; layout?: string | null; captionStyle?: string | null };
/** v2.0.6: what "Same as Settings" means right now (the global Editing style / Layout), shown in the selects. */
export type StyleDefaults = { editStyle: string; layout: string };

const chip: Record<string, string> = { youtube: "bg-red-600/20 text-red-300", tiktok: "bg-cyan-500/15 text-cyan-300", instagram: "bg-fuchsia-500/15 text-fuchsia-300" };
const box = "h-4 w-4 accent-[#ff3d81]";
type Connectable = { youtube: boolean; tiktok: boolean; instagram?: boolean };
const canConnectTo = (c: Connectable, platform: string) => Boolean((c as Record<string, boolean | undefined>)[platform]);

/** Settings → Channels (v1.9.5): each brand = one YouTube + one TikTok + one Instagram slot (Connect or Add handle). */
export function ChannelsCard({ channels, accounts, canConnect, defaults = { editStyle: "hype", layout: "auto" } }: { channels: ChannelView[]; accounts: ChannelAccountView[]; canConnect: Connectable; defaults?: StyleDefaults }) {
  const unplaced = accounts.filter((a) => !a.homeChannelId || !channels.some((c) => c.id === a.homeChannelId));
  return (
    <div className="card space-y-5 p-5" id="channels" data-testid="channels-card">
      <div>
        <div className="text-xs font-bold uppercase tracking-wide text-zinc-400">Channels</div>
        <p className="mt-1 text-xs text-zinc-500">A channel is one of your brands: one YouTube, one TikTok and one Instagram account that all get the same clips (whatever goes on its YouTube goes on its TikTok and Instagram too). Clips go to the channel that fits them: GTA 6 channels get every GTA 6 clip, &ldquo;any game&rdquo; channels get clips of the types you tick. You can change it per clip on Upload. Each channel can have its own editing (style, layout, captions) so its clips look different from the others; its clips also get its own name as the watermark.</p>
      </div>
      <QuickAdd channels={channels} />
      <div className="space-y-4">
        {channels.map((c) => <ChannelBlock key={c.id} c={c} accounts={accounts} canConnect={canConnect} canDelete={channels.length > 1} defaults={defaults} />)}
      </div>
      {unplaced.length > 0 && (
        <div className="space-y-2 rounded-xl border border-sun/30 p-3" data-testid="unplaced-accounts">
          <div className="text-sm font-bold text-amber-200">Not in a channel yet</div>
          {unplaced.map((a) => <AccountLine key={a.id} a={a} channels={channels} />)}
        </div>
      )}
      <NewChannel />
    </div>
  );
}

function QuickAdd({ channels }: { channels: ChannelView[] }) {
  const [state, action, pending] = useActionState(addManualAccount, null);
  // Controlled selects: React resets the form after each add (the handle box empties), platform + channel stay for "Add another".
  const [platform, setPlatform] = useState("tiktok");
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  return (
    <form action={action} className="space-y-2 rounded-xl border border-line p-3" data-testid="quick-add">
      <div className="text-sm font-bold">Add an account by handle <span className="text-xs font-normal text-zinc-500">(accounts you post to yourself; add as many as you like, one after another)</span></div>
      <div className="flex flex-wrap gap-2">
        <select name="platform" aria-label="Platform" className="field w-32" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {POST_PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
        </select>
        <input name="handle" placeholder="@handle" aria-label="Handle" className="field w-44 min-w-0 flex-1" required autoFocus={Boolean(state?.ok)} />
        <select name="channelId" aria-label="Channel" className="field w-44 min-w-0 flex-1" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn-hot" disabled={pending}>{state?.ok ? "Add another" : "Add"}</button>
      </div>
      {state?.ok && <div className="text-xs text-emerald-300">{state.ok}</div>}
      {state?.error && <div className="text-xs text-red-300">{state.error}</div>}
    </form>
  );
}

function ChannelBlock({ c, accounts, canConnect, canDelete, defaults }: { c: ChannelView; accounts: ChannelAccountView[]; canConnect: Connectable; canDelete: boolean; defaults: StyleDefaults }) {
  const kinds = parseKinds(c.kinds), focus = parseFocus(c.focus);
  const [confirm, setConfirm] = useState(false);
  const [busy, start] = useTransition();
  return (
    <section className="space-y-3 rounded-xl border border-line p-3" data-testid="channel-block">
      <form action={saveChannel.bind(null, c.id)} className="flex flex-wrap items-center gap-2">
        <input name="name" defaultValue={c.name} aria-label="Channel name" className="field w-48 min-w-0 flex-1 font-bold" maxLength={40} />
        <select name="focus" defaultValue={CHANNEL_FOCUS.some((f) => f.key === focus) ? focus : "any"} aria-label="Focus" className="field w-32">
          {CHANNEL_FOCUS.map((f) => <option key={f.key} value={f.key} title={f.hint}>{f.label}</option>)}
        </select>
        <div className="flex flex-wrap gap-3 text-sm">
          {CHANNEL_KINDS.map((k) => (
            <label key={k.key} className="flex items-center gap-1.5"><input type="checkbox" name={`kind_${k.key}`} defaultChecked={kinds.includes(k.key)} className={box} />{k.label}</label>
          ))}
        </div>
        {/* v2.0.6 per-channel editing: "" = same as the Settings default */}
        {!isEditsOnly(c) && (
          <div className="flex w-full flex-wrap items-center gap-2 text-xs" data-testid="channel-style">
            <span className="text-zinc-400">Its clips are cut in</span>
            <select name="editStyle" defaultValue={c.editStyle ?? ""} aria-label="Editing style" className="field w-40 py-1 text-xs">
              <option value="">Same as Settings ({editStyleLabel(defaults.editStyle) ?? "Hype"})</option>
              {EDIT_STYLES.map((x) => <option key={x.key} value={x.key} title={x.hint}>{x.label}</option>)}
            </select>
            <select name="layout" defaultValue={c.layout ?? ""} aria-label="Layout" className="field w-40 py-1 text-xs">
              <option value="">Layout: same as Settings ({LAYOUTS.find((l) => l.key === defaults.layout)?.short ?? "Auto"})</option>
              {LAYOUTS.map((x) => <option key={x.key} value={x.key} title={x.hint}>{x.short}</option>)}
            </select>
            <select name="captionStyle" defaultValue={c.captionStyle ?? ""} aria-label="Caption look" className="field w-44 py-1 text-xs">
              <option value="">Captions: match the style</option>
              {EDIT_STYLES.map((x) => <option key={x.key} value={x.key}>Captions: {x.label}</option>)}
            </select>
            <span className="text-zinc-500">Watermark: @{c.name}</span>
          </div>
        )}
        <button className="btn-ghost">Save</button>
        {canDelete && (confirm
          ? <button type="button" className="btn-bad" disabled={busy} onClick={() => start(() => deleteChannel(c.id))}>Delete {c.name}?</button>
          : <button type="button" className="btn-bad" onClick={() => setConfirm(true)}>Delete</button>)}
      </form>
      <div className="grid gap-2 sm:grid-cols-3">
        {POST_PLATFORMS.map((p) => {
          const a = accounts.find((x) => x.homeChannelId === c.id && x.platform === p);
          return (
            <div key={p} className="min-w-0 rounded-lg bg-ink p-2.5" data-testid={`slot-${p}`}>
              <div className="mb-1.5 flex items-center gap-1.5">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-black uppercase ${chip[p]}`}>{PLATFORM_LABEL[p]}</span>
                {a && <span className="text-[10px] uppercase text-zinc-500">{a.mode === "manual" ? "by hand" : "connected"}</span>}
              </div>
              {a ? <AccountLine a={a} channels={null} connectFrom={a.mode === "manual" && canConnectTo(canConnect, p) ? c.id : null} />
                : <EmptySlot channelId={c.id} platform={p} connect={canConnectTo(canConnect, p)} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EmptySlot({ channelId, platform, connect }: { channelId: string; platform: string; connect: boolean }) {
  const [state, action, pending] = useActionState(addManualAccount, null);
  return (
    <div className="space-y-1.5">
      {connect && <a href={`/api/${platform}/connect?channel=${channelId}`} className="btn-hot w-full py-1 text-xs">Connect {PLATFORM_LABEL[platform]}</a>}
      <form action={action} className="flex gap-1.5">
        <input type="hidden" name="platform" value={platform} />
        <input type="hidden" name="channelId" value={channelId} />
        <input name="handle" placeholder="@handle" aria-label={`${PLATFORM_LABEL[platform]} handle`} className="field min-w-0 py-1 text-xs" required />
        <button className="btn-ghost shrink-0 px-2 py-1 text-xs" disabled={pending}>Add handle</button>
      </form>
      {state?.error && <div className="text-[11px] text-red-300">{state.error}</div>}
      {!connect && <div className="text-[11px] text-zinc-500">Connecting needs the {PLATFORM_LABEL[platform]} keys in .env{platform === "instagram" ? " (README: Connect Instagram)" : ""}; a handle works without.</div>}
    </div>
  );
}

function AccountLine({ a, channels, connectFrom = null }: { a: ChannelAccountView; channels: ChannelView[] | null; connectFrom?: string | null }) {
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => start(async () => { setErr(null); try { await fn(); } catch (e) { setErr((e as Error).message); } });
  return (
    <div className={`min-w-0 space-y-1 text-sm ${busy ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {channels && <span className={`rounded px-1.5 py-0.5 text-[10px] font-black uppercase ${chip[a.platform] ?? "bg-zinc-800"}`}>{PLATFORM_LABEL[a.platform]}</span>}
        <span className="min-w-0 truncate font-semibold">{a.label}</span>
        <span className="text-xs text-zinc-500">{a.posts} posts</span>
        {a.disabled && <span className="rounded bg-zinc-700 px-1.5 text-[10px] font-black uppercase text-zinc-300" data-testid="account-disabled">Off</span>}
      </div>
      {a.error && <div className="text-xs text-red-300 [overflow-wrap:anywhere]">{a.error}</div>}
      <div className="flex flex-wrap gap-1.5">
        {channels ? (
          <select aria-label="Put in channel" className="field w-44 py-1 text-xs" defaultValue="" disabled={busy} onChange={(e) => e.target.value && run(() => setAccountChannel(a.id, e.target.value))}>
            <option value="">Put in channel…</option>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        ) : (
          <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy} title="Take it out of this channel (it stays connected)" onClick={() => run(() => setAccountChannel(a.id, ""))}>Take out</button>
        )}
        <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy} title={a.disabled ? "Post to all uses it again" : "Post to all skips it and clips don't wait for it"} onClick={() => run(() => setAccountDisabled(a.id, !a.disabled))}>{a.disabled ? "Turn on" : "Turn off"}</button>
        {/* v2.0.3: a by-hand account can be swapped for a connected login (its posts are kept). */}
        {connectFrom && <a href={`/api/${a.platform}/connect?channel=${connectFrom}`} className="btn-hot px-2 py-0.5 text-xs" title="Sign in so Clip Factory posts for you. This by-hand entry is replaced; its posts stay.">Connect</a>}
        {a.mode === "manual" && <button className="btn-bad px-2 py-0.5 text-xs" disabled={busy} onClick={() => run(() => disconnectAccount(a.id))}>Remove</button>}
      </div>
      {err && <div className="text-xs text-red-300">{err}</div>}
    </div>
  );
}

function NewChannel() {
  const [state, action, pending] = useActionState(createChannel, null);
  return (
    <form action={action} className="space-y-2 border-t border-line pt-4" data-testid="new-channel">
      <div className="text-sm font-bold">+ New channel</div>
      <div className="flex flex-wrap items-center gap-2">
        <input name="name" placeholder="Channel name (e.g. FunnyStreamClips)" aria-label="New channel name" className="field w-56 min-w-0 flex-1" maxLength={40} required />
        <select name="focus" aria-label="New channel focus" className="field w-32" defaultValue="any">
          {CHANNEL_FOCUS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <div className="flex flex-wrap gap-3 text-sm">
          {CHANNEL_KINDS.map((k) => <label key={k.key} className="flex items-center gap-1.5"><input type="checkbox" name={`kind_${k.key}`} defaultChecked={k.key !== "edits"} className={box} />{k.label}</label>)}
        </div>
        <button className="btn-hot" disabled={pending}>Make channel</button>
      </div>
      {state?.ok && <div className="text-xs text-emerald-300">{state.ok}</div>}
      {state?.error && <div className="text-xs text-red-300">{state.error}</div>}
    </form>
  );
}
