// Runs once when the Next.js server starts: put the shared SQLite file in WAL mode before any web write.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureSqliteTuned } = await import("./src/lib/db");
  await ensureSqliteTuned().catch((e) => console.error("[db] SQLite tuning failed:", (e as Error).message));
}
