const FEE_RATE = 0.136;
const FEE_FIXED = 0.4;
const LOG_KEY = "patrick.log.v1";
const PASS_KEY = "patrick.passcode";
const SETTINGS_KEY = "patrick.settings.v1";
const MAX_LOG = 300;

const MODE_INFO = {
  item: {
    scan: "Scan item",
    tag: "Tag price ($)",
    tagHint: "optional",
    hint: "Small stuff you'd ship: clothes, kitchenware, electronics, toys.",
    capture: true,
  },
  furniture: {
    scan: "Scan furniture",
    tag: "Price ($)",
    tagHint: "optional",
    hint: "Photograph the whole piece. Local pickup, so no selling fees.",
    capture: true,
  },
  listing: {
    scan: "Pick listing screenshot",
    tag: "Asking price ($)",
    tagHint: "if hidden",
    hint: "Screenshot a Marketplace, Craigslist or OfferUp listing. Get a verdict and an offer to send.",
    capture: false,
  },
};

const $ = (id) => document.getElementById(id);
const usd = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
const q = encodeURIComponent;

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null) node.append(kid);
  }
  return node;
}

// ---------- storage ----------
function loadLog() {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY)) || [];
  } catch {
    return [];
  }
}
function saveLog(log) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, MAX_LOG)));
  } catch {
    $("status").textContent = "Could not save to the log (storage full?).";
  }
}
function getPasscode() {
  try { return localStorage.getItem(PASS_KEY) || ""; } catch { return ""; }
}
function setPasscode(v) {
  try { localStorage.setItem(PASS_KEY, v); } catch { /* private mode */ }
}
function loadSettings() {
  const defaults = { mode: "item", maxPrice: 100, clCity: "", city: "", state: "", zip: "", radius: 25 };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
  } catch {
    return defaults;
  }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

