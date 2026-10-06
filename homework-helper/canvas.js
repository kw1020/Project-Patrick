// Reads a student's own Canvas with their personal access token (never their password),
// and gathers an assignment's instructions plus everything it links to so Patrick can do it.
import dns from "node:dns/promises";
import net from "node:net";

const MAX_ATTACHMENTS = 8;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PAGE_CHARS = 60000;
const ALLOW_PRIVATE = process.env.PATRICK_ALLOW_PRIVATE_FETCH === "1"; // local testing only

export function canvasBase(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new UserError("Enter your Canvas address, like yourschool.instructure.com");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (u.protocol !== "https:" && !ALLOW_PRIVATE) throw new UserError("Canvas address must start with https://");
  return u.origin;
}

export class UserError extends Error {}

// Block requests to the server's own network (localhost, 10.x, 192.168.x, cloud metadata, ...).
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function assertPublic(url) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new UserError(`Can't open ${url}`);
  if (ALLOW_PRIVATE) return;
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new UserError(`Can't open ${u.hostname}`);
}

// fetch that re-checks every redirect hop and caps download size.
async function safeFetch(url, headers = {}, hops = 5) {
  await assertPublic(url);
  const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    if (hops === 0) throw new UserError("Too many redirects");
    const next = new URL(res.headers.get("location"), url).href;
    // Don't leak the Canvas token to other sites (e.g. file storage redirects).
    const sameHost = new URL(next).host === new URL(url).host;
    return safeFetch(next, sameHost ? headers : {}, hops - 1);
  }
  return res;
}

async function readCapped(res) {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new UserError("File is too big");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new UserError("File is too big");
  return buf;
}

async function canvasApi(base, token, path) {
  const out = [];
  let url = `${base}/api/v1${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  for (let page = 0; url && page < 10; page++) {
    const res = await safeFetch(url, { Authorization: `Bearer ${token}` });
    if (res.status === 401) throw new UserError("Canvas didn't accept that access token. Make a new one and paste it again.");
    if (!res.ok) throw new UserError(`Canvas said ${res.status} for ${path.split("?")[0]}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    out.push(...data);
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
    url = next ? next[1] : null;
  }
  return out;
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<(td|th)[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

function linksIn(html, pageUrl) {
  const links = [];
  for (const m of String(html || "").matchAll(/<(a|img|iframe)\b[^>]*?\b(href|src)\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const href = new URL(m[3].replace(/&amp;/g, "&"), pageUrl).href;
      if (/^https?:/i.test(href)) links.push({ kind: m[1].toLowerCase(), url: href });
    } catch {}
  }
  return links;
}

// Teachers often share Google Docs/Drive links; turn them into direct downloads.
function directGoogleUrl(url) {
  let m = /docs\.google\.com\/(document|presentation)\/d\/([\w-]+)/.exec(url);
  if (m) return `https://docs.google.com/${m[1]}/d/${m[2]}/export?format=pdf`;
  m = /docs\.google\.com\/spreadsheets\/d\/([\w-]+)/.exec(url);
  if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=pdf`;
  m = /drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]+)/.exec(url);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return url;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// Turns a downloaded response into Claude content blocks (text, PDF, or image).
async function toBlocks(res, label) {
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const buf = await readCapped(res);
  if (type === "application/pdf") {
    return { blocks: [{ type: "text", text: `Attached: ${label}` }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } }] };
  }
  if (IMAGE_TYPES.includes(type)) {
    return { blocks: [{ type: "text", text: `Image: ${label}` }, { type: "image", source: { type: "base64", media_type: type, data: buf.toString("base64") } }] };
  }
  if (type.startsWith("text/") || type.includes("html") || type.includes("json")) {
    const html = buf.toString("utf8");
    let text = type.includes("html") ? htmlToText(html) : html;
    let note = null;
    if (text.length > MAX_PAGE_CHARS) {
      note = `${label} was very long, so Patrick only read the first part of it.`;
      text = text.slice(0, MAX_PAGE_CHARS);
    }
    if (/sign in|log in|password/i.test(text.slice(0, 2000)) && text.length < 3000) {
      return { blocks: [], note: `${label} needs a login, so Patrick couldn't open it. Screenshot it and add it as a photo.`, html };
    }
    return { blocks: [{ type: "text", text: `Page: ${label}\n\n${text}` }], note, html };
  }
  return { blocks: [], note: `Patrick can't read ${label} (${type || "unknown file type"}).` };
}

