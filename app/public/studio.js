// Studio tab: clip long videos, render shorts from ideas, review captions,
// approve, and schedule to TikTok / Instagram / YouTube through Postiz.
const PASS_KEY = "patrick.passcode";
const PLATFORMS = [["tiktok", "TikTok"], ["instagram", "Instagram"], ["youtube", "YouTube"]];
const REFRESH_MS = 10_000;

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null) node.append(kid);
  }
  return node;
}

function passcode() {
  try { return localStorage.getItem(PASS_KEY) || ""; } catch { return ""; }
}

function setStatus(text, isError = false) {
  const s = $("studio-status");
  s.textContent = text;
  s.classList.toggle("err", isError);
}

async function api(method, path, body) {
  const res = await fetch(`/api/studio${path}`, {
    method,
    headers: { "content-type": "application/json", "x-patrick-key": passcode() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Studio error (${res.status}).`);
  return data;
}

// ---------- actions ----------
let busy = false;
async function run(label, fn) {
  if (busy) return;
  busy = true;
  setStatus(label);
  try {
    await fn();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    busy = false;
  }
}

$("clip-go").addEventListener("click", () =>
  run("Sending to OpenShorts...", async () => {
    const url = $("clip-url").value.trim();
    if (!url) throw new Error("Paste a video link first.");
    await api("POST", "/clip", { url });
    $("clip-url").value = "";
    setStatus("Clipping. Long videos take a few minutes per 10 minutes of footage.");
    await refresh();
  }),
);

$("clip-file-btn").addEventListener("click", () => {
  if (!busy) $("clip-file").click();
});

$("clip-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  run("Uploading...", () => upload(file));
});

// XHR instead of fetch so the upload can report progress.
function upload(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/studio/upload");
    xhr.setRequestHeader("x-patrick-key", passcode());
    xhr.setRequestHeader("x-filename", file.name);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setStatus(`Uploading... ${Math.round((ev.loaded / ev.total) * 100)}%`);
    };
    xhr.onload = async () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 400) return reject(new Error(data.error || `Upload failed (${xhr.status}).`));
      setStatus("Uploaded. Clipping now.");
      await refresh();
      resolve();
    };
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
    xhr.send(file);
  });
}

$("short-go").addEventListener("click", () =>
  run("Patrick is writing the script...", async () => {
    const topic = $("short-topic").value.trim();
    if (!topic) throw new Error("Give Patrick a topic.");
    await api("POST", "/short", { topic });
    $("short-topic").value = "";
    setStatus("Script written. Rendering the video (a minute or two).");
    await refresh();
  }),
);

// ---------- rendering ----------
let timer = null;
let visible = false;
let editing = new Set(); // items with unsaved edits are not redrawn

function renderServices(svc) {
  const box = $("studio-services");
  const rows = [
    ["OpenShorts (clipping)", svc.openshorts],
    ["short-video-maker (shorts)", svc.shortmaker],
    ["Postiz (posting)", svc.postiz],
    ["Claude (captions)", svc.claude],
  ];
  const off = rows.filter(([, on]) => !on);
  box.hidden = !off.length && !svc.mock;
  const grid = el("div", { class: "svc" });
  for (const [name, on] of rows) grid.append(el("span", {}, name), el("span", { class: on ? "on" : "off" }, on ? "ready" : "not set up"));
  box.replaceChildren(
    el("h2", {}, svc.mock ? "Mock mode: nothing is really rendered or posted" : "Setup needed"),
    grid,
    ...(off.length ? [el("p", { class: "sub" }, "Run the studio stack and set its keys. See studio/README.md.")] : []),
  );
}

function renderJobs(jobs) {
  const live = jobs.filter((j) => j.status === "rendering" || (j.status === "failed" && Date.now() - Date.parse(j.updatedAt) < 864e5));
  $("studio-jobs").replaceChildren(
    ...live.map((j) =>
      el("article", { class: "card entry" },
        el("header", {}, el("strong", {}, j.kind === "clip" ? "Clipping" : "Rendering short"), el("span", { class: `pill ${j.status}` }, j.status)),
        el("p", { class: "sub", style: "margin:0;word-break:break-all" }, j.title || j.source),
        j.error ? el("p", { class: "sub", style: "margin:0;color:var(--pass)" }, j.error) : null),
    ),
  );
}

function field(label, node) {
  return el("div", {}, el("label", {}, label), node);
}

function readForm(form) {
  const v = (name) => form.querySelector(`[name="${name}"]`).value;
  return {
    platforms: PLATFORMS.map(([p]) => p).filter((p) => form.querySelector(`[name="pf-${p}"]`).checked),
    captions: {
      tiktok: { caption: v("tiktok") },
      instagram: { caption: v("instagram") },
      youtube: { title: v("yt-title"), description: v("yt-desc"), tags: v("yt-tags").split(",").map((t) => t.trim()).filter(Boolean) },
    },
  };
}

function renderItem(item) {
  const video = item.video
    ? el("video", { src: `/api/studio/video/${item.id}?key=${encodeURIComponent(passcode())}`, controls: true, playsinline: true, preload: "metadata" })
    : el("p", { class: "sub" }, "(Mock mode: no video file.)");
  const head = el("header", {}, el("strong", {}, item.title), el("span", { class: `pill ${item.status}` }, item.status));
  const meta = el("p", { class: "sub", style: "margin:0" },
    [item.kind === "clip" ? "Clip" : "AI short", item.seconds ? `${Math.round(item.seconds)}s` : null].filter(Boolean).join(" · "));

  if (item.status === "scheduled") {
    const when = new Date(item.postiz.date).toLocaleString();
    return el("article", { class: "card clip" }, head, meta, video,
      el("p", { class: "sub", style: "margin:0" }, `${item.postiz.type === "now" ? "Posting now" : `Scheduled for ${when}`} on ${item.postiz.platforms.join(", ")}. Track it in Postiz.`));
  }

  const c = item.captions;
  const form = el("form", { class: "clip", onsubmit: (e) => e.preventDefault(), oninput: () => editing.add(item.id) },
    el("div", { class: "checks" },
      PLATFORMS.map(([p, name]) => el("label", {}, el("input", { type: "checkbox", name: `pf-${p}`, checked: item.platforms.includes(p) }), name))),
    field("TikTok caption", el("textarea", { name: "tiktok", rows: "3" }, c.tiktok.caption)),
    field("Instagram caption", el("textarea", { name: "instagram", rows: "5" }, c.instagram.caption)),
    field("YouTube title", el("input", { type: "text", name: "yt-title", maxlength: "100", value: c.youtube.title })),
    field("YouTube description", el("textarea", { name: "yt-desc", rows: "3" }, c.youtube.description)),
    field("YouTube tags (comma separated)", el("input", { type: "text", name: "yt-tags", value: c.youtube.tags.join(", ") })),
    field("Post at (leave empty to post now)", el("input", { type: "datetime-local", name: "when" })),
  );

  const approve = () =>
    run("Uploading to Postiz and scheduling...", async () => {
      const data = readForm(form);
      const when = form.querySelector('[name="when"]').value;
      if (!data.platforms.length) throw new Error("Tick at least one platform.");
      await api("PUT", `/${item.id}`, data);
      editing.delete(item.id);
      await api("POST", `/${item.id}/approve`, { platforms: data.platforms, when: when ? new Date(when).toISOString() : null });
      setStatus(when ? "Scheduled." : "Sent to Postiz to post now.");
      await refresh();
    });
  const save = () =>
    run("Saving...", async () => {
      await api("PUT", `/${item.id}`, readForm(form));
      editing.delete(item.id);
      setStatus("Saved.");
    });
  const reject = () => {
    if (!confirm("Throw this one away?")) return;
    run("Removing...", async () => {
      await api("POST", `/${item.id}/reject`);
      editing.delete(item.id);
      setStatus("");
      await refresh();
    });
  };

  return el("article", { class: "card clip", "data-id": item.id }, head, meta, video, form,
    el("div", { class: "actions" },
      el("button", { class: "btn primary", type: "button", onclick: approve }, "Approve"),
      el("button", { class: "btn", type: "button", onclick: save }, "Save"),
      el("button", { class: "btn", type: "button", onclick: reject }, "Reject")));
}

function renderQueue(items) {
  const box = $("studio-queue");
  if (!items.length) {
    box.replaceChildren(el("p", { class: "empty" }, "Nothing to review yet. Clip a video or make a short."));
    return;
  }
  // Keep cards being edited (and their playing videos) in place.
  const existing = new Map([...box.querySelectorAll("article[data-id]")].map((n) => [n.dataset.id, n]));
  const keep = (node) => node && (editing.has(node.dataset.id) || node.querySelector("video")?.paused === false);
  box.replaceChildren(...items.map((it) => {
    const node = existing.get(it.id);
    return it.status === "ready" && keep(node) ? node : renderItem(it);
  }));
}

async function refresh() {
  try {
    const data = await api("GET", "");
    renderServices(data.services);
    renderJobs(data.jobs);
    renderQueue(data.items);
    schedule(data.jobs.some((j) => j.status === "rendering"));
  } catch (err) {
    setStatus(err.message, true);
  }
}

function schedule(pending) {
  clearTimeout(timer);
  if (visible && pending) timer = setTimeout(refresh, REFRESH_MS);
}

document.addEventListener("patrick:tab", (e) => {
  visible = e.detail === "studio";
  if (visible) refresh();
  else clearTimeout(timer);
});
