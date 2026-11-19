// Stand-in Anthropic + Google/YouTube + TikTok + Twitch servers for tests (no real keys or network).
import http from "node:http";

export type Mock = { tiktokStatus: Record<string, unknown>; refreshCount: number; url: string; requests: { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }[]; close: () => Promise<void>; verdict: Record<string, unknown>;
  followers: Record<string, number>; // v1.9.5: Helix /channels/followers totals by broadcaster_id (missing = 1000)
  /** v1.9.6: what the stand-in Claude returns for Supreme (claude-opus-5-5) and QA (image) requests. */
  supreme: Record<string, unknown>; qa: Record<string, unknown>; supremeStop: string; usage: { input_tokens: number; output_tokens: number };
};

export async function startMocks(port = 0): Promise<Mock> {
  const mock: Mock = {
    url: "", requests: [], close: async () => {}, refreshCount: 0,
    tiktokStatus: { status: "SEND_TO_USER_INBOX", publicaly_available_post_id: [] },
    verdict: { observations: "He drives off the bridge and lands on a moving truck; he screams and chat explodes.", score: 8.4, hook_text: "He jumped the bridge?!", title: "Impossible bridge jump in GTA 6", hashtags: ["GTA6", "#gaming", "vice city", "GTA6"], reason: "Clear payoff and chat exploded.", category: "gaming", extra_hashtags: ["GTA6Clips"], best_start: null, best_end: null, hook_lands: true, payoff_in_window: true, payoff_at: 12, payoff: "He jumps the bridge and lands on a moving truck" },
    followers: {},
    supreme: { picks: [] }, qa: { ok: true, issues: [] }, supremeStop: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks), path = req.url || "/";
      mock.requests.push({ method: req.method || "", path, headers: req.headers, body });
      const json = (code: number, obj: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };

      if (path.startsWith("/v1/messages")) {
        // v1.9.4: content is a string (text only) or blocks ("[frame at Xs]" text + image per frame, then the text).
        const req = JSON.parse(body.toString());
        const reply = (model: string, obj: unknown, stop = "end_turn") => json(200, { id: "msg_mock", type: "message", role: "assistant", model, stop_reason: stop, stop_sequence: null,
          content: stop === "refusal" ? [] : [{ type: "text", text: JSON.stringify(obj) }], usage: mock.usage });
        // v1.9.6: the Supreme Judge (Opus).
        if (req.model === "claude-opus-5-5") return reply(req.model, mock.supreme, mock.supremeStop);
        const content = req.messages[0].content as string | { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[];
        const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
        if (blocks.some((b) => b.type === "image" && (b.source?.type !== "base64" || b.source?.media_type !== "image/jpeg" || !b.source?.data))) return json(400, { type: "error", error: { type: "invalid_request_error", message: "mock: bad image block" } });
        // v1.9.6: the Supreme Judge's video check (its own system prompt; the per-clip Judge sends frames too since v1.9.4).
        if (JSON.stringify(req.system ?? "").includes("You check finished vertical clips")) return reply(req.model, mock.qa);
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
        const images = blocks.filter((b) => b.type === "image").length;
        const verdict = text.includes("(no speech detected)") && text.includes("viewer made") && text.includes(", 600 views") ? { ...mock.verdict, score: 3, reason: "Nothing happens and the audience was flat." } : mock.verdict;
        return json(200, { id: "msg_mock", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
          content: [{ type: "text", text: JSON.stringify(verdict) }], usage: { input_tokens: 1200 + images * 330, output_tokens: 400, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 } });
      }
      // ---- TikTok ----
      const tt = (data: unknown) => json(200, { data, error: { code: "ok", message: "", log_id: "x" } });
      if (path.startsWith("/v2/oauth/token/")) {
        const f = new URLSearchParams(body.toString());
        if (f.get("grant_type") === "refresh_token") mock.refreshCount++;
        return json(200, { access_token: `act.mock${mock.refreshCount}`, refresh_token: `rft.mock${mock.refreshCount}`, expires_in: 7200, open_id: "open-123", scope: "user.info.basic,user.info.profile,video.upload,video.list", token_type: "Bearer" });
      }
      if (path.startsWith("/v2/user/info/")) return tt({ user: { open_id: "open-123", display_name: "Krew", username: "krewclips" } });
      if (path.startsWith("/v2/post/publish/inbox/video/init/")) return tt({ publish_id: "v_inbox_file~v2.1", upload_url: `${mock.url}/tt-upload/1` });
      if (path.startsWith("/tt-upload/")) { res.writeHead(201); return res.end(); }
      if (path.startsWith("/v2/post/publish/status/fetch/")) return tt(mock.tiktokStatus);
      if (path.startsWith("/v2/video/query/")) return tt({ videos: [{ id: "7300000000000000001", view_count: 12000, like_count: 900, comment_count: 40 }] });

      // ---- Twitch (client-credentials token + Helix) ----
      if (path.startsWith("/oauth2/token") && req.method === "POST") {
        const f = new URLSearchParams(body.toString());
        // v1.9.5: the user-token flow (authorization code + refresh) gets a refresh token; the app token doesn't.
        if (f.get("grant_type") === "authorization_code") return json(f.get("code") === "bad" ? 400 : 200, f.get("code") === "bad" ? { status: 400, message: "Invalid authorization code" } : { access_token: "twitch-user-token", refresh_token: "twitch-user-refresh", expires_in: 14000, scope: ["moderator:read:followers"], token_type: "bearer" });
        if (f.get("grant_type") === "refresh_token") return json(200, { access_token: "twitch-user-token2", refresh_token: "twitch-user-refresh2", expires_in: 14000, token_type: "bearer" });
        return json(200, { access_token: "twitch-mock-token", expires_in: 5000000, token_type: "bearer" });
      }
      if (path.startsWith("/helix/")) {
        const u = new URL(path, "http://x"), ep = u.pathname.slice("/helix".length);
        const gta = { id: "1234567", name: "Grand Theft Auto VI", box_art_url: "", igdb_id: "" };
        const now = new Date().toISOString();
        if (ep === "/games") return json(200, { data: u.searchParams.getAll("name").some((n) => /grand theft auto (vi|6)/i.test(n)) ? [gta] : [] });
        if (ep === "/search/categories") return json(200, { data: [gta], pagination: {} });
        if (ep === "/streams") return json(200, { data: [
          { id: "s1", user_id: "u1", user_login: "kai", user_name: "Kai", game_id: gta.id, type: "live", title: "GTA 6 day one", viewer_count: 12000, started_at: now, thumbnail_url: "" },
          { id: "s2", user_id: "u2", user_login: "mira", user_name: "Mira", game_id: gta.id, type: "live", title: "Vice City heists", viewer_count: 800, started_at: now, thumbnail_url: "" },
        ], pagination: {} });
        if (ep === "/clips") return json(200, { data: [
          { id: "ClipOne", url: "https://clips.twitch.tv/ClipOne", broadcaster_id: "u1", broadcaster_name: "Kai", creator_name: "fan1", video_id: "", game_id: gta.id, title: "bridge jump", view_count: 5400, created_at: now, thumbnail_url: "", duration: 28.5, vod_offset: null },
          { id: "ClipTwo", url: "https://clips.twitch.tv/ClipTwo", broadcaster_id: "u2", broadcaster_name: "Mira", creator_name: "fan2", video_id: "", game_id: gta.id, title: "cops lol", view_count: 300, created_at: now, thumbnail_url: "", duration: 40, vod_offset: null },
        ], pagination: {} });
        if (ep === "/channels/followers") {
          if (!String(req.headers.authorization).startsWith("Bearer twitch-user-token")) return json(401, { error: "Unauthorized", status: 401, message: "user token required" });
          const b = u.searchParams.get("broadcaster_id") || "";
          return json(200, { total: mock.followers[b] ?? 1000, data: [], pagination: {} });
        }
        if (ep === "/users" && !u.searchParams.has("login") && !u.searchParams.has("id") && String(req.headers.authorization).startsWith("Bearer twitch-user-token"))
          return json(200, { data: [{ id: "krew-tw-1", login: "krewclips", display_name: "KrewClips", profile_image_url: "" }] });
        if (ep === "/users") return json(200, { data: [...u.searchParams.getAll("login"), ...u.searchParams.getAll("id")].map((x, i) => ({ id: `u${i + 1}`, login: x.toLowerCase(), display_name: x, profile_image_url: "" })) });
        return json(404, { error: "Not Found", status: 404, message: "mock: no helix " + ep });
      }
      if (path.startsWith("/token")) return json(200, { access_token: "ya29.mock", refresh_token: "1//mock-refresh", expires_in: 3600 });
      // ---- YouTube Data API with a plain API key (Suggestions): trending chart + channel details ----
      if (path.startsWith("/youtube/v3/") && new URL(path, "http://x").searchParams.get("key")) {
        const u = new URL(path, "http://x");
        if (u.pathname === "/youtube/v3/videos" && u.searchParams.get("chart") === "mostPopular") return json(200, { items: [
          { id: "trend1", snippet: { channelId: "UCbig", title: "I survived 100 days in GTA 6" }, statistics: { viewCount: "8100000" } },
          { id: "trend2", snippet: { channelId: "UCmid", title: "Vice City speedrun" }, statistics: { viewCount: "450000" } },
        ] });
        if (u.pathname === "/youtube/v3/channels" && u.searchParams.get("id")) {
          const all: Record<string, unknown> = {
            UCbig: { id: "UCbig", snippet: { title: "Big Channel", customUrl: "@bigchannel", description: "Clips welcome! Join the clipping program", thumbnails: { default: { url: "" } } }, statistics: { subscriberCount: "12400000", viewCount: "3000000000", videoCount: "800" } },
            UCmid: { id: "UCmid", snippet: { title: "Mid Channel", customUrl: "@midchannel", description: "Gaming videos", thumbnails: {} }, statistics: { subscriberCount: "250000", viewCount: "40000000", videoCount: "300" } },
          };
          return json(200, { items: u.searchParams.get("id")!.split(",").map((id) => all[id]).filter(Boolean) });
        }
      }
      if (path.startsWith("/youtube/v3/channels")) return json(200, { items: [{ id: "UCmock", snippet: { title: "Krew Clips (mock)" } }] });
      if (path.startsWith("/youtube/v3/videos")) return json(200, { items: [{ id: "vid123", statistics: { viewCount: "4321" } }] });
      if (path.startsWith("/upload") && req.method === "POST") return json(200, {}, { Location: `${mock.url}/upload-session/abc` });
      if (path.startsWith("/upload-session") && req.method === "PUT") return json(200, { id: "vid123" });
      json(404, { error: { message: "mock: not found " + path } });
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  mock.url = `http://127.0.0.1:${addr.port}`;
  mock.close = () => new Promise((r) => server.close(() => r()));
  return mock;
}

export function mockEnv(url: string) {
  return {
    ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "sk-ant-mock",
    TIKTOK_CLIENT_KEY: "mock-key", TIKTOK_CLIENT_SECRET: "mock-secret", TIKTOK_AUTH_URL: `${url}/tt-auth`, TIKTOK_API_URL: url,
    YOUTUBE_API_KEY: "mock-yt-key", YOUTUBE_CLIENT_ID: "mock-client", YOUTUBE_CLIENT_SECRET: "mock-secret",
    GOOGLE_OAUTH_URL: `${url}/auth`, GOOGLE_TOKEN_URL: `${url}/token`, YOUTUBE_API_URL: `${url}/youtube/v3`, YOUTUBE_UPLOAD_URL: `${url}/upload/youtube/v3/videos`,
    TWITCH_CLIENT_ID: "mock-twitch-id", TWITCH_CLIENT_SECRET: "mock-twitch-secret", TWITCH_API_URL: `${url}/helix`, TWITCH_AUTH_URL: `${url}/oauth2/token`,
  };
}

// `npx tsx test/mocks.ts 4010` runs the mocks standalone (for trying the dashboard without real keys).
if (process.argv[1]?.endsWith("mocks.ts") && process.argv[2]) {
  startMocks(Number(process.argv[2])).then((m) => console.log(`mock services on ${m.url}\n` + Object.entries(mockEnv(m.url)).map(([k, v]) => `${k}=${v}`).join("\n")));
}
