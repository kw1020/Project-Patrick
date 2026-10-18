// ==UserScript==
// @name         Krew's Terraria Wiki Skin
// @namespace    project-patrick
// @version      1.0.0
// @description  Dark, clean, easier-to-read skin for the official Terraria Wiki (terraria.wiki.gg). Hides ads and clutter.
// @match        https://terraria.wiki.gg/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "krew-skin";
  const prefs = Object.assign({ on: true, menu: false }, read());

  function read() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  /* ---------- Look ---------- */
  // Palette: deep cavern blue background, torchlight amber links, stage colors for highlights.
  const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Pixelify+Sans:wght@500;700&display=swap");

html.krew {
  --k-bg: #121420;
  --k-surface: #1b1e2d;
  --k-surface-2: #232740;
  --k-line: #2f3452;
  --k-fg: #e8e5da;
  --k-muted: #a3a5bb;
  --k-accent: #f2b35a;
  --k-accent-hover: #ffd08a;
  --k-visited: #d9a35e;
  --k-redlink: #ef7a6a;
  --k-green: #86c46f;
  --k-pink: #e88bc6;
  --k-teal: #62d3c6;
  --k-display: "Pixelify Sans", "Courier New", monospace;
  --k-body: "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif;
  color-scheme: dark;

  /* Point the wiki's own theme settings at the palette above */
  --theme-site-background: var(--k-bg);
  --theme-page-background-color: var(--k-bg);
  --theme-page-background-color--secondary: var(--k-surface);
  --theme-background: var(--k-surface);
  --theme-background-accent: var(--k-surface-2);
  --theme-background-active: var(--k-surface-2);
  --theme-section-background: var(--k-surface);
  --theme-heading-background: var(--k-surface-2);
  --theme-heading-color: var(--k-fg);
  --theme-box-background: var(--k-surface);
  --theme-box-border-color: var(--k-line);
  --theme-box-border-color-inner: var(--k-line);
  --theme-box-border-color-light: var(--k-line);
  --theme-border-color: var(--k-line);
  --theme-border-color-accent: var(--k-accent);
  --theme-border-bottom-color: var(--k-line);
  --theme-highlight-background: var(--k-surface-2);
  --theme-text-color: var(--k-fg);
  --theme-text-color-note: var(--k-muted);
  --theme-text-color-em: var(--k-accent);
  --theme-link-color: var(--k-accent);
  --theme-link-color-hover: var(--k-accent-hover);
  --theme-link-color-visited: var(--k-visited);
  --theme-link-color-accent: var(--k-accent);
  --theme-link-color-redlink: var(--k-redlink);
  --theme-icon-color: var(--k-muted);
  --theme-icon-color-hover: var(--k-accent);
  --theme-icon-color-link: var(--k-accent);
  --theme-dropdown-background: var(--k-surface);
  --theme-dropdown-border-color: var(--k-line);
  --theme-box-inset-shadow: none;
  --theme-inner-shadow: none;
  --theme-background-shadow: none;
  --theme-box-border-radius: 10px;
  --theme-box-border-radius-inner: 6px;
}

html.krew, html.krew body {
  background: var(--k-bg) !important;
  color: var(--k-fg) !important;
}
html.krew body { font-family: var(--k-body) !important; }

/* ----- Header bar ----- */
html.krew #mw-head,
html.krew #mw-head-base,
html.krew #mw-page-base {
  background: var(--k-bg) !important;
  background-image: none !important;
  border: 0 !important;
}
html.krew #mw-head { border-bottom: 1px solid var(--k-line) !important; }
html.krew #mw-head a { color: var(--k-muted) !important; }
html.krew #mw-head a:hover { color: var(--k-fg) !important; }
html.krew #p-search input,
html.krew #simpleSearch,
html.krew #searchInput {
  background: var(--k-surface) !important;
  color: var(--k-fg) !important;
  border: 1px solid var(--k-line) !important;
  border-radius: 999px !important;
  box-shadow: none !important;
}
html.krew #searchInput { padding-left: 12px !important; font-size: 15px !important; }
html.krew #searchInput:focus { border-color: var(--k-accent) !important; outline: none !important; }

