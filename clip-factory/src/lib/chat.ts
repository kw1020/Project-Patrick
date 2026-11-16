// Anonymous, read-only Twitch chat reader (IRC over WebSocket, no login needed).
// Tracks counted messages/sec per channel and detects chat spikes with false-spike guards.
// Design: CLAUDE.md → "Chat spike detector".

export const HYPE = /(\b(lmf?ao+|kekw|omegalul|lul+|pog(gers|champ)?|clip (it|that)|no way+)\b|^w+$)/i;

/** Accounts whose messages never count (plus the channel's own account). */
export const BOTS = new Set([
  "nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot",
  "sery_bot", "soundalerts", "botrixoficial", "kofistreambot",
]);

const WINDOW = 10;              // seconds per window
const BASE_SPAN = 300;          // baseline looks back 5 min
const MIN_BASE_WINDOWS = 12;    // ≥ 12 previous windows (2 min) before a baseline exists
const WARMUP_MS = 120_000;      // no spikes in the first 2 min after joining
const BASE_FLOOR = 0.3;         // msgs/sec floor for the baseline
const USER_CAP = 2;             // counted messages per chatter per 10s
const MIN_CHATTERS = 6;         // distinct chatters for a volume spike
const RAID_MUTE_MS = 120_000;
const SUB_MUTE_MS = 60_000;
const SUB_TRAIN = 3;            // sub notices in 30s that make a sub train
const SUB_TRAIN_MS = 30_000;
const GIFT_BOMB = 5;            // submysterygift mass-gift-count that mutes
const JOIN_BATCH = 15;          // Twitch anon limit is 20 JOINs / 10s
const JOIN_GAP_MS = 10_000;

type Bucket = { n: number; hype: number; users: Set<string>; hypeUsers: Set<string> };
export type Spike = {
  kind: "volume" | "hype"; rate: number; baseline: number; ratio: number;
  hypeShare: number; messages: number; chatters: number;
};

/** The bits of a WebSocket we use (injectable for tests). */
export interface ChatSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export interface ChatClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export type ChatHeatOptions = { socket?: (url: string) => ChatSocket; clock?: ChatClock };

export type IrcLine = { tags: Record<string, string>; prefix: string; command: string; params: string[]; text: string };

const unescapeTag = (v: string) =>
  v.replace(/\\(.)/g, (_, c: string) => ({ s: " ", ":": ";", "\\": "\\", r: "\r", n: "\n" } as Record<string, string>)[c] ?? c);

/** Parse one raw IRC line (IRCv3 tags, prefix, command, params, trailing text). */
export function parseIrc(line: string): IrcLine | null {
  let rest = line.trim();
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return null;
    for (const kv of rest.slice(1, sp).split(";")) {
      const eq = kv.indexOf("=");
      if (eq < 0) tags[kv] = "";
      else tags[kv.slice(0, eq)] = unescapeTag(kv.slice(eq + 1));
    }
    rest = rest.slice(sp + 1).trimStart();
  }
  let prefix = "";
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).trimStart();
  }
  let text = "";
  const t = rest.indexOf(" :");
  if (t >= 0) { text = rest.slice(t + 2); rest = rest.slice(0, t); }
  const [command, ...params] = rest.split(" ").filter(Boolean);
  if (!command) return null;
  return { tags, prefix, command: command.toUpperCase(), params, text };
}

const OPEN = 1; // WebSocket.OPEN

export class ChatHeat {
  private ws: ChatSocket | null = null;
  private wanted = new Set<string>();
  private joined = new Set<string>();
  private joinQueue: string[] = [];
  private lastJoinAt = -Infinity;
  private joinTimer: unknown = null;
  private buckets = new Map<string, Map<number, Bucket>>();
  private since = new Map<string, number>(); // when we started listening to each channel
  private recent = new Map<string, { t: number; text: string }[]>();
  private perUser = new Map<string, Map<string, number[]>>(); // chan → user → counted msg times (last 10s)
  private mutedUntil = new Map<string, number>();
  private raids = new Map<string, { from: number; to: number }[]>(); // raid mute spans (excluded from baseline)
  private subs = new Map<string, number[]>(); // sub notice times (last 30s)
  private anon = 0;
  private backoff = 1000;
  private stopped = false;
  private readonly makeSocket: (url: string) => ChatSocket;
  private readonly clock: ChatClock;

