// Anonymous, read-only Twitch chat reader (IRC over WebSocket, no login needed).
// Tracks messages/sec per channel. Phase 2's spike detector reads the same buckets.

export const HYPE = /(\b(lmf?ao+|kekw|omegalul|lul+|pog(gers|champ)?|clip (it|that)|no way+)\b|^w+$)/i;

type Bucket = { n: number; hype: number };
export type Spike = { kind: "volume" | "hype"; rate: number; baseline: number; ratio: number; hypeShare: number; messages: number };

export class ChatHeat {
  private ws: WebSocket | null = null;
  private wanted = new Set<string>();
  private joined = new Set<string>();
  private buckets = new Map<string, Map<number, Bucket>>();
  private since = new Map<string, number>(); // when we started listening to each channel
  private recent = new Map<string, { t: number; text: string }[]>();
  private backoff = 1000;
  private stopped = false;

  setChannels(logins: string[]) {
    this.wanted = new Set(logins.map((l) => l.toLowerCase()));
    if (this.wanted.size && !this.ws) this.connect();
    this.sync();
  }

  stop() { this.stopped = true; this.ws?.close(); }

  /** msgs/sec over the last minute, 5-min average, and hype msgs/sec over the last minute. */
  stats(login: string, now = Date.now()) {
    const b = this.buckets.get(login.toLowerCase());
    if (!b) return { rate: 0, avg: 0, hype: 0 };
    const sec = Math.floor(now / 1000);
    let n1 = 0, n5 = 0, h1 = 0;
    for (const [s, v] of b) {
      if (s < sec - 300) { b.delete(s); continue; }
      n5 += v.n;
      if (s >= sec - 60) { n1 += v.n; h1 += v.hype; }
    }
    return { rate: n1 / 60, avg: n5 / 300, hype: h1 / 60 };
  }

  /** Feed one raw message (exposed for tests). */
  record(login: string, text: string, now = Date.now()) {
    const chan = login.toLowerCase();
    let b = this.buckets.get(chan);
    if (!b) this.buckets.set(chan, (b = new Map()));
    const sec = Math.floor(now / 1000);
    const cur = b.get(sec) ?? { n: 0, hype: 0 };
    cur.n++;
    if (HYPE.test(text)) cur.hype++;
    b.set(sec, cur);
    if (!this.since.has(chan)) this.since.set(chan, now);
    let r = this.recent.get(chan);
    if (!r) this.recent.set(chan, (r = []));
    r.push({ t: now, text: text.slice(0, 120) });
    if (r.length > 300) r.splice(0, r.length - 300);
  }

  /** Mark a channel as being listened to from `now` (the baseline needs 2 min before spikes count). */
  listen(login: string, now = Date.now()) {
    const chan = login.toLowerCase();
    if (!this.since.has(chan)) this.since.set(chan, now);
  }

  /**
   * Spike check: the last 10s of chat vs the ~5 min before it.
   * "volume" = msgs/sec >= multiplier x baseline. "hype" = a flood of hype words/emotes on a smaller bump.
   */
  spike(login: string, multiplier: number, now = Date.now()): Spike | null {
    const chan = login.toLowerCase();
    const b = this.buckets.get(chan), t0 = this.since.get(chan);
    if (!b || t0 === undefined) return null;
    const W = 10, sec = Math.floor(now / 1000), elapsed = (now - t0) / 1000;
    if (elapsed < 120) return null; // still learning what normal looks like
    const baseSpan = Math.min(290, elapsed - W);
    let n = 0, hype = 0, base = 0;
    for (const [s, v] of b) {
      if (s > sec - W) { n += v.n; hype += v.hype; }
      else if (s > sec - W - baseSpan) base += v.n;
    }
    if (n < 8) return null; // too quiet to mean anything
    const rate = n / W, baseline = base / baseSpan;
    const ratio = Math.min(99, baseline > 0 ? rate / baseline : 99);
    const out = { rate, baseline, ratio: Math.round(ratio * 10) / 10, hypeShare: Math.round((hype / n) * 100) / 100, messages: n };
    if (ratio >= multiplier) return { kind: "volume", ...out };
    if (hype >= 6 && hype / n >= 0.5 && ratio >= Math.max(1.5, multiplier / 2)) return { kind: "hype", ...out };
    return null;
  }

  /** Up to `max` chat lines from the last `secs` seconds (context for the Judge). */
  samples(login: string, secs = 20, max = 40, now = Date.now()) {
    const r = (this.recent.get(login.toLowerCase()) ?? []).filter((m) => m.t >= now - secs * 1000);
    const step = Math.max(1, Math.ceil(r.length / max));
    return r.filter((_, i) => i % step === 0).map((m) => m.text);
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      this.joined.clear();
      this.sync();
    };
    ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) { ws.send(line.replace("PING", "PONG")); continue; }
        const m = line.match(/^:[^ ]+ PRIVMSG #([^ ]+) :(.*)$/);
        if (m) this.record(m[1], m[2]);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.joined.clear();
      if (this.stopped || !this.wanted.size) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    };
    ws.onerror = () => { /* onclose handles reconnect */ };
  }

  private sync() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const join = [...this.wanted].filter((c) => !this.joined.has(c));
    const part = [...this.joined].filter((c) => !this.wanted.has(c));
    // Twitch allows 20 JOINs / 10s for anonymous connections; batch politely.
    for (let i = 0; i < join.length; i += 10) ws.send(`JOIN ${join.slice(i, i + 10).map((c) => "#" + c).join(",")}`);
    if (part.length) ws.send(`PART ${part.map((c) => "#" + c).join(",")}`);
    join.forEach((c) => { this.joined.add(c); this.listen(c); });
    part.forEach((c) => { this.joined.delete(c); this.buckets.delete(c); this.since.delete(c); this.recent.delete(c); });
  }
}
