// Patrick site builder: turns a client profile (clients/<slug>.json) into a
// one-page website at out/<slug>/index.html. No dependencies, no build step.
//
//   node build.js joes-lawn-care    build one site
//   node build.js                   build every site in clients/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENTS = path.join(here, "clients");
const OUT = path.join(here, "out");

const REQUIRED = ["name", "type", "city", "phone", "services"];

export function validate(p) {
  const missing = REQUIRED.filter((k) => p[k] == null || p[k] === "" || (Array.isArray(p[k]) && !p[k].length));
  if (missing.length) throw new Error(`Missing required field(s): ${missing.join(", ")}`);
  if (p.accent && !/^#[0-9a-f]{6}$/i.test(p.accent)) throw new Error("accent must be a 6-digit hex color like #1a6fd1");
  for (const s of p.services) if (!s.name) throw new Error("Every service needs a name");
}

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const digits = (phone) => String(phone).replace(/[^\d+]/g, "");

/** Black or white, whichever reads better on the accent color. */
export function inkOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.4 ? "#111111" : "#ffffff";
}

function jsonLd(p) {
  const data = {
    "@context": "https://schema.org",
    "@type": p.schemaType || "LocalBusiness",
    name: p.name,
    description: p.subhead || `${p.type} in ${p.city}`,
    telephone: p.phone,
    ...(p.email && { email: p.email }),
    ...(p.url && { url: p.url }),
    ...(p.address && { address: p.address }),
    areaServed: p.areas?.length ? p.areas : p.city,
    ...(p.hours?.length && { openingHours: p.hours.map(([d, t]) => `${d} ${t}`) }),
    ...(p.social && { sameAs: Object.values(p.social).filter(Boolean) }),
  };
  // Escape "<" so a value can never close the script tag.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

const section = (id, title, body) =>
  `<section id="${id}"><div class="wrap"><h2>${esc(title)}</h2>${body}</div></section>`;

export function render(p) {
  validate(p);
  const accent = p.accent || "#1a6fd1";
  const tel = digits(p.phone);
  const headline = p.headline || `${p.city}'s go-to ${p.type.toLowerCase()}`;
  const subhead = p.subhead || `Call or text for a free quote. Serving ${p.city} and nearby.`;
  const desc = `${p.name}: ${p.type} in ${p.city}. ${subhead}`.slice(0, 160);

  const services = p.services
    .map(
      (s) => `<div class="card"><h3>${esc(s.name)}</h3>${s.desc ? `<p>${esc(s.desc)}</p>` : ""}${
        s.price ? `<p class="price">${esc(s.price)}</p>` : ""
      }</div>`,
    )
    .join("");

  const about = p.about ? section("about", p.aboutTitle || `About ${p.name}`, `<p class="lead">${esc(p.about)}</p>`) : "";

  const points = p.points?.length
    ? `<ul class="points">${p.points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : "";

  const areas = p.areas?.length
    ? section("areas", "Areas we serve", `<ul class="tags">${p.areas.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`)
    : "";

  // Only real reviews the client has given permission to use. Never invent these.
  const reviews = p.reviews?.length
    ? section(
        "reviews",
        "What customers say",
        `<div class="grid">${p.reviews
          .map((r) => `<figure class="card"><blockquote>“${esc(r.quote)}”</blockquote><figcaption>${esc(r.name)}</figcaption></figure>`)
          .join("")}</div>`,
      )
    : "";

  const faq = p.faq?.length
    ? section(
        "faq",
        "Questions",
        p.faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join(""),
      )
    : "";

  const hours = p.hours?.length
    ? `<table class="hours">${p.hours.map(([d, t]) => `<tr><th>${esc(d)}</th><td>${esc(t)}</td></tr>`).join("")}</table>`
    : "";

  const map = p.address
    ? `<iframe class="map" title="Map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=${encodeURIComponent(
        p.address,
      )}&output=embed"></iframe>`
    : "";

  const form = p.formAction
    ? `<form class="card quote" method="POST" action="${esc(p.formAction)}">
        <h3>Get a free quote</h3>
        <label>Name<input name="name" required autocomplete="name"></label>
        <label>Phone<input name="phone" type="tel" required autocomplete="tel"></label>
        <label>What do you need?<textarea name="message" rows="3" required></textarea></label>
        <button class="btn" type="submit">Send</button>
      </form>`
    : "";

  const social = p.social
    ? Object.entries(p.social)
        .filter(([, url]) => url)
        .map(([k, url]) => `<a href="${esc(url)}" rel="noopener">${esc(k[0].toUpperCase() + k.slice(1))}</a>`)
        .join(" · ")
    : "";

  const contactLines = [
    `<p><a class="big" href="tel:${tel}">${esc(p.phone)}</a></p>`,
    p.email && `<p><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></p>`,
    p.address && `<p>${esc(p.address)}</p>`,
    p.license && `<p class="muted">${esc(p.license)}</p>`,
  ]
    .filter(Boolean)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.name)} | ${esc(p.type)} in ${esc(p.city)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(p.name)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
${p.url ? `<link rel="canonical" href="${esc(p.url)}">` : ""}
<meta name="theme-color" content="${accent}">
<script type="application/ld+json">${jsonLd(p)}</script>
<style>
:root{--accent:${accent};--ink-on-accent:${inkOn(accent)};--bg:#ffffff;--soft:#f4f6f8;--text:#14181f;--muted:#5b6573;--line:#e3e7ec}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--bg);padding-bottom:72px}
a{color:var(--accent)}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.95);backdrop-filter:blur(6px);border-bottom:1px solid var(--line)}
header .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;height:62px}
.logo{font-weight:800;font-size:19px;color:var(--text);text-decoration:none}
nav a{color:var(--muted);text-decoration:none;margin-left:18px;font-size:15px}
.btn{display:inline-block;background:var(--accent);color:var(--ink-on-accent);padding:13px 22px;border-radius:10px;font-weight:700;text-decoration:none;border:0;font-size:16px;cursor:pointer}
.btn.ghost{background:transparent;color:var(--accent);box-shadow:inset 0 0 0 2px var(--accent)}
.hero{background:linear-gradient(160deg,var(--soft),#fff);padding:72px 0 64px}
.hero h1{font-size:clamp(32px,6vw,54px);line-height:1.1;margin:0 0 14px;max-width:16ch}
.hero p{font-size:20px;color:var(--muted);max-width:42ch;margin:0 0 26px}
.ctas{display:flex;gap:12px;flex-wrap:wrap}
.points{list-style:none;padding:0;margin:28px 0 0;display:flex;flex-wrap:wrap;gap:10px 22px;color:var(--muted)}
.points li::before{content:"✓ ";color:var(--accent);font-weight:800}
section{padding:60px 0;border-top:1px solid var(--line)}
h2{font-size:30px;margin:0 0 22px}
h3{margin:0 0 6px;font-size:19px}
.grid,#services .wrap>div{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.card{background:var(--soft);border-radius:14px;padding:20px;margin:0}
.card p{margin:0;color:var(--muted)}
.price{margin-top:10px!important;color:var(--text)!important;font-weight:700}
.lead{font-size:19px;max-width:65ch}
.tags{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px}
.tags li{background:var(--soft);padding:6px 14px;border-radius:999px}
blockquote{margin:0 0 10px;font-size:17px}
figcaption{color:var(--muted);font-size:15px}
details{border-bottom:1px solid var(--line);padding:14px 0}
summary{font-weight:700;cursor:pointer}
details p{color:var(--muted);margin:8px 0 0}
.contact{display:grid;gap:24px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));align-items:start}
.big{font-size:26px;font-weight:800;text-decoration:none}
.muted{color:var(--muted);font-size:15px}
.hours{border-collapse:collapse;margin-top:10px}
.hours th{text-align:left;font-weight:600;padding:4px 18px 4px 0}
.hours td{color:var(--muted)}
.map{width:100%;height:260px;border:0;border-radius:14px;margin-top:16px}
.quote label{display:block;font-size:14px;color:var(--muted);margin:12px 0 0}
.quote input,.quote textarea{display:block;width:100%;margin-top:4px;padding:11px;font:inherit;border:1px solid var(--line);border-radius:8px;background:#fff}
.quote .btn{margin-top:16px;width:100%}
footer{padding:28px 0;color:var(--muted);font-size:14px;border-top:1px solid var(--line)}
.callbar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:8px;padding:10px 12px;background:#fff;border-top:1px solid var(--line);z-index:6}
.callbar .btn{flex:1;text-align:center;padding:12px}
@media(min-width:760px){.callbar{display:none}body{padding-bottom:0}}
@media(max-width:640px){nav a:not(.btn){display:none}.hero{padding:48px 0}}
</style>
</head>
<body>
<header><div class="wrap">
  <a class="logo" href="#top">${esc(p.name)}</a>
  <nav><a href="#services">Services</a>${p.reviews?.length ? `<a href="#reviews">Reviews</a>` : ""}<a href="#contact">Contact</a><a class="btn" href="tel:${tel}" style="margin-left:18px;padding:9px 16px">Call</a></nav>
</div></header>

<main id="top">
<div class="hero"><div class="wrap">
  <h1>${esc(headline)}</h1>
  <p>${esc(subhead)}</p>
  <div class="ctas">
    <a class="btn" href="tel:${tel}">Call ${esc(p.phone)}</a>
    <a class="btn ghost" href="sms:${tel}">Text us</a>
  </div>
  ${points}
</div></div>

${section("services", p.servicesTitle || "Services", `<div>${services}</div>`)}
${about}
${reviews}
${areas}
${faq}
<section id="contact"><div class="wrap">
  <h2>Get in touch</h2>
  <div class="contact">
    <div>${contactLines}${hours}${map}</div>
    ${form}
  </div>
</div></section>
</main>

<footer><div class="wrap">© ${new Date().getFullYear()} ${esc(p.name)} · ${esc(p.city)}${social ? ` · ${social}` : ""}</div></footer>
<div class="callbar"><a class="btn" href="tel:${tel}">Call</a><a class="btn ghost" href="sms:${tel}">Text</a></div>
</body>
</html>
`;
}

export function build(slug) {
  const profile = JSON.parse(fs.readFileSync(path.join(CLIENTS, `${slug}.json`), "utf8"));
  const dir = path.join(OUT, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, render(profile));
  return file;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const slugs = process.argv[2]
    ? [process.argv[2].replace(/\.json$/, "")]
    : fs.readdirSync(CLIENTS).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  let failed = false;
  for (const slug of slugs) {
    try {
      console.log(`built ${path.relative(here, build(slug))}`);
    } catch (err) {
      failed = true;
      console.error(`${slug}: ${err.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}