  constructor(opts: ChatHeatOptions = {}) {
    this.makeSocket = opts.socket ?? ((url) => new WebSocket(url) as unknown as ChatSocket);
    this.clock = opts.clock ?? { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  setChannels(logins: string[]) {
    this.wanted = new Set(logins.map((l) => l.toLowerCase()));
    if (this.wanted.size && !this.ws) this.connect();
    this.sync();
  }

  stop() {
    this.stopped = true;
    if (this.joinTimer) this.clock.clearTimeout(this.joinTimer);
    this.joinTimer = null;
    this.ws?.close();
  }

  /** Counted msgs/sec over the last minute, 5-min average, and hype msgs/sec over the last minute. */
  stats(login: string, now = this.clock.now()) {
    const b = this.buckets.get(login.toLowerCase());
    if (!b) return { rate: 0, avg: 0, hype: 0 };
    const sec = Math.floor(now / 1000);
    let n1 = 0, n5 = 0, h1 = 0;
    for (const [s, v] of b) {
      if (s < sec - BASE_SPAN) { b.delete(s); continue; }
      n5 += v.n;
      if (s >= sec - 60) { n1 += v.n; h1 += v.hype; }
    }
    return { rate: n1 / 60, avg: n5 / BASE_SPAN, hype: h1 / 60 };
  }

  /**
   * Feed one chat message. `user` is the sender's login; when omitted each message counts as a
   * different chatter. Returns true when the message was counted.
   */
  record(login: string, text: string, now = this.clock.now(), user?: string): boolean {
    const chan = login.toLowerCase();
    const who = user?.toLowerCase() ?? `\u0000anon${++this.anon}`;
    if (!this.since.has(chan)) this.since.set(chan, now);
    if (BOTS.has(who) || who === chan || text.trimStart().startsWith("!")) return false;

    // Per-chatter cap: at most USER_CAP counted messages in any 10s.
    let users = this.perUser.get(chan);
    if (!users) this.perUser.set(chan, (users = new Map()));
    const times = (users.get(who) ?? []).filter((t) => t > now - WINDOW * 1000);
    if (times.length >= USER_CAP) { users.set(who, times); return false; }
    times.push(now);
    users.set(who, times);
    if (users.size > 5000) this.pruneUsers(chan, now);

    let b = this.buckets.get(chan);
    if (!b) this.buckets.set(chan, (b = new Map()));
    const sec = Math.floor(now / 1000);
    let cur = b.get(sec);
    if (!cur) b.set(sec, (cur = { n: 0, hype: 0, users: new Set(), hypeUsers: new Set() }));
    cur.n++;
    cur.users.add(who);
    if (HYPE.test(text.trim())) { cur.hype++; cur.hypeUsers.add(who); }

    let r = this.recent.get(chan);
    if (!r) this.recent.set(chan, (r = []));
    r.push({ t: now, text: text.slice(0, 120) });
    if (r.length > 300) r.splice(0, r.length - 300);
    return true;
  }

  /** Mark a channel as being listened to from `now` (the baseline needs 2 min before spikes count). */
  listen(login: string, now = this.clock.now()) {
    const chan = login.toLowerCase();
    if (!this.since.has(chan)) this.since.set(chan, now);
  }

  /** Raid into the channel: no spikes for 120s, and that time stays out of the baseline. */
  raid(login: string, now = this.clock.now()) {
    const chan = login.toLowerCase();
    this.mute(chan, now + RAID_MUTE_MS);
    let r = this.raids.get(chan);
    if (!r) this.raids.set(chan, (r = []));
    r.push({ from: now, to: now + RAID_MUTE_MS });
    const cutoff = now - BASE_SPAN * 1000 - RAID_MUTE_MS;
    while (r.length && r[0].to < cutoff) r.shift();
  }

  /** A sub/resub/subgift notice; ≥3 in 30s is a sub train → mute 60s. */
  sub(login: string, now = this.clock.now()) {
    const chan = login.toLowerCase();
    const t = (this.subs.get(chan) ?? []).filter((x) => x > now - SUB_TRAIN_MS);
    t.push(now);
    this.subs.set(chan, t);
    if (t.length >= SUB_TRAIN) this.mute(chan, now + SUB_MUTE_MS);
  }

  /** A gift bomb (submysterygift): ≥5 gifts → mute 60s. */
  giftBomb(login: string, count: number, now = this.clock.now()) {
    if (count >= GIFT_BOMB) this.mute(login.toLowerCase(), now + SUB_MUTE_MS);
  }

  /** True while spikes are muted for this channel (raid / sub train / gift bomb). */
  muted(login: string, now = this.clock.now()) {
    return now < (this.mutedUntil.get(login.toLowerCase()) ?? 0);
  }

  private mute(chan: string, until: number) {
    this.mutedUntil.set(chan, Math.max(until, this.mutedUntil.get(chan) ?? 0));
  }

  /** Handle one raw IRC line from Twitch (exposed for tests). */
  handleLine(line: string, now = this.clock.now()) {
    if (!line) return;
    if (line.startsWith("PING")) { this.ws?.send(line.replace("PING", "PONG")); return; }
    const m = parseIrc(line);
    if (!m) return;
    const chan = m.params[0]?.startsWith("#") ? m.params[0].slice(1).toLowerCase() : "";
    if (!chan) return;
    if (m.command === "PRIVMSG") {
      const user = m.prefix.split("!")[0] || m.tags["login"] || m.tags["display-name"] || undefined;
      this.record(chan, m.text, now, user);
    } else if (m.command === "USERNOTICE") {
      const id = m.tags["msg-id"];
      if (id === "raid") this.raid(chan, now);
      else if (id === "sub" || id === "resub" || id === "subgift") this.sub(chan, now);
      else if (id === "submysterygift") this.giftBomb(chan, Number(m.tags["msg-param-mass-gift-count"] ?? 0), now);
    }
  }

  /**
   * Spike check: the last 10s of counted chat vs the median 10s window of the ~5 min before it.
   * "volume" = S ≥ multiplier with ≥ 6 distinct chatters. "hype" = a hype-word flood on a smaller bump.
   */
  spike(login: string, multiplier: number, now = this.clock.now()): Spike | null {
    const chan = login.toLowerCase();
    const b = this.buckets.get(chan), t0 = this.since.get(chan);
    if (!b || t0 === undefined) return null;
    if (now - t0 < WARMUP_MS || this.muted(chan, now)) return null;
    this.pruneUsers(chan, now);
    const sec = Math.floor(now / 1000), t0sec = Math.floor(t0 / 1000);

    // Current window: buckets sec-9 .. sec.
    let n = 0, hype = 0;
    const users = new Set<string>(), hypeUsers = new Set<string>();
    for (let s = sec - WINDOW + 1; s <= sec; s++) {
      const v = b.get(s);
      if (!v) continue;
      n += v.n; hype += v.hype;
      v.users.forEach((u) => users.add(u));
      v.hypeUsers.forEach((u) => hypeUsers.add(u));
    }

    // Previous windows within the last 5 min, skipping time before we listened and raid mutes.
    const raids = this.raids.get(chan) ?? [];
    const rates: number[] = [];
    for (let k = 1; k < BASE_SPAN / WINDOW; k++) {
      const end = sec - k * WINDOW, start = end - WINDOW + 1;
      if (start < t0sec) break;
      if (raids.some((r) => start * 1000 < r.to && (end + 1) * 1000 > r.from)) continue;
      let c = 0;
      for (let s = start; s <= end; s++) c += b.get(s)?.n ?? 0;
      rates.push(c / WINDOW);
    }
    if (rates.length < MIN_BASE_WINDOWS) return null;
    rates.sort((x, y) => x - y);
    const mid = rates.length >> 1;
    const baseline = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;

    const rate = n / WINDOW;
    const S = rate / Math.max(baseline, BASE_FLOOR);
    const out = {
      rate, baseline, ratio: Math.round(Math.min(99, S) * 10) / 10,
      hypeShare: n ? Math.round((hype / n) * 100) / 100 : 0, messages: n, chatters: users.size,
    };
    if (S >= multiplier && users.size >= MIN_CHATTERS) return { kind: "volume", ...out };
    if (n && hype / n >= 0.5 && hype >= 6 && hypeUsers.size >= 4 && S >= Math.max(1.5, multiplier / 2)) return { kind: "hype", ...out };
    return null;
  }

  /** Up to `max` chat lines from the last `secs` seconds (context for the Judge). */
  samples(login: string, secs = 20, max = 40, now = this.clock.now()) {
    const r = (this.recent.get(login.toLowerCase()) ?? []).filter((m) => m.t >= now - secs * 1000);
    const step = Math.max(1, Math.ceil(r.length / max));
    return r.filter((_, i) => i % step === 0).map((m) => m.text);
  }

  private pruneUsers(chan: string, now: number) {
    const users = this.perUser.get(chan);
    if (!users) return;
    for (const [u, t] of users) if (!t.length || t[t.length - 1] <= now - WINDOW * 1000) users.delete(u);
  }

  private connect() {
    if (this.stopped) return;
    const ws = this.makeSocket("wss://irc-ws.chat.twitch.tv:443");
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      this.joined.clear();
      this.joinQueue = [];
      this.sync();
    };
    ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\r\n")) this.handleLine(line, this.clock.now());
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.joined.clear();
      this.joinQueue = [];
      if (this.joinTimer) { this.clock.clearTimeout(this.joinTimer); this.joinTimer = null; }
      if (this.stopped || !this.wanted.size) return;
      this.clock.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    };
    ws.onerror = () => { /* onclose handles reconnect */ };
  }