// ---------- image ----------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that photo.")); };
    img.src = url;
  });
}
function shrink(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

// ---------- tabs ----------
const TABS = ["scan", "find", "log"];
function showTab(name) {
  for (const t of TABS) {
    $(`view-${t}`).hidden = t !== name;
    $(`tab-${t}`).classList.toggle("active", t === name);
  }
  if (name === "log") renderLog();
  if (name === "find") renderFind();
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => showTab(t));

// ---------- modes ----------
function setMode(mode) {
  settings.mode = mode;
  saveSettings();
  const info = MODE_INFO[mode];
  for (const b of document.querySelectorAll(".mode")) b.classList.toggle("active", b.dataset.mode === mode);
  $("scan").textContent = info.scan;
  $("tag-label").textContent = info.tag;
  $("tag").placeholder = info.tagHint;
  $("mode-hint").textContent = info.hint;
  if (info.capture) $("photo").setAttribute("capture", "environment");
  else $("photo").removeAttribute("capture");
}
for (const b of document.querySelectorAll(".mode")) b.addEventListener("click", () => setMode(b.dataset.mode));

// ---------- search links ----------
function facebookUrl(query, { maxPrice, newest } = {}) {
  let url = `https://www.facebook.com/marketplace/search/?query=${q(query)}&exact=false`;
  if (maxPrice != null) url += `&maxPrice=${maxPrice}`;
  if (newest) url += "&sortBy=creation_time_descend";
  return url;
}
const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
/** Craigslist subdomain: the one the user set, else a guess from their city. */
function clSubdomain() {
  return slug(settings.clCity || settings.city || "");
}
function areaString() {
  return [settings.city.trim(), settings.state.trim().toUpperCase()].filter(Boolean).join(", ");
}
function craigslistUrl(query, section = "fua") {
  const sub = clSubdomain();
  if (!sub) return null;
  let url = `https://${sub}.craigslist.org/search/${section}?query=${q(query)}&sort=date`;
  if (/^\d{5}$/.test(settings.zip)) url += `&postal=${settings.zip}&search_distance=${settings.radius || 25}`;
  return url;
}
function offerupUrl(query) {
  return `https://offerup.com/search?q=${q(query)}`;
}
function localLinkButtons(query, { maxPrice, newest, small } = {}) {
  const cls = small ? "btn small" : "btn";
  const cl = craigslistUrl(query);
  const link = (href, label, extra = "") =>
    el("a", { class: `${cls}${extra}`, target: "_blank", rel: "noopener", href: href || "#" }, label);
  return [
    link(facebookUrl(query, { maxPrice, newest }), "FB"),
    link(cl, "CL", cl ? "" : " off"),
    link(offerupUrl(query), "OfferUp"),
  ];
}

// ---------- scanning ----------
let busy = false;

$("scan").addEventListener("click", () => {
  if (!busy) $("photo").click();
});

$("photo").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || busy) return;
  busy = true;
  $("scan").disabled = true;
  $("result").hidden = true;
  setStatus("Looking at it...");
  const mode = settings.mode;
  try {
    const img = await loadImage(file);
    const image = shrink(img, mode === "listing" ? 1600 : 1280, 0.82);
    const thumb = shrink(img, 160, 0.6);
    const tagPrice = $("tag").value;
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-patrick-key": getPasscode() },
      body: JSON.stringify({ mode, image, tagPrice, note: $("note").value.trim(), area: areaString() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Scan failed (${res.status}).`);
    setStatus("");
    const entry = recordScan(data, thumb, tagPrice);
    renderResult(data, thumb, entry.id);
    $("tag").value = "";
    $("note").value = "";
  } catch (err) {
    setStatus(err.message, true);
    if (/passcode/i.test(err.message)) $("lock").hidden = false;
  } finally {
    busy = false;
    $("scan").disabled = false;
  }
});

function setStatus(text, isError = false) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("err", isError);
}

function recordScan(r, thumb, tagPrice) {
  const entry = {
    id: Date.now().toString(36),
    ts: Date.now(),
    thumb,
    mode: r.mode,
    name: r.item_name,
    verdict: r.verdict,
    tag: r.profit.cost,
    estSell: r.profit.sell_mid,
    estShipping: r.shipping_estimate,
    estRefurb: r.refurb_cost_estimate,
    feeRate: r.profit.fee_rate,
    feeFixed: r.profit.fee_fixed,
    status: "scanned",
    buyPrice: null,
    soldPrice: null,
  };
  const log = loadLog();
  log.unshift(entry);
  saveLog(log);
  return entry;
}

function updateEntry(id, patch) {
  const log = loadLog();
  const i = log.findIndex((x) => x.id === id);
  if (i >= 0) Object.assign(log[i], patch);
  saveLog(log);
}

// ---------- result card ----------
const section = (title, ...body) => el("section", { class: "card" }, el("h2", {}, title), ...body);
const list = (items) => el("ul", {}, items.map((t) => el("li", {}, t)));

function copyButton(label, text) {
  const btn = el("button", { class: "btn copy", type: "button" }, el("small", {}, label), text);
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.firstChild.textContent = `${label} - copied`;
    } catch {
      btn.firstChild.textContent = `${label} - long-press to copy`;
    }
  });
  return btn;
}

function moneyTable(r) {
  const p = r.profit;
  const feeLabel = p.fee_rate ? `Fees (about ${(p.fee_rate * 100).toFixed(1)}% + $${p.fee_fixed.toFixed(2)})` : "Fees (local pickup)";
  const isItem = r.mode === "item";
  const rows = [
    [isItem ? "Likely sells for" : "Likely sells for (after refurb)", usd(p.sell_mid)],
    [feeLabel, p.fees ? "-" + usd(p.fees) : usd(0)],
    [isItem ? "Shipping" : "Hauling", "-" + usd(p.shipping)],
    ["Supplies / refurb", "-" + usd(p.refurb)],
  ];
  if (p.cost !== null) rows.push([r.mode === "listing" ? "Asking price" : "You pay", "-" + usd(p.cost)]);

  const t = el("div", { class: "money" });
  for (const [label, val] of rows) t.append(el("span", {}, label), el("span", {}, val));
  t.append(
    el("span", { class: "total" }, p.cost !== null ? "Profit" : "Profit before buy price"),
    el("span", { class: `total ${p.net < 0 ? "neg" : "pos"}` }, usd(p.net)),
  );
  if (p.per_hour != null) {
    t.append(el("span", {}, `Per refurb hour (${r.refurb_hours}h)`), el("span", {}, usd(p.per_hour)));
  }
  if (r.mode === "listing" && r.profit_at_offer) {
    const o = r.profit_at_offer;
    t.append(
      el("span", { class: "total" }, `Profit at your offer (${usd(r.opening_offer)})`),
      el("span", { class: `total ${o.net < 0 ? "neg" : "pos"}` }, usd(o.net)),
    );
  }
  return t;
}

function renderResult(r, thumb, entryId) {
  const p = r.profit;
  const retake = r.verdict === "RETAKE";
  const isItem = r.mode === "item";
  const subtitle = isItem
    ? [r.brand, r.model_or_era, r.category]
    : [r.category, r.style_or_maker, r.material];

  const verdictBox = el("div", { class: `verdict ${r.verdict}` },
    el("div", { class: "big" }, retake ? (r.mode === "listing" ? "Send better shots" : "Retake photo") : r.verdict),
    el("p", {}, r.verdict_reason));
  if (!retake && r.mode !== "listing" && p.cost === null) {
    verdictBox.append(el("p", {}, `Pay up to ${usd(r.max_buy_price)}.`));
  }
  if (!retake && r.mode === "listing") {
    verdictBox.append(el("p", {}, `Offer ${usd(r.opening_offer)}. Walk away above ${usd(r.max_buy_price)}.`));
  }

  const nodes = [
    verdictBox,
    el("section", { class: "card" },
      el("img", { class: "thumb", src: thumb, alt: "" }),
      el("p", { class: "item-name" }, r.item_name),
      el("p", { class: "sub" }, subtitle.filter(Boolean).join(" / ")),
      el("p", { class: "sub" }, `Confidence: ${r.confidence}. Sells ${r.speed_to_sell}. Best on ${r.best_platform}.`),
      el("p", { class: "sub" }, r.condition_notes)),
  ];

  if (!retake) nodes.push(section("The money", moneyTable(r)));

  if (!retake && r.mode === "listing") {
    nodes.push(section("Message the seller",
      copyButton("Your offer text", r.negotiation_message),
      r.questions_to_ask.length ? el("p", { class: "sub" }, "Ask them first:") : null,
      r.questions_to_ask.length ? list(r.questions_to_ask) : null));
  }

  if (!retake && !isItem) {
    nodes.push(section("Hauling",
      list([`Size: ${r.est_size}`, r.transport, `Hauling cost: about ${usd(r.shipping_estimate)}`])));
  }

  if (r.what_to_check.length) {
    nodes.push(section(retake ? "Send this" : r.mode === "listing" ? "Check before you drive" : "Check before you buy", list(r.what_to_check)));
  }
  if (r.red_flags.length) nodes.push(section("Red flags", list(r.red_flags)));

  if (!retake) {
    if (r.refurb_steps.length) nodes.push(section(isItem ? "Refurbish" : "Flip plan", list(r.refurb_steps)));
    if (!isItem && r.supplies.length) nodes.push(section("Shopping list", list(r.supplies)));

    const verify = isItem
      ? [
          el("a", { class: "btn primary", target: "_blank", rel: "noopener", href: `https://www.ebay.com/sch/i.html?_nkw=${q(r.ebay_search)}&LH_Sold=1&LH_Complete=1` }, "eBay sold"),
          el("a", { class: "btn", target: "_blank", rel: "noopener", href: facebookUrl(r.facebook_search) }, "Facebook"),
          el("a", { class: "btn", target: "_blank", rel: "noopener", href: `https://www.ebay.com/sch/i.html?_nkw=${q(r.ebay_search)}` }, "eBay active"),
        ]
      : [
          ...localLinkButtons(r.facebook_search),
          r.sale_channel === "shipped"
            ? el("a", { class: "btn", target: "_blank", rel: "noopener", href: `https://www.ebay.com/sch/i.html?_nkw=${q(r.ebay_search)}&LH_Sold=1&LH_Complete=1` }, "eBay sold")
            : null,
        ];
    const hint = isItem
      ? "These numbers are an estimate. Check what it actually sold for."
      : "Estimate only. Check what similar pieces are listed for near you.";
    nodes.push(section("Verify the price", el("p", { class: "sub" }, hint), el("div", { class: "links" }, verify)));

    if (r.mode !== "listing") {
      nodes.push(section(isItem ? "Listing (ready to paste)" : "Listing for after the flip",
        copyButton("Title", r.listing_title),
        copyButton("Description", r.listing_description)));
    }
    const suggested = r.mode === "listing" ? r.opening_offer : p.cost ?? r.max_buy_price;
    nodes.push(el("div", { class: "actions" },
      el("button", { class: "btn primary", type: "button", onclick: () => markBought(entryId, suggested) }, "I bought it"),
      el("button", { class: "btn", type: "button", onclick: () => { $("result").hidden = true; window.scrollTo(0, 0); } }, "Skip")));
  }

  const box = $("result");
  box.replaceChildren(...nodes);
  box.hidden = false;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

function markBought(id, suggested) {
  const input = prompt("What did you pay?", Number(suggested).toFixed(2));
  if (input === null) return;
  const price = Number(input);
  if (!Number.isFinite(price) || price < 0) return alert("Enter a number like 4.99.");
  updateEntry(id, { status: "bought", buyPrice: price });
  $("result").hidden = true;
  setStatus(`Logged: paid ${usd(price)}.`);
}

// ---------- find tab ----------
const PRESET_GROUPS = [
  {
    title: "Brands that flip",
    items: ["Broyhill dresser", "Lane furniture", "Ethan Allen", "Drexel", "Thomasville", "Henredon", "Stickley", "Heywood-Wakefield", "Danish teak"],
  },
  {
    title: "Styles that sell",
    items: ["mid century modern", "solid wood dresser", "dovetail drawers", "rattan", "butcher block", "farmhouse table", "credenza", "hutch", "wood desk"],
  },
  {
    title: "Sellers in a hurry",
    items: ["moving must go", "need gone today", "estate sale furniture", "curb alert"],
  },
];

function mapsUrl(term) {
  const place = areaString() || settings.zip;
  return `https://www.google.com/maps/search/${q(place ? `${term} near ${place}` : term)}`;
}

function renderSources() {
  const place = areaString() || settings.zip;
  if (!place) {
    $("sources").replaceChildren();
    return;
  }
  const link = (href, label) => el("a", { class: "btn small", target: "_blank", rel: "noopener", href }, label);
  const row = (label, ...links) => el("div", { class: "preset" }, el("span", {}, label), el("div", { class: "links tight" }, links));

  const stores = [
    ["Goodwill", "Goodwill"],
    ["Habitat ReStore (furniture)", "Habitat for Humanity ReStore"],
    ["Salvation Army", "Salvation Army thrift store"],
    ["Thrift stores", "thrift store"],
    ["Consignment and antique", "antique mall"],
    ["Flea markets", "flea market"],
  ].map(([label, term]) => row(label, link(mapsUrl(term), "Map")));

  const sales = [];
  const st = settings.state.trim().toUpperCase();
  const city = settings.city.trim();
  if (st && city) {
    const path = city.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    sales.push(row("Estate sales", link(`https://www.estatesales.net/${st}/${path}`, "estatesales.net"), link(mapsUrl("estate sale"), "Map")));
  }
  const gs = craigslistUrl("", "gms");
  sales.push(row("Garage and moving sales",
    link(facebookUrl("garage sale", { newest: true }), "FB"),
    gs ? link(gs, "CL") : null));

  $("sources").replaceChildren(
    el("section", { class: "card" }, el("h2", {}, `Stores near ${place}`), stores),
    el("section", { class: "card" }, el("h2", {}, "Sales near you"), sales));
}

function renderFind() {
  $("maxprice").value = settings.maxPrice;
  $("clcity").value = settings.clCity;
  $("clcity").placeholder = settings.city ? slug(settings.city) : "e.g. denver";
  $("city").value = settings.city;
  $("state").value = settings.state;
  $("zip").value = settings.zip;
  $("radius").value = settings.radius;
  $("area-hint").textContent = areaString()
    ? "Patrick prices furniture and listings for your market. Add a ZIP to limit Craigslist to your radius."
    : "Set this once. Patrick prices for your market and builds local links.";
  renderSources();
  renderCustomLinks();

  const maxPrice = settings.maxPrice;
  const groups = PRESET_GROUPS.map((g) =>
    el("section", { class: "card" },
      el("h2", {}, g.title),
      g.items.map((name) =>
        el("div", { class: "preset" },
          el("span", {}, name),
          el("div", { class: "links tight" }, localLinkButtons(name, { maxPrice, newest: true, small: true })))),
    ));
  const free = el("section", { class: "card" },
    el("h2", {}, "Free stuff"),
    el("div", { class: "preset" },
      el("span", {}, "free furniture"),
      el("div", { class: "links tight" }, localLinkButtons("furniture", { maxPrice: 0, newest: true, small: true }))));
  $("presets").replaceChildren(...groups, free);

  $("tips").replaceChildren(
    el("h2", {}, "How to hunt"),
    list([
      "Sort by newest and message in the first hour. Good pieces go fast.",
      "Look for: solid wood, dovetail drawers, a maker stamp in a drawer, a style people search for.",
      "Skip: particleboard, smoke or mildew smell, stained upholstery, mattresses.",
      "Use the Listing tab on the scanner: screenshot an ad and get an offer to send.",
      "Check it fits your vehicle before you drive. Measure the doorway on the other end too.",
    ]));
}

function renderCustomLinks() {
  const text = $("custom").value.trim();
  $("custom-links").replaceChildren(...(text ? localLinkButtons(text, { maxPrice: settings.maxPrice, newest: true, small: true }) : []));
}

$("maxprice").addEventListener("change", (e) => {
  const n = Number(e.target.value);
  settings.maxPrice = Number.isFinite(n) && n >= 0 ? n : 100;
  saveSettings();
  renderFind();
});
$("clcity").addEventListener("change", (e) => {
  settings.clCity = e.target.value.trim();
  saveSettings();
  renderFind();
});
$("custom").addEventListener("input", renderCustomLinks);
for (const [id, key] of [["city", "city"], ["state", "state"], ["zip", "zip"]]) {
  $(id).addEventListener("change", (e) => {
    settings[key] = key === "zip" ? e.target.value.replace(/\D/g, "").slice(0, 5) : key === "state" ? e.target.value.trim().toUpperCase() : e.target.value.trim();
    saveSettings();
    renderFind();
  });
}
$("radius").addEventListener("change", (e) => {
  const n = Number(e.target.value);
  settings.radius = Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 500) : 25;
  saveSettings();
  renderFind();
});

