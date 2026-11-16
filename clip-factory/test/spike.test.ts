import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatHeat, parseIrc, type ChatClock, type ChatSocket } from "../src/lib/chat";

const T0 = 2_000_000_000_000;
const at = (s: number) => T0 + s * 1000;

/** Raw Twitch IRC lines, as they arrive with the tags/commands caps. */
const privmsg = (chan: string, user: string, text: string) =>
  `@badge-info=;badges=;color=#1E90FF;display-name=${user};emotes=;first-msg=0;flags=;id=0b8c-${user};mod=0;room-id=1234;subscriber=0;tmi-sent-ts=1700000000000;turbo=0;user-id=99;user-type= :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG #${chan} :${text}`;
const raidLine = (chan: string) =>
  `@badge-info=;badges=;color=;display-name=BigRaider;emotes=;flags=;id=3d1a;login=bigraider;mod=0;msg-id=raid;msg-param-displayName=BigRaider;msg-param-login=bigraider;msg-param-viewerCount=2500;room-id=1234;subscriber=0;system-msg=2500\\sraiders\\sfrom\\sBigRaider\\shave\\sjoined!;tmi-sent-ts=1700000000000;user-id=55;user-type= :tmi.twitch.tv USERNOTICE #${chan}`;
const giftLine = (chan: string, count: number) =>
  `@badge-info=subscriber/3;badges=subscriber/3;color=;display-name=Gifter;emotes=;flags=;id=77aa;login=gifter;mod=0;msg-id=submysterygift;msg-param-mass-gift-count=${count};msg-param-origin-id=abc;msg-param-sender-count=40;msg-param-sub-plan=1000;room-id=1234;subscriber=1;system-msg=Gifter\\sis\\sgifting\\s${count}\\sTier\\s1\\sSubs!;tmi-sent-ts=1700000000000;user-id=66;user-type= :tmi.twitch.tv USERNOTICE #${chan}`;

/** 2 msgs/s spread over a pool of 30 chatters (nobody hits the per-user cap). */
function steady(c: ChatHeat, from: number, to: number, perSec = 2) {
  let i = 0;
  for (let s = from; s < to; s++) for (let k = 0; k < perSec; k++) c.handleLine(privmsg("s", `regular${i++ % 30}`, "hello chat"), at(s) + k * 100);
}
/** A flood of `perSec` msgs/s, each from a fresh chatter. */
function flood(c: ChatHeat, from: number, to: number, perSec: number, text = "what happened") {
  for (let s = from; s < to; s++) for (let k = 0; k < perSec; k++) c.handleLine(privmsg("s", `viewer_${s}_${k}`, text), at(s) + k * 50);
}

test("parseIrc reads tags, prefix, command, channel and text", () => {
  const m = parseIrc(privmsg("kai", "someone", "clip it :) ok"))!;
  assert.equal(m.command, "PRIVMSG");
  assert.equal(m.prefix.split("!")[0], "someone");
  assert.deepEqual(m.params, ["#kai"]);
  assert.equal(m.text, "clip it :) ok");
  const r = parseIrc(raidLine("kai"))!;
  assert.equal(r.tags["msg-id"], "raid");
  assert.equal(r.tags["system-msg"], "2500 raiders from BigRaider have joined!");
});

test("steady chat → no spike", () => {
  const c = new ChatHeat();
  steady(c, 0, 310);
  for (const s of [130, 200, 309.5]) assert.equal(c.spike("s", 3, at(s)), null, `at ${s}s`);
});

test("3x real distinct chatters → volume spike", () => {
  const c = new ChatHeat();
  steady(c, 0, 300);
  flood(c, 300, 310, 7);
  const sp = c.spike("s", 3, at(309.5));
  assert.ok(sp && sp.kind === "volume", JSON.stringify(sp));
  assert.equal(sp.baseline, 2);
  assert.ok(sp.ratio >= 3 && sp.ratio < 4, `ratio ${sp.ratio}`);
  assert.equal(sp.chatters, 70);
});

test("one user spamming 50 msgs → no spike (capped at 2 per 10s)", () => {
  const c = new ChatHeat();
  steady(c, 0, 310);
  for (let i = 0; i < 50; i++) c.handleLine(privmsg("s", "spammer", "OMEGALUL OMEGALUL"), at(300) + i * 190);
  assert.equal(c.spike("s", 3, at(309.5)), null);
  // record() with an explicit user is capped the same way
  assert.equal(c.record("s", "again", at(309.6), "spammer"), false);
});

test("bot names and !commands flood → no spike", () => {
  const c = new ChatHeat();
  steady(c, 0, 310);
  for (let i = 0; i < 100; i++) {
    const bot = ["nightbot", "streamelements", "StreamLabs", "moobot", "fossabot", "wizebot", "sery_bot", "soundalerts", "botrixoficial", "kofistreambot", "s"][i % 11];
    c.handleLine(privmsg("s", bot, "Follow the streamer! KEKW"), at(300) + i * 90);
    c.handleLine(privmsg("s", `viewer${i}`, "!drop"), at(300) + i * 90 + 10);
  }
  assert.equal(c.spike("s", 3, at(309.5)), null);
  assert.ok(c.samples("s", 10, 400, at(309.5)).every((t) => t === "hello chat"), "bots/commands stay out of Judge samples");
});