/* ----- Sidebar: hidden unless the Menu button is on ----- */
html.krew:not(.krew-menu) #mw-panel { display: none !important; }
html.krew:not(.krew-menu) #content,
html.krew:not(.krew-menu) #footer,
html.krew:not(.krew-menu) #left-navigation,
html.krew:not(.krew-menu) #mw-head-base { margin-left: 0 !important; }
html.krew:not(.krew-menu) #left-navigation { padding-left: 16px !important; }
html.krew #mw-panel {
  background: var(--k-bg) !important;
  background-image: none !important;
}
html.krew #mw-panel .vector-menu-content,
html.krew #mw-panel .portal { background: transparent !important; border: 0 !important; }

/* ----- Page body ----- */
html.krew #content {
  background: var(--k-bg) !important;
  background-image: none !important;
  border: 0 !important;
  box-shadow: none !important;
  color: var(--k-fg) !important;
  max-width: 1180px;
  margin-right: auto !important;
  padding: 24px 28px 48px !important;
  font-size: 16.5px !important;
  line-height: 1.65 !important;
}
html.krew:not(.krew-menu) #content { margin-left: auto !important; }

html.krew #firstHeading {
  font-family: var(--k-display) !important;
  font-size: clamp(28px, 4vw, 40px) !important;
  font-weight: 700 !important;
  letter-spacing: .5px;
  color: var(--k-fg) !important;
  border: 0 !important;
  margin-bottom: 4px !important;
}
html.krew .mw-parser-output h2,
html.krew .mw-parser-output h3,
html.krew .mw-parser-output h4 {
  font-family: var(--k-display) !important;
  color: var(--k-fg) !important;
  background: none !important;
  font-weight: 700 !important;
  letter-spacing: .3px;
}
html.krew .mw-parser-output h2 {
  font-size: 26px !important;
  border-bottom: 1px solid var(--k-line) !important;
  padding-bottom: 6px !important;
  margin-top: 1.6em !important;
}
html.krew .mw-parser-output h3 { font-size: 20px !important; color: var(--k-accent) !important; }
html.krew .mw-parser-output p,
html.krew .mw-parser-output li { max-width: 78ch; }
html.krew .mw-parser-output a { color: var(--k-accent); }
html.krew .mw-parser-output a:visited { color: var(--k-visited); }
html.krew .mw-parser-output a.new { color: var(--k-redlink) !important; }
html.krew .mw-parser-output a:hover { color: var(--k-accent-hover); }
html.krew #contentSub, html.krew #siteSub, html.krew .mw-indicators { color: var(--k-muted) !important; }

/* ----- Infobox (the item/boss box on the right) ----- */
html.krew .infobox {
  background: var(--k-surface) !important;
  border: 1px solid var(--k-line) !important;
  border-radius: 12px !important;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .35) !important;
  color: var(--k-fg) !important;
  overflow: hidden;
}
html.krew .infobox .title,
html.krew .infobox > .title,
html.krew .infobox th {
  background: var(--k-surface-2) !important;
  color: var(--k-fg) !important;
  font-family: var(--k-display) !important;
  border-color: var(--k-line) !important;
}
html.krew .infobox td,
html.krew .infobox .section,
html.krew .infobox .images { background: transparent !important; border-color: var(--k-line) !important; }

