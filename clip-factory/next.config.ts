import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["bullmq", "ioredis", "@prisma/client"],
  // src/lib/judge.ts reads prompts/judge.md at runtime; keep it in the traced server output.
  outputFileTracingIncludes: { "/**": ["./prompts/**/*"] },
};
export default config;