test("raid notice then flood → no spike for 120s, spike possible after", () => {
  const c = new ChatHeat();
  steady(c, 0, 300);
  c.handleLine(raidLine("s"), at(300));
  flood(c, 300, 430, 10, "RAID HYPE");
  for (const s of [309.5, 360, 400, 419.5]) assert.equal(c.spike("s", 3, at(s)), null, `muted at ${s}s`);
  const sp = c.spike("s", 3, at(429.5));
  assert.ok(sp && sp.kind === "volume", JSON.stringify(sp));
  assert.equal(sp.baseline, 2, "raid windows stay out of the baseline");
});

test("gift bomb (submysterygift x10) → muted 60s", () => {
  const c = new ChatHeat();
  steady(c, 0, 300);
  c.handleLine(giftLine("s", 10), at(300));
  flood(c, 300, 310, 10, "thanks for the gift");
  assert.equal(c.spike("s", 3, at(309.5)), null);
  assert.ok(c.muted("s", at(359)) && !c.muted("s", at(360.1)));
  flood(c, 360, 370, 10);
  const sp = c.spike("s", 3, at(369.5));
  assert.ok(sp && sp.kind === "volume", JSON.stringify(sp));
  // a small gift (count 2) doesn't mute
  const q = new ChatHeat();
  steady(q, 0, 300);
  q.handleLine(giftLine("s", 2), at(300));
  flood(q, 300, 310, 10);
  assert.ok(q.spike("s", 3, at(309.5)));
});

test("sub train (3 sub notices in 30s) → muted 60s", () => {
  const c = new ChatHeat();
  steady(c, 0, 300);
  for (const [i, id] of ["sub", "resub", "subgift"].entries())
    c.handleLine(`@msg-id=${id};login=fan${i} :tmi.twitch.tv USERNOTICE #s :love the stream`, at(290 + i * 5));
  flood(c, 300, 310, 10);
  assert.equal(c.spike("s", 3, at(309.5)), null);
  assert.ok(c.muted("s", at(359)) && !c.muted("s", at(360.1)), "60s from the 3rd notice");
});

test("hype flood from ≥4 users → hype spike; from 3 users → none", () => {
  const c = new ChatHeat();
  steady(c, 0, 300);
  const msgs = ["KEKW", "LMAOOO", "clip it", "W"];
  for (let s = 300; s < 310; s++) for (let k = 0; k < 4; k++) c.handleLine(privmsg("s", `hyper${(s * 4 + k) % 20}`, msgs[k]), at(s) + k * 100);
  const sp = c.spike("s", 3, at(309.5));
  assert.ok(sp && sp.kind === "hype" && sp.hypeShare === 1, JSON.stringify(sp));

  const q = new ChatHeat();
  steady(q, 0, 300, 1);
  for (let s = 300; s < 310; s++) for (let k = 0; k < 4; k++) q.handleLine(privmsg("s", `hyper${k % 3}`, "KEKW"), at(s) + k * 100);
  assert.equal(q.spike("s", 3, at(309.5)), null);
});

test("setChannels(40) → JOINs in batches ≤15, ≥10s apart; PING → PONG; chat flows through the socket", () => {
  let now = T0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const clock: ChatClock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift()!;
      now = t.at;
      t.fn();
    }
    now = end;
  };
  const sent: { t: number; line: string }[] = [];
  let sock!: ChatSocket;
  const c = new ChatHeat({
    clock,
    socket: () => (sock = { readyState: 0, send: (l) => sent.push({ t: now, line: l }), close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
  });
  const chans = Array.from({ length: 40 }, (_, i) => `Streamer${i}`);
  c.setChannels(chans);
  sock.readyState = 1;
  sock.onopen!();
  assert.equal(sent[0].line, "CAP REQ :twitch.tv/tags twitch.tv/commands");
  assert.equal(sent[1].line, "PASS SCHMOOPIIE");
  assert.match(sent[2].line, /^NICK justinfan\d+$/);
  advance(60_000);
  c.setChannels(chans); // a later Scout tick doesn't re-join or bypass the throttle
  advance(30_000);

  const joins = sent.filter((s) => s.line.startsWith("JOIN "));
  assert.equal(joins.length, 3);
  const joined = joins.flatMap((j) => j.line.slice(5).split(","));
  assert.equal(joined.length, 40);
  assert.deepEqual(new Set(joined), new Set(chans.map((c) => "#" + c.toLowerCase())));
  for (const j of joins) assert.ok(j.line.slice(5).split(",").length <= 15, j.line);
  for (let i = 1; i < joins.length; i++) assert.ok(joins[i].t - joins[i - 1].t >= 10_000, `gap ${joins[i].t - joins[i - 1].t}`);

  sock.onmessage!({ data: "PING :tmi.twitch.tv\r\n" + privmsg("streamer3", "fan", "KEKW") + "\r\n" });
  assert.equal(sent.at(-1)!.line, "PONG :tmi.twitch.tv");
  assert.deepEqual(c.samples("streamer3", 5, 10, now), ["KEKW"]);

  // dropping channels PARTs them right away
  c.setChannels(chans.slice(0, 39));
  assert.equal(sent.at(-1)!.line, "PART #streamer39");
  c.stop();
});