/* ----- Tables ----- */
html.krew .mw-parser-output table.terraria,
html.krew .mw-parser-output table.wikitable,
html.krew .mw-parser-output table.navbox,
html.krew .mw-parser-output .navbox {
  background: var(--k-surface) !important;
  color: var(--k-fg) !important;
  border: 1px solid var(--k-line) !important;
  border-radius: 10px !important;
  border-collapse: separate !important;
  border-spacing: 0 !important;
  overflow: hidden;
}
html.krew .mw-parser-output table.terraria th,
html.krew .mw-parser-output table.wikitable th,
html.krew .mw-parser-output .navbox th {
  background: var(--k-surface-2) !important;
  color: var(--k-fg) !important;
  border-color: var(--k-line) !important;
  font-weight: 700 !important;
}
html.krew .mw-parser-output table.terraria td,
html.krew .mw-parser-output table.wikitable td,
html.krew .mw-parser-output .navbox td {
  background: transparent !important;
  border-color: var(--k-line) !important;
  padding: 8px 12px !important;
}
html.krew .mw-parser-output table.terraria tr:nth-child(even) td,
html.krew .mw-parser-output table.wikitable tr:nth-child(even) td { background: rgba(255, 255, 255, .025) !important; }
html.krew .mw-parser-output table.terraria tr:hover td,
html.krew .mw-parser-output table.wikitable tr:hover td { background: rgba(242, 179, 90, .07) !important; }

/* Crafting recipe and drop boxes */
html.krew .crafts, html.krew .recipes, html.krew .drops, html.krew .infocard, html.krew .infotable, html.krew .box {
  background: var(--k-surface) !important;
  border-color: var(--k-line) !important;
  color: var(--k-fg) !important;
}

/* Table of contents */
html.krew #toc, html.krew .toc {
  background: var(--k-surface) !important;
  border: 1px solid var(--k-line) !important;
  border-radius: 10px !important;
  padding: 10px 16px !important;
}
html.krew .toctitle h2 { font-size: 16px !important; border: 0 !important; margin: 0 !important; }

/* Notice boxes, quotes, code */
html.krew .mw-parser-output blockquote {
  border-left: 3px solid var(--k-accent) !important;
  background: var(--k-surface) !important;
  padding: 8px 14px !important;
  border-radius: 0 8px 8px 0;
}
html.krew code, html.krew pre {
  background: var(--k-surface-2) !important;
  color: var(--k-fg) !important;
  border-color: var(--k-line) !important;
}

/* Images: soft frame so sprites pop on dark */
html.krew .thumbinner, html.krew .thumb .thumbimage {
  background: var(--k-surface) !important;
  border-color: var(--k-line) !important;
}
html.krew .thumbcaption { color: var(--k-muted) !important; }

/* Category links + footer */
html.krew #catlinks {
  background: var(--k-surface) !important;
  border: 1px solid var(--k-line) !important;
  border-radius: 10px !important;
}
html.krew #footer { background: var(--k-bg) !important; color: var(--k-muted) !important; border-top: 1px solid var(--k-line); }
html.krew #footer a { color: var(--k-muted) !important; }

/* ----- Clutter ----- */
html.krew .mw-editsection,
html.krew .mw-jump-link,
html.krew #jump-to-nav,
html.krew #siteNotice,
html.krew #centralNotice,
html.krew #footer-icons,
html.krew #footer-places,
html.krew .printfooter { display: none !important; }

/* ----- Ads ----- */
html.krew .adsbygoogle,
html.krew ins.adsbygoogle,
html.krew [id^="div-gpt-ad"],
html.krew [id^="google_ads"],
html.krew [data-ad-slot],
html.krew [data-ad-client],
html.krew [data-google-query-id],
html.krew iframe[src*="doubleclick"],
html.krew iframe[src*="googlesyndication"],
html.krew iframe[src*="amazon-adsystem"],
html.krew iframe[id^="google_ads_iframe"],
html.krew .krew-ad-hidden { display: none !important; }

/* ----- Phones ----- */
@media (max-width: 720px) {
  html.krew #content { padding: 16px max(16px, env(safe-area-inset-left, 0px)) 40px !important; font-size: 16px !important; }
  html.krew .infobox { float: none !important; width: 100% !important; max-width: 100% !important; margin: 0 0 16px !important; }
  html.krew .mw-parser-output table.terraria,
  html.krew .mw-parser-output table.wikitable { display: block; overflow-x: auto; max-width: 100%; }
}

