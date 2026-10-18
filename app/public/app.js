const FEE_RATE = 0.136;
const FEE_FIXED = 0.4;
const LOG_KEY = "patrick.log.v1";
const PASS_KEY = "patrick.passcode";
const DEAL_KEY = "patrick.deals.v1";
const MAX_LOG = 300;

const $ = (id) => document.getElementById(id);
const usd = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);

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
const TABS = ["scan", "deals", "log"];
function showTab(name) {
  for (const t of TABS) {
    $(`view-${t}`).hidden = t !== name;
    $(`tab-${t}`).classList.toggle("active", t === name);
  }
  if (name === "log") renderLog();
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => showTab(t));

// ---------- scanning ----------
let busy = false;

$("scan").addEventListener("click", () => {
  if (!busy) $("photo").click();
});

$("photo").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) runScan(file, "item");
});

// mode "listing": a screenshot of a Facebook / OfferUp / Craigslist listing.
async function runScan(file, mode) {
  if (busy) return;
  busy = true;
  $("scan").disabled = true;
  $("result").hidden = true;
  setStatus(mode === "listing" ? "Reading the listing..." : "Looking at it...");
  try {
    const img = await loadImage(file);
    const image = shrink(img, 1280, 0.82);
    const thumb = shrink(img, 160, 0.6);
    const tagPrice = $("tag").value;
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-patrick-key": getPasscode() },
      body: JSON.stringify({ image, tagPrice, note: $("note").value.trim(), mode }),
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
}

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
    name: r.item_name,
    verdict: r.verdict,
    tag: r.profit.cost,
    estSell: r.profit.sell_mid,
    estShipping: r.shipping_estimate,
    estRefurb: r.refurb_cost_estimate,
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
const q = encodeURIComponent;

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

function renderResult(r, thumb, entryId) {
  const p = r.profit;
  const moneyRows = [
    ["Likely sells for", usd(p.sell_mid)],
    ["Fees (about 13.6% + $0.40)", "-" + usd(p.fees)],
    ["Shipping", "-" + usd(p.shipping)],
    ["Refurb", "-" + usd(p.refurb)],
  ];
  if (p.cost !== null) moneyRows.push(["You pay", "-" + usd(p.cost)]);

  const money = el("div", { class: "money" });
  for (const [label, val] of moneyRows) money.append(el("span", {}, label), el("span", {}, val));
  money.append(
    el("span", { class: "total" }, p.cost !== null ? "Profit" : "Profit before buy price"),
    el("span", { class: `total ${p.net < 0 ? "neg" : "pos"}` }, usd(p.net)),
  );

  const nodes = [
    el("div", { class: `verdict ${r.verdict}` },
      el("div", { class: "big" }, r.verdict === "RETAKE" ? "Retake photo" : r.verdict),
      el("p", {}, r.verdict_reason),
      r.verdict !== "RETAKE" && p.cost === null
        ? el("p", {}, `Pay up to ${usd(r.max_buy_price)}.`)
        : null),
    el("section", { class: "card" },
      el("img", { class: "thumb", src: thumb, alt: "" }),
      el("p", { class: "item-name" }, r.item_name),
      el("p", { class: "sub" }, [r.brand, r.model_or_era, r.category].filter(Boolean).join(" / ")),
      el("p", { class: "sub" }, `Confidence: ${r.confidence}. Sells ${r.speed_to_sell}. Best on ${r.best_platform}.`),
      el("p", { class: "sub" }, r.condition_notes)),
  ];

  if (r.verdict !== "RETAKE") nodes.push(section("The money", money));
  if (r.offer_price > 0 && r.verdict !== "PASS" && r.verdict !== "RETAKE") {
    nodes.push(section("Make an offer",
      el("p", { class: "offer" }, `Offer ${usd(r.offer_price)}`),
      copyButton("Message to seller", r.offer_message)));
  }
  if (r.what_to_check.length) nodes.push(section(r.verdict === "RETAKE" ? "Photograph this" : "Check before you buy", list(r.what_to_check)));
  if (r.red_flags.length) nodes.push(section("Red flags", list(r.red_flags)));
  if (r.verdict !== "RETAKE") {
    if (r.refurb_steps.length) nodes.push(section("Refurbish", list(r.refurb_steps)));
    nodes.push(section("Verify the price",
      el("p", { class: "sub" }, "These numbers are an estimate. Check what it actually sold for."),
      el("div", { class: "links" },
        el("a", { class: "btn primary", target: "_blank", rel: "noopener", href: `https://www.ebay.com/sch/i.html?_nkw=${q(r.ebay_search)}&LH_Sold=1&LH_Complete=1` }, "eBay sold"),
        el("a", { class: "btn", target: "_blank", rel: "noopener", href: `https://www.facebook.com/marketplace/search/?query=${q(r.facebook_search)}` }, "Facebook"),
        el("a", { class: "btn", target: "_blank", rel: "noopener", href: `https://www.ebay.com/sch/i.html?_nkw=${q(r.ebay_search)}` }, "eBay active"))));
    nodes.push(section("Listing (ready to paste)",
      copyButton("Title", r.listing_title),
      copyButton("Description", r.listing_description)));
    nodes.push(el("div", { class: "actions" },
      el("button", { class: "btn primary", type: "button", onclick: () => markBought(entryId, p.cost ?? r.max_buy_price) }, "I bought it"),
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

// ---------- log ----------
function netFor(e) {
  const fees = e.soldPrice * FEE_RATE + FEE_FIXED;
  return e.soldPrice - fees - (e.estShipping || 0) - (e.estRefurb || 0) - e.buyPrice;
}

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
      const detail =
        e.status === "sold" ? `Paid ${usd(e.buyPrice)}, sold ${usd(e.soldPrice)}, est. profit ${usd(netFor(e))}`
        : e.status === "bought" ? `Paid ${usd(e.buyPrice)}. Est. sale ${usd(e.estSell)}.`
        : `${e.verdict}. Est. sale ${usd(e.estSell)}${e.tag != null ? `, tag ${usd(e.tag)}` : ""}.`;
      const buttons = [];
      if (e.status === "scanned") buttons.push(el("button", { class: "btn", type: "button", onclick: () => { markBought(e.id, e.tag ?? 0); renderLog(); } }, "Bought it"));
      if (e.status === "bought") buttons.push(el("button", { class: "btn primary", type: "button", onclick: () => markSold(e.id) }, "Mark sold"));
      buttons.push(el("button", { class: "btn", type: "button", onclick: () => removeEntry(e.id) }, "Delete"));
      return el("article", { class: "card entry" },
        el("header", {}, el("strong", {}, e.name), pill),
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

// ---------- deals ----------
const SUGGESTIONS = ["DeWalt", "Milwaukee M18", "Nintendo Switch", "KitchenAid mixer", "Lego lot", "Vintage Pyrex", "Yeti cooler", "Vitamix"];

function loadDeals() {
  try { return { watch: [], ...JSON.parse(localStorage.getItem(DEAL_KEY)) }; } catch { return { watch: [] }; }
}
function saveDeals(patch) {
  try { localStorage.setItem(DEAL_KEY, JSON.stringify({ ...loadDeals(), ...patch })); } catch { /* private mode */ }
}

function dealStatus(text, isError = false) {
  $("dstatus").textContent = text;
  $("dstatus").classList.toggle("err", isError);
}

function renderWatch() {
  const { watch } = loadDeals();
  const chips = (watch.length ? watch : SUGGESTIONS).map((term) => {
    const chip = el("button", { class: "chip", type: "button", onclick: () => { $("dq").value = term; runDeals(); } }, term);
    if (watch.length) {
      chip.append(el("span", { class: "x", "aria-label": `Remove ${term}`, onclick: (e) => {
        e.stopPropagation();
        saveDeals({ watch: loadDeals().watch.filter((w) => w !== term) });
        renderWatch();
      } }, "×"));
    }
    return chip;
  });
  chips.push(el("button", { class: "chip save", type: "button", onclick: () => {
    const term = $("dq").value.trim();
    if (!term) return dealStatus("Type a search first, then save it.", true);
    const w = loadDeals().watch.filter((x) => x.toLowerCase() !== term.toLowerCase());
    saveDeals({ watch: [term, ...w].slice(0, 20) });
    renderWatch();
  } }, "+ Save search"));
  $("watch").replaceChildren(...chips);
}

let dealBusy = false;
async function runDeals() {
  if (dealBusy) return;
  const zip = $("dzip").value.trim();
  if (!/^\d{5}$/.test(zip)) {
    $("dsettings").open = true;
    $("dzip").focus();
    return dealStatus("Set your ZIP code first (bottom of this tab).", true);
  }
  const q = $("dq").value.trim();
  if (!q) return dealStatus("Type what you're hunting for.", true);
  dealBusy = true;
  $("dgo").disabled = true;
  dealStatus("Searching and rating listings... (about 20 seconds)");
  try {
    const res = await fetch("/api/deals", {
      method: "POST",
      headers: { "content-type": "application/json", "x-patrick-key": getPasscode() },
      body: JSON.stringify({
        q, zip,
        radius: Number($("dradius").value) || 25,
        maxPrice: Number($("dmax").value) || 0,
        craigslist: $("dcl").value.trim(),
        local: $("dwhere").value === "local",
        sort: $("dsort").value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Search failed (${res.status}).`);
    dealStatus("");
    renderDeals(data);
  } catch (err) {
    dealStatus(err.message, true);
    if (/passcode/i.test(err.message)) { showTab("scan"); $("lock").hidden = false; }
  } finally {
    dealBusy = false;
    $("dgo").disabled = false;
  }
}

function timeLeft(iso) {
  const ms = new Date(iso) - Date.now();
  if (!(ms > 0)) return "ended";
  const h = Math.floor(ms / 3600e3);
  return h >= 24 ? `${Math.floor(h / 24)}d left` : h >= 1 ? `${h}h left` : `${Math.ceil(ms / 60e3)}m left`;
}

function dealCard(d) {
  const where = [d.distance != null ? `${d.distance} mi` : null, d.where].filter(Boolean).join(" · ");
  const meta = [d.format, d.bids != null ? `${d.bids} bids` : null, d.endsAt ? timeLeft(d.endsAt) : null, d.condition].filter(Boolean).join(" · ");
  return el("article", { class: "card deal" },
    d.image ? el("img", { src: d.image, alt: "", loading: "lazy" }) : el("div", { class: "img" }),
    el("div", {},
      el("p", { class: "title" }, el("span", { class: `badge ${d.verdict}` }, d.verdict), d.title),
      el("p", { class: "sub" }, [meta, where].filter(Boolean).join(" · ")),
      el("p", { class: "nums" },
        el("span", {}, `Pay ${usd(d.cost)}`),
        el("span", {}, `Resells ~${usd(d.resale)}`),
        el("b", { class: d.net < 0 ? "neg" : "pos" }, `Profit ${usd(d.net)}`))),
    el("div", { class: "full" },
      el("p", { class: "sub" }, d.reason),
      d.check ? el("p", { class: "sub" }, `Check: ${d.check}`) : null,
      el("div", { class: "links", style: "margin-top:8px" },
        el("a", { class: `btn ${d.verdict === "BUY" ? "primary" : ""}`, href: d.url, target: "_blank", rel: "noopener" }, "Open listing"))));
}

function renderDeals(data) {
  const nodes = [];
  const head = [data.note];
  if (data.stats?.count) head.push(`${data.stats.count} eBay listings, median asking ${usd(data.stats.median)}. Profit uses Patrick's resale estimate, so check sold prices before buying.`);
  nodes.push(el("section", { class: "card" },
    el("h2", {}, "Search everywhere"),
    el("div", { class: "links" }, data.links.map((l) => el("a", { class: "btn", href: l.url, target: "_blank", rel: "noopener" }, l.name))),
    el("p", { class: "sub", style: "margin-top:8px" }, "Found something on Facebook or OfferUp? Screenshot it and use the button above.")));
  if (head.filter(Boolean).length) nodes.unshift(el("section", { class: "card" }, head.filter(Boolean).map((t) => el("p", { class: "sub" }, t))));
  const good = data.deals.filter((d) => d.verdict !== "PASS");
  const pass = data.deals.filter((d) => d.verdict === "PASS");
  if (data.deals.length && !good.length) nodes.push(el("p", { class: "empty" }, "No deals in this batch. Everything is priced at or above resale."));
  nodes.push(...good.map(dealCard));
  if (pass.length) {
    const more = el("details", { class: "card" }, el("summary", {}, `${pass.length} listings to pass on`));
    more.append(...pass.map(dealCard));
    nodes.push(more);
  }
  $("dresult").replaceChildren(...nodes);
}

function initDeals() {
  const saved = loadDeals();
  $("dzip").value = saved.zip || "";
  $("dradius").value = saved.radius || "";
  $("dcl").value = saved.craigslist || "";
  if (!saved.zip) $("dsettings").open = true;
  for (const [id, key] of [["dzip", "zip"], ["dradius", "radius"], ["dcl", "craigslist"]]) {
    $(id).addEventListener("change", (e) => saveDeals({ [key]: e.target.value.trim() }));
  }
  $("dgo").addEventListener("click", runDeals);
  $("dq").addEventListener("keydown", (e) => { if (e.key === "Enter") runDeals(); });
  $("dshot").addEventListener("click", () => { if (!busy) $("shot").click(); });
  $("shot").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    showTab("scan");
    runScan(file, "listing");
  });
  renderWatch();
}
initDeals();

// ---------- startup ----------
$("passcode").addEventListener("change", (e) => setPasscode(e.target.value.trim()));

(async function init() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    if (cfg.needsPasscode && !getPasscode()) $("lock").hidden = false;
    if (cfg.mock) setStatus("Mock mode: answers are fake, no AI is called.");
    if (!cfg.ebay) dealStatus("eBay keys aren't set on the server yet, so you'll get search links but no live eBay deals.");
  } catch {
    setStatus("Can't reach the server.", true);
  }
})();
