import * as esbuild from "esbuild";
import { cp, mkdir, rm, readdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await mkdir("dist/offscreen", { recursive: true });
await mkdir("dist/models", { recursive: true });

// ─── OCR vendor assets (tesseract.js) ──────────────────────────────────────
// Static files the offscreen document loads via chrome.runtime.getURL —
// never fetched from a CDN, so OCR works offline and under MV3 CSP.
await mkdir("dist/vendor", { recursive: true });
await mkdir("dist/vendor/tesseract-core", { recursive: true });
await mkdir("dist/vendor/lang", { recursive: true });
await cp("node_modules/tesseract.js/dist/worker.min.js", "dist/vendor/worker.min.js");
for (const f of [
  "tesseract-core-simd-lstm.js", "tesseract-core-simd-lstm.wasm", "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.js", "tesseract-core-relaxedsimd-lstm.wasm", "tesseract-core-relaxedsimd-lstm.wasm.js",
  "tesseract-core-lstm.js", "tesseract-core-lstm.wasm", "tesseract-core-lstm.wasm.js",
]) {
  await cp(`node_modules/tesseract.js-core/${f}`, `dist/vendor/tesseract-core/${f}`);
}
await cp(
  "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  "dist/vendor/lang/eng.traineddata.gz",
);

// Static assets are copied verbatim; only the TS entrypoints get bundled.
await cp("src/manifest.json", "dist/manifest.json");
await cp("src/sidepanel/index.html", "dist/sidepanel.html");
await cp("src/sidepanel/styles.css", "dist/styles.css");
await cp("src/assets/fonts", "dist/fonts", { recursive: true });
await cp("src/options/index.html", "dist/options.html");
await cp("src/offscreen/index.html", "dist/offscreen.html");
await cp("src/inspector/index.html", "dist/inspector.html");
await cp("src/inspector/inspector.css", "dist/inspector.css");
await cp("icons", "dist/icons", { recursive: true });

// Copy model files if they exist.
try {
  await cp("models", "dist/models", { recursive: true });
} catch {
  // Models directory may not exist yet — that's fine, the extension
  // degrades gracefully to DOM-only perception.
}

// ─── ML runtime assets (Tier 0) ──────────────────────────────────────────────
// ONNX Runtime wasm binaries (transformers.js resolves them from this exact
// directory) and the MediaPipe tasks-vision wasm (BlazeFace). Both are
// vendored so no inference code is ever fetched from a CDN.
try {
  await mkdir("dist/vendor/ort", { recursive: true });
  for (const f of await readdir("node_modules/onnxruntime-web/dist")) {
    if (f.endsWith(".wasm") || f.endsWith(".mjs")) {
      await cp(`node_modules/onnxruntime-web/dist/${f}`, `dist/vendor/ort/${f}`);
    }
  }
} catch {
  // onnxruntime-web not installed — ML features degrade, extension still works.
}
try {
  await mkdir("dist/vendor/mediapipe/wasm", { recursive: true });
  for (const f of await readdir("node_modules/@mediapipe/tasks-vision/wasm")) {
    await cp(`node_modules/@mediapipe/tasks-vision/wasm/${f}`, `dist/vendor/mediapipe/wasm/${f}`);
  }
} catch {
  // Same degrade: BlazeFace falls back to skin-color.
}

/**
 * The Anthropic SDK statically imports node:fs / node:path for its file-based
 * credential chain (profiles, identity-token files). None of that can run in a
 * browser and none of it executes when the client is constructed with an
 * explicit apiKey, so we resolve those specifiers to an empty module rather
 * than shipping a Node polyfill.
 */
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      namespace: "node-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

const shared = {
  outdir: "dist",
  bundle: true,
  platform: "browser",
  plugins: [stubNodeBuiltins],
  target: "chrome120",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  // Production builds strip diagnostic console.log; warn/error survive
  // (they carry the voice and recovery messages users need).
  pure: watch ? [] : ["console.log"],
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
  },
};

const builds = [
  // Service worker, side panel, options, and offscreen document load as ES modules.
  {
    ...shared,
    format: "esm",
    entryPoints: {
      "service-worker": "src/background/service-worker.ts",
      sidepanel: "src/sidepanel/sidepanel.ts",
      options: "src/options/options.ts",
      inspector: "src/inspector/inspector.ts",
      "offscreen/offscreen": "src/offscreen/offscreen.ts",
    },
  },
  // Content scripts are not modules in MV3 — must be a self-contained IIFE.
  {
    ...shared,
    format: "iife",
    entryPoints: {
      content: "src/content/content.ts",
      tripwire: "src/content/tripwire.ts",
    },
  },
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.log("watching…");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log("build complete");
}