/* ----- Skin controls ----- */
#krew-controls {
  position: fixed;
  right: max(14px, env(safe-area-inset-right, 0px));
  bottom: max(14px, env(safe-area-inset-bottom, 0px));
  z-index: 9999;
  display: flex; gap: 6px;
  font: 700 13px/1 "Atkinson Hyperlegible", system-ui, sans-serif;
}
#krew-controls button {
  background: #1b1e2d; color: #e8e5da;
  border: 1px solid #2f3452; border-radius: 999px;
  padding: 9px 14px; cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .4);
}
#krew-controls button:hover { border-color: #f2b35a; color: #f2b35a; }
#krew-controls button:focus-visible { outline: 2px solid #f2b35a; outline-offset: 2px; }
html:not(.krew) #krew-controls .krew-only { display: none; }
`;

  // At document-start the page may not exist yet, so wait for <html> before touching it.
  function whenRoot(fn) {
    if (document.documentElement) return fn(document.documentElement);
    const mo = new MutationObserver(() => {
      if (document.documentElement) { mo.disconnect(); fn(document.documentElement); }
    });
    mo.observe(document, { childList: true });
  }

  function apply() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("krew", prefs.on);
    root.classList.toggle("krew-menu", prefs.menu);
  }

  whenRoot(root => {
    const style = document.createElement("style");
    style.id = "krew-skin-css";
    style.textContent = CSS;
    (document.head || root).appendChild(style);
    apply();
    watchForAds(root);
  });

  /* ---------- Ad cleanup ---------- */
  // Ads are injected after load, so check new elements as they appear.
  const AD_WORD = /(^|[\s_-])(ad|ads|advert|advertisement|adslot|adunit|adwrap|ad-container|sponsor|sponsored)([\s_-]|$)/i;
  const AD_HOST = /doubleclick|googlesyndication|adservice|amazon-adsystem|adnxs|rubiconproject|pubmatic|criteo|taboola|outbrain|nitropay|playwire|venatus/i;

  function isAd(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest("#mw-content-text .mw-parser-output") && !el.matches("iframe, ins")) return false; // never touch article content
    const tag = el.tagName;
    if ((tag === "IFRAME" || tag === "SCRIPT" || tag === "IMG") && AD_HOST.test(el.src || "")) return true;
    const label = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "");
    return AD_WORD.test(label);
  }
  function sweep(scope) {
    if (!prefs.on) return;
    const els = scope.querySelectorAll ? scope.querySelectorAll("div, aside, section, iframe, ins") : [];
    if (isAd(scope)) scope.classList.add("krew-ad-hidden");
    els.forEach(el => { if (isAd(el)) el.classList.add("krew-ad-hidden"); });
  }
  function watchForAds(root) {
    new MutationObserver(list => {
      for (const m of list) m.addedNodes.forEach(n => { if (n.nodeType === 1) sweep(n); });
    }).observe(root, { childList: true, subtree: true });
  }

  /* ---------- Controls ---------- */
  function addControls() {
    if (document.getElementById("krew-controls")) return;
    const box = document.createElement("div");
    box.id = "krew-controls";
    box.innerHTML =
      '<button type="button" class="krew-only" data-act="menu"></button>' +
      '<button type="button" data-act="skin"></button>';
    const label = () => {
      box.querySelector('[data-act="menu"]').textContent = prefs.menu ? "Hide menu" : "Menu";
      box.querySelector('[data-act="skin"]').textContent = prefs.on ? "Original look" : "Krew skin";
    };
    box.addEventListener("click", e => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "menu") prefs.menu = !prefs.menu;
      if (act === "skin") prefs.on = !prefs.on;
      save(); apply(); label();
      if (prefs.on) sweep(document.body);
    });
    label();
    document.body.appendChild(box);
  }

  // Press / anywhere to jump to the wiki search box.
  document.addEventListener("keydown", e => {
    const t = e.target;
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const search = document.getElementById("searchInput");
    if (search) { e.preventDefault(); search.focus(); search.select(); }
  });

  function ready() { sweep(document.body); addControls(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();
