import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadJudgePrompt, JUDGE_SYSTEM } from "../src/lib/judge";

test("loadJudgePrompt returns exactly the block between the markers", () => {
  const text = "# Title\n\nintro\n\n## SYSTEM\n\nLine one.\n\nLine two.\n\n## END SYSTEM\ntrailer\n";
  assert.equal(loadJudgePrompt(text), "Line one.\n\nLine two.");
});

test("loadJudgePrompt throws a clear error when markers are missing", () => {
  assert.throws(() => loadJudgePrompt("no markers here"), /prompts\/judge\.md/);
  assert.throws(() => loadJudgePrompt("## SYSTEM\nbody but no end"), /prompts\/judge\.md/);
  assert.throws(() => loadJudgePrompt("body\n## END SYSTEM"), /prompts\/judge\.md/);
});

test("JUDGE_SYSTEM is the SYSTEM block of prompts/judge.md", () => {
  const file = fs.readFileSync(path.join(__dirname, "..", "prompts", "judge.md"), "utf8");
  const block = file.split("\n## SYSTEM\n")[1].split("\n## END SYSTEM")[0].trim();
  assert.equal(JUDGE_SYSTEM, block);
  assert.ok(JUDGE_SYSTEM.startsWith("You score short gameplay clips"));
  assert.ok(!JUDGE_SYSTEM.includes("## "), "no headings in the prompt");
});
