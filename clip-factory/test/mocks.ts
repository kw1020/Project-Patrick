// Stand-in Anthropic + Google/YouTube servers for tests (no real keys or network).
import http from "node:http";

export type Mock = { url: string; requests: { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }[]; close: () => Promise<void>; verdict: Record<string, unknown> };

export async function startMocks(port = 0): Promise<Mock> {
  const mock: Mock = {
    url: "", requests: [], close: async () => {},
    verdict: { score: 8.4, hook_text: "He jumped the bridge?!", title: "Impossible bridge jump in GTA 6", hashtags: ["GTA6", "#gaming", "vice city", "GTA6"], reason: "Clear payoff and chat exploded." },
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks), path = req.url || "/";
      mock.requests.push({ method: req.method || "", path, headers: req.headers, body });
      const json = (code: number, obj: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };

      if (path.startsWith("/v1/messages")) {
        const text = JSON.parse(body.toString()).messages[0].content as string;
        const verdict = text.includes("(no speech detected)") && text.includes("viewer made") && text.includes(", 600 views") ? { ...mock.verdict, score: 3, reason: "Nothing happens and the audience was flat." } : mock.verdict;
        return json(200, { id: "msg_mock", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
          content: [{ type: "text", text: JSON.stringify(verdict) }], usage: { input_tokens: 10, output_tokens: 10 } });
      }
      if (path.startsWith("/token")) return json(200, { access_token: "ya29.mock", refresh_token: "1//mock-refresh", expires_in: 3600 });
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
    YOUTUBE_CLIENT_ID: "mock-client", YOUTUBE_CLIENT_SECRET: "mock-secret",
    GOOGLE_OAUTH_URL: `${url}/auth`, GOOGLE_TOKEN_URL: `${url}/token`, YOUTUBE_API_URL: `${url}/youtube/v3`, YOUTUBE_UPLOAD_URL: `${url}/upload/youtube/v3/videos`,
  };
}

// `npx tsx test/mocks.ts 4010` runs the mocks standalone (for trying the dashboard without real keys).
if (process.argv[1]?.endsWith("mocks.ts") && process.argv[2]) {
  startMocks(Number(process.argv[2])).then((m) => console.log(`mock services on ${m.url}\n` + Object.entries(mockEnv(m.url)).map(([k, v]) => `${k}=${v}`).join("\n")));
}
