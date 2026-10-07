# Builds the worksheet library for Math Catch-Up from the unzipped Herring files.
import json, os, re, shutil, subprocess, sys
raw, out = sys.argv[1], sys.argv[2]
text = open(os.path.join(raw, "ALL_TEXT.md"), encoding="utf-8").read()
sections = re.split(r"^### ", text, flags=re.M)[1:]
titles, texts = {}, {}
for sec in sections:
    head, _, body = sec.partition("\n")
    m = re.match(r"(.*?)\s+\((term-\d/.+?\.pdf)\)\s*$", head)
    if not m: continue
    title, path = m.group(1).strip(), m.group(2)
    titles[path] = title
    texts[path] = re.sub(r"\n{3,}", "\n\n", body.split("\n## Term")[0]).strip()
def slug(s): return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
if os.path.exists(out): shutil.rmtree(out)
catalog, tx, used = [], {}, set()
for term in sorted(os.listdir(os.path.join(raw, "files"))):
    for fn in sorted(os.listdir(os.path.join(raw, "files", term))):
        if not fn.endswith(".pdf"): continue
        rel = f"{term}/{fn}"
        title = titles.get(rel) or fn[:-4].replace("_ ", ": ")
        t = "t" + term.split("-")[1]
        base = slug(fn[:-4]) or "file"
        s = base; i = 2
        while f"{t}/{s}" in used: s = f"{base}-{i}"; i += 1
        used.add(f"{t}/{s}")
        dest = os.path.join(out, t, s + ".pdf")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(os.path.join(raw, "files", term, fn), dest)
        pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", dest], capture_output=True, text=True).stdout).group(1))
        wid = f"{t}-{s}"
        catalog.append({"id": wid, "term": int(t[1:]), "title": title, "file": f"lib/{t}/{s}.pdf", "pages": pages,
                        "key": bool(re.search(r"\bkey\b", title, re.I))})
        tx[wid] = texts.get(rel, "")
json.dump(catalog, open(os.path.join(out, "catalog.json"), "w"), ensure_ascii=False, separators=(",", ":"))
json.dump(tx, open(os.path.join(out, "text.json"), "w"), ensure_ascii=False, separators=(",", ":"))
print(len(catalog), "worksheets;", sum(c["pages"] for c in catalog), "pages;", sum(1 for c in catalog if c["key"]), "answer keys;",
      sum(1 for v in tx.values() if v), "with text")