  private forget(c: string) {
    this.buckets.delete(c); this.since.delete(c); this.recent.delete(c);
    this.perUser.delete(c); this.mutedUntil.delete(c); this.raids.delete(c); this.subs.delete(c);
  }

  private sync() {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    this.joinQueue = this.joinQueue.filter((c) => this.wanted.has(c));
    const queued = new Set(this.joinQueue);
    for (const c of this.wanted) if (!this.joined.has(c) && !queued.has(c)) this.joinQueue.push(c);
    const part = [...this.joined].filter((c) => !this.wanted.has(c));
    if (part.length) ws.send(`PART ${part.map((c) => "#" + c).join(",")}`);
    part.forEach((c) => { this.joined.delete(c); this.forget(c); });
    this.flushJoins();
  }

  /** Send queued JOINs: ≤ 15 channels per batch, batches ≥ 10s apart. */
  private flushJoins() {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN || !this.joinQueue.length || this.joinTimer) return;
    const now = this.clock.now();
    const wait = this.lastJoinAt + JOIN_GAP_MS - now;
    if (wait > 0) {
      this.joinTimer = this.clock.setTimeout(() => { this.joinTimer = null; this.flushJoins(); }, wait);
      return;
    }
    const batch = this.joinQueue.splice(0, JOIN_BATCH);
    ws.send(`JOIN ${batch.map((c) => "#" + c).join(",")}`);
    this.lastJoinAt = now;
    batch.forEach((c) => { this.joined.add(c); this.listen(c, now); });
    if (this.joinQueue.length) {
      this.joinTimer = this.clock.setTimeout(() => { this.joinTimer = null; this.flushJoins(); }, JOIN_GAP_MS);
    }
  }
}