// ---------- log ----------
function netFor(e) {
  const fees = e.soldPrice * (e.feeRate ?? FEE_RATE) + (e.feeFixed ?? FEE_FIXED);
  return e.soldPrice - fees - (e.estShipping || 0) - (e.estRefurb || 0) - e.buyPrice;
}

const MODE_LABEL = { item: "thrift", furniture: "furniture", listing: "listing" };

function renderLog() {
  const log = loadLog();
  const owned = log.filter((e) => e.status !== "scanned");
  const spent = owned.reduce((s, e) => s + e.buyPrice, 0);
  const sold = log.filter((e) => e.status === "sold");
  const revenue = sold.reduce((s, e) => s + e.soldPrice, 0);
  const profit = sold.reduce((s, e) => s + netFor(e), 0);

  $("summary").replaceChildren(
    el("div", {}, el("b", {}, usd(spent)), el("span", {}, "Spent")),
    el("div", {}, el("b", {}, usd(revenue)), el("span", {}, "Sold for")),
    el("div", {}, el("b", {}, usd(profit)), el("span", {}, "Est. profit")),
  );

  if (!log.length) {
    $("log").replaceChildren(el("p", { class: "empty" }, "Nothing scanned yet."));
    return;
  }
  $("log").replaceChildren(
    ...log.map((e) => {
      const pill = el("span", { class: `pill ${e.status}` }, e.status);
      const modePill = e.mode && e.mode !== "item" ? el("span", { class: "pill mode-pill" }, MODE_LABEL[e.mode]) : null;
      const detail =
        e.status === "sold" ? `Paid ${usd(e.buyPrice)}, sold ${usd(e.soldPrice)}, est. profit ${usd(netFor(e))}`
        : e.status === "bought" ? `Paid ${usd(e.buyPrice)}. Est. sale ${usd(e.estSell)}.`
        : `${e.verdict}. Est. sale ${usd(e.estSell)}${e.tag != null ? `, price ${usd(e.tag)}` : ""}.`;
      const buttons = [];
      if (e.status === "scanned") buttons.push(el("button", { class: "btn", type: "button", onclick: () => { markBought(e.id, e.tag ?? 0); renderLog(); } }, "Bought it"));
      if (e.status === "bought") buttons.push(el("button", { class: "btn primary", type: "button", onclick: () => markSold(e.id) }, "Mark sold"));
      buttons.push(el("button", { class: "btn", type: "button", onclick: () => removeEntry(e.id) }, "Delete"));
      return el("article", { class: "card entry" },
        el("header", {}, el("strong", {}, e.name), el("span", {}, modePill, " ", pill)),
        el("div", { class: "row", style: "margin:0" },
          el("img", { src: e.thumb, alt: "", width: "64", height: "64", style: "object-fit:cover;border-radius:8px" }),
          el("p", { class: "sub", style: "margin:0" }, detail)),
        el("div", { class: "actions" }, buttons));
    }),
  );
}

function markSold(id) {
  const input = prompt("What did it sell for (before fees)?");
  if (input === null) return;
  const price = Number(input);
  if (!Number.isFinite(price) || price < 0) return alert("Enter a number like 24.00.");
  updateEntry(id, { status: "sold", soldPrice: price });
  renderLog();
}

function removeEntry(id) {
  if (!confirm("Delete this entry?")) return;
  saveLog(loadLog().filter((e) => e.id !== id));
  renderLog();
}

// ---------- startup ----------
$("passcode").addEventListener("change", (e) => setPasscode(e.target.value.trim()));
setMode(MODE_INFO[settings.mode] ? settings.mode : "item");

(async function init() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    if (cfg.needsPasscode && !getPasscode()) $("lock").hidden = false;
    if (cfg.mock) setStatus("Mock mode: answers are fake, no AI is called.");
  } catch {
    setStatus("Can't reach the server.", true);
  }
})();
