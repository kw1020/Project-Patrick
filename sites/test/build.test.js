import { test } from "node:test";
import assert from "node:assert/strict";
import { render, validate, esc, inkOn } from "../build.js";

const base = {
  name: "Joe's Plumbing",
  type: "Plumber",
  city: "Dayton",
  phone: "(937) 555-0101",
  services: [{ name: "Drain cleaning", desc: "Fast", price: "$99" }],
};

test("rejects a profile missing required fields", () => {
  assert.throws(() => validate({ ...base, phone: "" }), /phone/);
  assert.throws(() => validate({ ...base, services: [] }), /services/);
  assert.throws(() => validate({ ...base, accent: "green" }), /accent/);
});

test("escapes user text everywhere", () => {
  const html = render({ ...base, name: "<script>x</script>", about: `"quoted" & <b>` });
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(html.includes("&quot;quoted&quot; &amp; &lt;b&gt;"));
  assert.equal(esc("'"), "&#39;");
});

test("JSON-LD cannot break out of its script tag", () => {
  const html = render({ ...base, name: "</script><img src=x>" });
  const ld = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1];
  assert.ok(!ld.includes("<"));
  assert.equal(JSON.parse(ld).name, "</script><img src=x>");
});

test("phone becomes tap-to-call and text links", () => {
  const html = render(base);
  assert.ok(html.includes('href="tel:9375550101"'));
  assert.ok(html.includes('href="sms:9375550101"'));
});

test("optional sections only appear when filled in", () => {
  const html = render(base);
  assert.ok(!html.includes('id="reviews"'));
  assert.ok(!html.includes("<form"));
  const full = render({ ...base, reviews: [{ quote: "Great", name: "Ann" }], formAction: "https://formspree.io/f/abc" });
  assert.ok(full.includes('id="reviews"'));
  assert.ok(full.includes('action="https://formspree.io/f/abc"'));
});

test("button text color stays readable on the accent", () => {
  assert.equal(inkOn("#ffeb3b"), "#111111");
  assert.equal(inkOn("#1a237e"), "#ffffff");
});
