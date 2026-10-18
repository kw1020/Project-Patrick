// ==UserScript==
// @name         Krew's Terraria Wiki (No Ads)
// @namespace    project-patrick
// @version      2.0.0
// @description  The official Terraria Wiki exactly as it looks, minus the ads.
// @match        https://terraria.wiki.gg/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // Only ads are hidden. The wiki's own layout, colors and theme are left untouched.
  const CSS = `
.adsbygoogle,
ins.adsbygoogle,
[id^="div-gpt-ad"],
[id^="google_ads"],
[data-ad-slot],
[data-ad-client],
[data-google-query-id],
iframe[src*="doubleclick"],
iframe[src*="googlesyndication"],
iframe[src*="amazon-adsystem"],
iframe[id^="google_ads_iframe"],
.krew-ad-hidden { display: none !important; }
`;

  // Ads are injected after the page loads, so check new elements as they appear.
  const AD_WORD = /(^|[\s_-])(ad|ads|advert|advertisement|adslot|adunit|adwrap|ad-container|sponsor|sponsored)([\s_-]|$)/i;
  const AD_HOST = /doubleclick|googlesyndication|adservice|amazon-adsystem|adnxs|rubiconproject|pubmatic|criteo|taboola|outbrain|nitropay|playwire|venatus/i;

  function isAd(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest("#mw-content-text .mw-parser-output") && !el.matches("iframe, ins")) return false; // never touch article content
    if ((el.tagName === "IFRAME" || el.tagName === "IMG") && AD_HOST.test(el.src || "")) return true;
    const label = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "");
    return AD_WORD.test(label);
  }

  function sweep(scope) {
    if (isAd(scope)) scope.classList.add("krew-ad-hidden");
    if (scope.querySelectorAll) {
      scope.querySelectorAll("div, aside, section, iframe, ins").forEach(el => {
        if (isAd(el)) el.classList.add("krew-ad-hidden");
      });
    }
  }

  // At document-start the page may not exist yet, so wait for <html> before touching it.
  function whenRoot(fn) {
    if (document.documentElement) return fn(document.documentElement);
    const mo = new MutationObserver(() => {
      if (document.documentElement) { mo.disconnect(); fn(document.documentElement); }
    });
    mo.observe(document, { childList: true });
  }

  whenRoot(root => {
    const style = document.createElement("style");
    style.id = "krew-noads-css";
    style.textContent = CSS;
    (document.head || root).appendChild(style);

    new MutationObserver(list => {
      for (const m of list) m.addedNodes.forEach(n => { if (n.nodeType === 1) sweep(n); });
    }).observe(root, { childList: true, subtree: true });
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => sweep(document.body));
  else sweep(document.body);
})();
