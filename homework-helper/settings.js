// Keys Patrick needs (Anthropic, Canvas, more later), saved on this computer only.
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const FILE = path.join(DATA_DIR, "settings.json");

export function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveSettings(changes) {
  const next = { ...loadSettings() };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === "") delete next[k];
    else next[k] = v;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function anthropicKey() {
  return loadSettings().anthropicKey || process.env.ANTHROPIC_API_KEY || "";
}

// Shows "…AQAA" so you can tell which key is saved without showing the whole thing.
export function hint(secret) {
  return secret ? "…" + secret.slice(-4) : "";
}
