import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
const [prefix, frames, scale = "0.5"] = process.argv.slice(2);
// CHROME = path to Chrome/Chromium (unset = Remotion downloads its own). GL = angle (GPU, Windows/Mac) or swangle (no GPU).
const browserExecutable = process.env.CHROME || null;
const chromiumOptions = { gl: process.env.GL || "angle" };
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts"), publicDir: path.resolve("public") });
const inputProps = process.env.POST ? { post: JSON.parse(process.env.POST) } : {};
const composition = await selectComposition({ serveUrl, id: process.env.COMP || "BridgeShort", browserExecutable, chromiumOptions, inputProps });
console.log("comp", composition.durationInFrames, "frames");
const onBrowserLog = (l) => { if ((l.type === "error" || l.type === "warning" || process.env.ALL) && !l.text.includes("404")) console.log(`[${l.type}]`, l.text.slice(0, 300)); };
for (const f of frames.split(",").map(Number)) {
  const t0 = Date.now();
  await renderStill({ composition, serveUrl, frame: f, output: `${prefix}${f}.jpg`, imageFormat: "jpeg", jpegQuality: 88, scale: Number(scale), inputProps, browserExecutable, chromiumOptions, timeoutInMilliseconds: 300000, onBrowserLog });
  console.log("still", f, ((Date.now() - t0) / 1000).toFixed(1) + "s");
}
