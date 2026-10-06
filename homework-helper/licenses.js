// Locks each access code to one device and caps daily questions,
// so a customer can't share their code with friends.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const FILE = path.join(DATA_DIR, "licenses.json");

export const DAILY_LIMIT = Number(process.env.PATRICK_DAILY_LIMIT || 40);

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function newDeviceId() {
  return crypto.randomBytes(24).toString("hex");
}

// Returns { ok: true } or { ok: false, status, error }.
// Pass count: false to only check the device lock (e.g. loading Canvas assignments).
export function checkAndCount(code, deviceId, { count = true } = {}) {
  const data = load();
  const today = new Date().toISOString().slice(0, 10);
  const lic = data[code] || (data[code] = {});

  if (!lic.deviceId) {
    lic.deviceId = deviceId;
    lic.boundAt = new Date().toISOString();
  } else if (lic.deviceId !== deviceId) {
    return {
      ok: false,
      status: 403,
      error: "This code is already being used on another device. Each code works on one device only.",
    };
  }

  if (!count) {
    save(data);
    return { ok: true };
  }
  if (lic.day !== today) {
    lic.day = today;
    lic.count = 0;
  }
  if (lic.count >= DAILY_LIMIT) {
    return { ok: false, status: 429, error: `You've hit today's limit of ${DAILY_LIMIT} questions. It resets tomorrow.` };
  }
  lic.count++;
  save(data);
  return { ok: true };
}

// Unlock a code so it can be used on a new device (e.g. customer got a new phone).
export function resetCode(code) {
  const data = load();
  if (!data[code]) return false;
  delete data[code].deviceId;
  save(data);
  return true;
}
