// v1.9.6: read the text between the `## SYSTEM` and `## END SYSTEM` lines of a prompts/*.md file (same format as prompts/judge.md).
import fs from "node:fs";
import path from "node:path";

export function systemBlock(src: string, file: string): string {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "## SYSTEM");
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === "## END SYSTEM");
  if (start < 0 || end < 0) throw new Error(`${file}: missing "## SYSTEM" / "## END SYSTEM" markers`);
  const block = lines.slice(start + 1, end).join("\n").trim();
  if (!block) throw new Error(`${file}: the SYSTEM block is empty`);
  return block;
}

export function loadPromptFile(file: string): string {
  const candidates = [path.join(process.cwd(), file)];
  if (typeof __dirname === "string") candidates.push(path.resolve(__dirname, "../..", file));
  for (const f of candidates) {
    try { return systemBlock(fs.readFileSync(f, "utf8"), file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  throw new Error(`Prompt file ${file} not found (looked in: ${candidates.join(", ")})`);
}
