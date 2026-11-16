// usage: node video.mjs <out.mp4> <from> <to> [scale] [dpr] [concurrency]
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "node:path";
const [out, from, to, scale = "0.5", dpr = "0.5", conc = "2"] = process.argv.slice(2);
const browserExecutable = process.env.CHROME || null;
const chromiumOptions = { gl: process.env.GL || "angle" };
const inputProps = { post: { dpr: Number(dpr) } };
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts"), publicDir: path.resolve("public") });
const composition = await selectComposition({ serveUrl, id: process.env.COMP || "EmuShort", browserExecutable, chromiumOptions, inputProps });
const t0 = Date.now(); let last = 0;
await renderMedia({ composition, serveUrl, codec: "h264", crf: 18, outputLocation: out, inputProps, scale: Number(scale), browserExecutable, chromiumOptions,
  frameRange: [Number(from), Number(to)], concurrency: Number(conc), timeoutInMilliseconds: 600000, muted: true,
  onProgress: ({ renderedFrames }) => { if (renderedFrames - last >= 10) { last = renderedFrames; console.log("frames", renderedFrames, ((Date.now() - t0) / 1000).toFixed(0) + "s"); } } });
console.log("done", ((Date.now() - t0) / 1000).toFixed(0) + "s");
