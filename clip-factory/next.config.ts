import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["bullmq", "ioredis", "@prisma/client"],
  // src/lib/judge.ts reads prompts/judge.md and src/lib/version.ts reads CHANGELOG.md at runtime;
  // keep both in the traced server output.
  outputFileTracingIncludes: { "/**": ["./prompts/**/*", "./CHANGELOG.md"] },
};
export default config;
