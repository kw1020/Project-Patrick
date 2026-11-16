import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["bullmq", "ioredis", "@prisma/client"],
};
export default config;
