// Weak static checks for the Windows launcher scripts (no PowerShell in the sandbox to parse them for real).
// Catches: unbalanced () {} [], unclosed quotes, non-ASCII bytes (PowerShell 5.1 reads BOM-less files as ANSI),
// LF line endings, PowerShell 7-only operators, and calls to Verb-Noun commands that are neither defined in
// the scripts nor in the known-cmdlet list (typos). It does NOT prove the scripts run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const winDir = path.join(root, "scripts", "windows");
const ps1Files = fs.readdirSync(winDir).filter((f) => f.endsWith(".ps1")).map((f) => path.join(winDir, f));
const setupDir = path.join(root, "setup");
const batFiles = [
  ...fs.readdirSync(root).filter((f) => f.endsWith(".bat")).map((f) => path.join(root, f)),
  ...fs.readdirSync(setupDir).filter((f) => f.endsWith(".bat")).map((f) => path.join(setupDir, f)),
];

const KNOWN_CMDLETS = new Set([
  "Add-Content", "Add-Type", "Copy-Item", "Get-ChildItem", "Get-Command", "Get-Content", "Get-Date",
  "Invoke-WebRequest", "Join-Path", "New-Item", "New-Object", "Out-Null", "Out-String", "Read-Host",
  "Remove-Item", "Select-Object", "Set-Location", "Split-Path", "Start-Process", "Start-Sleep", "Test-Path",
  "Write-Host",
]);

// Returns each line's code with strings and comments blanked out, plus errors found while scanning.
function scan(src: string): { lines: string[]; errors: string[] } {
  const errors: string[] = [];
  const out: string[] = [];
  const stack: { ch: string; line: number }[] = [];
  const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  let inBlockComment = false;
  src.split(/\r\n/).forEach((line, idx) => {
    const ln = idx + 1;
    let code = "";
    let i = 0;
    if (/@["']\s*$/.test(line) || /^["']@/.test(line)) errors.push(`line ${ln}: here-string (not allowed, hard to check)`);
    while (i < line.length) {
      const c = line[i];
      if (inBlockComment) {
        if (line.startsWith("#>", i)) { inBlockComment = false; i += 2; } else i++;
        continue;
      }
      if (line.startsWith("<#", i)) { inBlockComment = true; i += 2; continue; }
      if (c === "#") break;
      if (c === "`") { code += "  "; i += 2; continue; }
      if (c === "'") {
        let j = i + 1;
        for (;;) {
          if (j >= line.length) { errors.push(`line ${ln}: unclosed single quote`); break; }
          if (line[j] === "'" && line[j + 1] === "'") { j += 2; continue; }
          if (line[j] === "'") break;
          j++;
        }
        code += " ".repeat(Math.min(j, line.length) - i + 1);
        i = j + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        let depth = 0; // inside $( ... )
        for (;;) {
          if (j >= line.length) { errors.push(`line ${ln}: unclosed double quote`); break; }
          const d = line[j];
          if (d === "`") { j += 2; continue; }
          if (depth === 0 && d === '"' && line[j + 1] === '"') { j += 2; continue; }
          if (depth === 0 && d === '"') break;
          if (d === "$" && line[j + 1] === "(") { depth++; j += 2; continue; }
          if (depth > 0 && d === "(") depth++;
          if (depth > 0 && d === ")") depth--;
          if (depth > 0 && d === '"') errors.push(`line ${ln}: nested quotes inside $() in a string`);
          j++;
        }
        code += " ".repeat(Math.min(j, line.length) - i + 1);
        i = j + 1;
        continue;
      }
      if ("({[".includes(c)) stack.push({ ch: c, line: ln });
      if (")}]".includes(c)) {
        const top = stack.pop();
        if (!top || top.ch !== pairs[c]) errors.push(`line ${ln}: '${c}' does not match ${top ? `'${top.ch}' from line ${top.line}` : "anything"}`);
      }
      code += c;
      i++;
    }
    for (const op of ["??", "?.", "&&", "||"]) {
      if (code.includes(op)) errors.push(`line ${ln}: PowerShell 7-only operator '${op}'`);
    }
    if (/\s-Parallel\b/.test(code)) errors.push(`line ${ln}: ForEach-Object -Parallel is PowerShell 7-only`);
    out.push(code);
  });
  if (inBlockComment) errors.push("unclosed <# block comment");
  for (const s of stack) errors.push(`line ${s.line}: '${s.ch}' never closed`);
  return { lines: out, errors };
}

function defined(files: string[]): Set<string> {
  const names = new Set<string>();
  for (const f of files) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/^\s*function\s+([A-Za-z]+-[A-Za-z]+)/gm)) names.add(m[1].toLowerCase());
  }
  return names;
}

test("windows scripts: ASCII only, CRLF line endings", () => {
  for (const f of [...ps1Files, ...batFiles]) {
    const buf = fs.readFileSync(f);
    for (let i = 0; i < buf.length; i++) assert.ok(buf[i] < 0x80, `${path.basename(f)}: non-ASCII byte at offset ${i}`);
    const text = buf.toString("latin1");
    assert.ok(text.endsWith("\r\n"), `${path.basename(f)}: must end with CRLF`);
    assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, `${path.basename(f)}: has LF-only line endings`);
  }
});

test("windows scripts: brackets, quotes, PowerShell 5.1 syntax, known commands", () => {
  const fns = defined(ps1Files);
  for (const f of ps1Files) {
    const { lines, errors } = scan(fs.readFileSync(f, "latin1"));
    lines.forEach((code, idx) => {
      for (const m of code.matchAll(/(?<![\w$:.-])([A-Z][a-z]+-[A-Z][A-Za-z]+)\b/g)) {
        if (!fns.has(m[1].toLowerCase()) && !KNOWN_CMDLETS.has(m[1])) errors.push(`line ${idx + 1}: unknown command ${m[1]}`);
      }
    });
    assert.deepEqual(errors, [], `${path.basename(f)}:\n${errors.join("\n")}`);
  }
});

test("Clip Factory.bat stays no longer than the old one (cmd keeps reading it after git pull)", () => {
  // The old launcher was 97 bytes and was still open in cmd.exe while its start.ps1 ran `git pull`.
  // cmd resumes at byte 97 of the NEW file afterwards; a longer file would run a fragment of a line.
  const size = fs.statSync(path.join(root, "Clip Factory.bat")).size;
  assert.ok(size <= 97, `Clip Factory.bat is ${size} bytes`);
});