export async function listAssignments(canvasUrl, token) {
  const base = canvasBase(canvasUrl);
  const courses = await canvasApi(base, token, "/courses?enrollment_state=active");
  const results = await Promise.all(
    courses.filter((c) => c && c.id && c.name).map(async (c) => {
      try {
        const items = await canvasApi(base, token, `/courses/${c.id}/assignments?include[]=submission&order_by=due_at`);
        return items.map((a) => ({
          courseId: c.id,
          course: c.name,
          id: a.id,
          name: a.name,
          dueAt: a.due_at,
          missing: !!a.submission?.missing,
          done: ["submitted", "graded"].includes(a.submission?.workflow_state) && !a.submission?.missing,
        }));
      } catch {
        return [];
      }
    })
  );
  // Missing first, then by due date; hide finished work.
  return results.flat()
    .filter((a) => !a.done)
    .sort((x, y) => (y.missing - x.missing) || String(x.dueAt || "9").localeCompare(String(y.dueAt || "9")));
}

export async function gatherAssignment(canvasUrl, token, courseId, assignmentId) {
  const base = canvasBase(canvasUrl);
  const cid = encodeURIComponent(courseId);
  const a = await canvasApi(base, token, `/courses/${cid}/assignments/${encodeURIComponent(assignmentId)}`);
  const blocks = [{
    type: "text",
    text: `Canvas assignment: ${a.name}\nDue: ${a.due_at || "no due date"}\n\nInstructions from Canvas:\n${htmlToText(a.description) || "(no instructions written)"}`,
  }];
  const notes = [];
  const seen = new Set();
  let attached = 0;

  async function follow(link, depth) {
    if (attached >= MAX_ATTACHMENTS || seen.has(link.url)) return;
    seen.add(link.url);
    const u = new URL(link.url);
    const label = u.hostname + u.pathname;
    try {
      let res;
      const canvasFile = u.origin === base && /\/files\/(\d+)/.exec(u.pathname);
      const canvasPage = u.origin === base && /\/courses\/(\d+)\/pages\/([^/?#]+)/.exec(u.pathname);
      if (canvasFile) {
        const meta = await canvasApi(base, token, `/files/${canvasFile[1]}`);
        res = await safeFetch(meta.url);
      } else if (canvasPage) {
        const page = await canvasApi(base, token, `/courses/${canvasPage[1]}/pages/${canvasPage[2]}`);
        blocks.push({ type: "text", text: `Canvas page: ${page.title}\n\n${htmlToText(page.body)}` });
        attached++;
        if (depth > 0) for (const l of linksIn(page.body, link.url)) await follow(l, depth - 1);
        return;
      } else if (u.origin === base) {
        return; // other Canvas links (modules, grades, etc.) aren't homework content
      } else {
        res = await safeFetch(directGoogleUrl(link.url));
      }
      if (!res.ok) {
        notes.push(`Couldn't open ${label} (it said ${res.status}). If it needs a login, screenshot it and add it as a photo.`);
        return;
      }
      const got = await toBlocks(res, label);
      if (got.note) notes.push(got.note);
      if (got.blocks.length) { blocks.push(...got.blocks); attached++; }
      // One level deeper on the teacher's site: pick up images/files the page shows.
      if (got.html && depth > 0) {
        for (const l of linksIn(got.html, res.url || link.url)) {
          if (l.kind === "img" || /\.(pdf|png|jpe?g|gif|webp)(\?|$)/i.test(l.url) || /docs\.google|drive\.google/.test(l.url)) {
            await follow(l, depth - 1);
          }
        }
      }
    } catch (err) {
      notes.push(err instanceof UserError ? `${label}: ${err.message}` : `Couldn't open ${label}.`);
    }
  }

  for (const link of linksIn(a.description, `${base}/courses/${cid}/assignments/${assignmentId}`)) {
    await follow(link, 1);
  }
  if (attached >= MAX_ATTACHMENTS) notes.push(`This assignment links to a lot of files; Patrick read the first ${MAX_ATTACHMENTS}.`);

  blocks.push({
    type: "text",
    text: "Do this assignment. Follow the Canvas instructions exactly: only the sections, columns, and problem numbers it lists (e.g. odds only, column A only). Find those problems in the attached pages/files. Number answers to match the assignment.",
  });
  return { title: a.name, content: blocks, notes };
}
