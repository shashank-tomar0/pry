/**
 * Offscreen pipeline integration test.
 *
 * WHY THIS EXISTS
 *
 * Everything else in `npm run verify` tests pure policy modules. Nothing executed
 * the offscreen document's actual redaction path, which is where the pipeline's
 * user-visible promises are made: which pixels are painted, what gets reported,
 * and whether the egress evidence object is ever produced. That gap is how a
 * dead vision path (the evidence object was never written) and proof markers that
 * drift off their masks (the box was derived from the source region, not the
 * painted rect) both survived a green test suite.
 *
 * So this harness bundles the REAL `src/offscreen/offscreen.ts`, stubs only its
 * browser-facing dependencies (canvas, blobs, models, OCR), and drives its real
 * message listener with a `process-screenshot` message — the same call the
 * service worker makes. Assertions then read the reply the same way the service
 * worker does.
 *
 * The canvas stub is a software rasteriser over a real RGBA buffer, so
 * `getImageData`/`putImageData`/`fillRect`/`drawImage` all affect actual pixels
 * and the module's own verification pass runs against them. Nothing about the
 * redaction logic is reimplemented here.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// ─── Software canvas ────────────────────────────────────────────────────────

function makeCanvas(width, height) {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
}

/** Copy `src` (canvas or bitmap) into `dst`, honouring the drawImage forms. */
function blit(dst, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  for (let y = 0; y < dh; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    const srcY = sh === dh ? sy + y : sy + Math.floor((y * sh) / dh);
    for (let x = 0; x < dw; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const srcX = sw === dw ? sx + x : sx + Math.floor((x * sw) / dw);
      if (srcX < 0 || srcX >= src.width || srcY < 0 || srcY >= src.height) continue;
      const s = (srcY * src.width + srcX) * 4;
      const t = (ty * dst.width + tx) * 4;
      dst.data[t] = src.data[s];
      dst.data[t + 1] = src.data[s + 1];
      dst.data[t + 2] = src.data[s + 2];
      dst.data[t + 3] = src.data[s + 3];
    }
  }
}

function makeContext(canvas) {
  const ctx = {
    canvas,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    font: "10px sans-serif",
    textBaseline: "alphabetic",
    textAlign: "start",
    /** Every fillRect this context performed, in device pixels. */
    fills: [],
    /** Every blur radius requested (the module passes it through). */
    drawImage(src, a, b, c, d, e, f, g, h) {
      const source = src.source ?? src;
      if (g === undefined) {
        blit(canvas, source, 0, 0, source.width, source.height, a, b, c ?? source.width, d ?? source.height);
      } else {
        blit(canvas, source, a, b, c, d, e, f, g, h);
      }
    },
    fillRect(x, y, w, h) {
      ctx.fills.push({ x, y, width: w, height: h, color: ctx.fillStyle });
      const [r, g, b] = parseColor(ctx.fillStyle);
      for (let py = y; py < y + h; py++) {
        for (let px = x; px < x + w; px++) {
          if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
          const i = (py * canvas.width + px) * 4;
          canvas.data[i] = r;
          canvas.data[i + 1] = g;
          canvas.data[i + 2] = b;
          canvas.data[i + 3] = 255;
        }
      }
    },
    strokeRect() {},
    fillText() {
      // Deliberately a no-op: the surrogate tier's TEXT is not what this test
      // measures. Its fill + stroke are, and those are already recorded.
    },
    measureText(t) {
      return { width: String(t).length * 6 };
    },
    getImageData(x, y, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const s = ((y + py) * canvas.width + (x + px)) * 4;
          const t = (py * w + px) * 4;
          out[t] = canvas.data[s];
          out[t + 1] = canvas.data[s + 1];
          out[t + 2] = canvas.data[s + 2];
          out[t + 3] = canvas.data[s + 3];
        }
      }
      return { width: w, height: h, data: out };
    },
    putImageData(img, x, y) {
      for (let py = 0; py < img.height; py++) {
        for (let px = 0; px < img.width; px++) {
          const s = (py * img.width + px) * 4;
          const t = ((y + py) * canvas.width + (x + px)) * 4;
          if (t < 0 || t + 3 >= canvas.data.length) continue;
          canvas.data[t] = img.data[s];
          canvas.data[t + 1] = img.data[s + 1];
          canvas.data[t + 2] = img.data[s + 2];
          canvas.data[t + 3] = img.data[s + 3];
        }
      }
    },
    save() {},
    restore() {},
    setLineDash() {},
  };
  return ctx;
}

function parseColor(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(value));
  if (hex) {
    return [
      parseInt(hex[1].slice(0, 2), 16),
      parseInt(hex[1].slice(2, 4), 16),
      parseInt(hex[1].slice(4, 6), 16),
    ];
  }
  return [0, 0, 0];
}

// ─── Browser globals the offscreen document touches ─────────────────────────

const blobPayload = new WeakMap();
function makeBlob(canvas) {
  const blob = { __pixels: canvas };
  blobPayload.set(blob, canvas);
  return blob;
}

let capturedListener = null;
let screenshotReply = null;
let replyResolve = null;

function installCanvas() {
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
      this._ctx = null;
      this.source = this;
    }
    getContext() {
      if (!this._ctx) this._ctx = makeContext(this);
      return this._ctx;
    }
    async convertToBlob() {
      return makeBlob({ width: this.width, height: this.height, data: this.data.slice() });
    }
  };
  globalThis.createImageBitmap = async (src) => {
    const canvas = src.__pixels ?? src;
    return {
      width: canvas.width,
      height: canvas.height,
      data: canvas.data,
      source: canvas,
      close() {},
    };
  };
  globalThis.ImageData = class {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      const pixels = blob.__pixels;
      this.result = `data:image/jpeg;base64,${Buffer.from(
        pixels ? Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.length) : Buffer.alloc(0),
      ).toString("base64")}`;
      if (this.onload) this.onload();
    }
  };
  // `navigator` is a getter-only global in modern node; the module only reads
  // `"gpu" in navigator` to decide between the GPU and CPU delegate, and a
  // navigator without `gpu` is exactly the CPU path we want to exercise.
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://pry/${p}`,
      onMessage: {
        addListener: (fn) => {
          capturedListener = fn;
        },
        removeListener: () => {},
      },
      sendMessage: (message) => {
        if (message?.type === "screenshot-processed") {
          screenshotReply = message;
          if (replyResolve) replyResolve(message);
        }
        return Promise.resolve(undefined);
      },
    },
  };
}

// ─── Bundle the real module, stubbing only its heavy dependencies ───────────

const STUBS = {
  // `globalThis.__pryOcrScript` is a QUEUE of what the re-read returns, one per
  // call — the only way to exercise the OCR leak branch at all (the real engine
  // is a wasm blob). A queue rather than a constant because escalation verifies
  // the rebuilt frame a second time, and in reality the rebuilt strip is black
  // and reads as nothing; a constant would make every leak look permanent.
  "./ocr": `
    export const ocrDataUrl = async (dataUrl) => {
      // Record every strip the module asks about, so a test can assert on WHAT
      // was composited (the stub cannot see pixels, but it can see the request).
      if (globalThis.__pryOcrStrips) globalThis.__pryOcrStrips.push(String(dataUrl).length);
      return globalThis.__pryOcrScript && globalThis.__pryOcrScript.length
        ? globalThis.__pryOcrScript.shift()
        : null;
    };
    export const ocrWordLines = async () => null;
    export const warmOcrWorker = () => {
      globalThis.__pryOcrWarmed = (globalThis.__pryOcrWarmed ?? 0) + 1;
    };
  `,
  "../ml/ner": `
    export const detectSpans = async () => [];
    export const warmUpNer = async () => ({ ready: false });
  `,
  "../ml/guard": `
    export const classifyInjection = async () => null;
    export const warmUpGuard = async () => ({ ready: false });
  `,
  // Configurable so the face probe can be exercised: `globalThis.__pryFaceProbe`
  // says which call returns boxes, which lets this harness simulate the failure
  // the probe exists for — a face the ORIGINAL pass missed but the re-probe over
  // the SHIPPED frame still finds. A stub that always returned [] would make the
  // probe untestable ("no uncovered faces" every time, whatever the wiring).
  "@mediapipe/tasks-vision": `
    export const FilesetResolver = { forVisionTasks: async () => ({}) };
    export class FaceDetector {
      static async createFromOptions() { return new FaceDetector(); }
      async detect() {
        const probe = globalThis.__pryFaceProbe;
        if (!probe) return { detections: [] };
        probe.calls = (probe.calls ?? 0) + 1;
        if (probe.calls < (probe.from ?? 1)) return { detections: [] };
        return {
          detections: (probe.boxes ?? []).map((b) => ({
            boundingBox: { originX: b.x, originY: b.y, width: b.width, height: b.height },
            categories: [{ score: 0.9 }],
          })),
        };
      }
    }
  `,
};

const stubPlugin = {
  name: "stub-heavy-deps",
  setup(build) {
    for (const [name, contents] of Object.entries(STUBS)) {
      const filter =
        name === "@mediapipe/tasks-vision" ? /^@mediapipe\/tasks-vision$/ : new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "stub" }));
    }
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: STUBS[args.path],
      loader: "js",
    }));
  },
};

async function bundle(entryContents, plugins = []) {
  const out = await build({
    stdin: {
      contents: entryContents,
      resolveDir: root,
      sourcefile: "itest-entry.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins,
  });
  return out.outputFiles[0].text;
}

/** The offscreen module, plus re-exports so one import serves the whole test. */
const offscreenBundle = await bundle(
  `
    export * from "./src/offscreen/offscreen.ts";
    export * from "./src/shared/screenshot-protection.ts";
    export * from "./src/shared/screenshot-egress.ts";
    export * from "./src/shared/region-paint.ts";
    export * from "./src/background/redaction-attack.ts";
    export * from "./src/background/reocr-verification.ts";
    export * from "./src/background/surrogates.ts";
  `,
  [stubPlugin],
);

installCanvas();
const offscreen = await import(
  `data:text/javascript;base64,${Buffer.from(offscreenBundle).toString("base64")}`
);

let passed = 0;
function ok(name, cond, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  passed++;
  log(`  ✓ ${name}`);
}

// ─── Drive the real message listener ────────────────────────────────────────

/** A page with a legible email drawn at a known place, plus other content. */
function makePage(width, height, glyphs) {
  const canvas = makeCanvas(width, height);
  // A non-uniform background so the "original had content" checks are honest.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      canvas.data[i] = 250;
      canvas.data[i + 1] = 248;
      canvas.data[i + 2] = 244;
      canvas.data[i + 3] = 255;
    }
  }
  for (const g of glyphs) {
    for (let y = g.y; y < g.y + g.height; y++) {
      for (let x = g.x; x < g.x + g.width; x++) {
        const i = (y * width + x) * 4;
        canvas.data[i] = 20;
        canvas.data[i + 1] = 18;
        canvas.data[i + 2] = 16;
        canvas.data[i + 3] = 255;
      }
    }
  }
  return canvas;
}

/** The kinds the audit panel has a deliberate colour/emoji for. */
const KNOWN_AUDIT_KINDS = new Set([
  "face", "credential", "id_number", "api_key", "pii_text", "input_field",
  "image_text", "password", "credit_card", "otp", "pan_card", "cvv",
  "email_text", "phone_text", "id_text", "name_text", "ner_text",
]);

const PAGE_WIDTH = 200;
const PAGE_HEIGHT = 120;
const DPR = 2;

/** An opaque-black detector over the shipped pixels. */
function isBlack(canvas, x, y, width, height, threshold = 60) {
  let black = 0;
  let total = 0;
  for (let py = Math.max(0, y); py < Math.min(canvas.height, y + height); py++) {
    for (let px = Math.max(0, x); px < Math.min(canvas.width, x + width); px++) {
      const i = (py * canvas.width + px) * 4;
      const lum = (canvas.data[i] + canvas.data[i + 1] + canvas.data[i + 2]) / 3;
      total++;
      if (lum <= threshold) black++;
    }
  }
  return total === 0 ? 0 : black / total;
}

async function runPipeline({ width = PAGE_WIDTH, height = PAGE_HEIGHT, sensitiveRegions = [], privacy = {}, glyphs = [] } = {}) {
  const page = makePage(width * DPR, height * DPR, glyphs);
  const dataUrl = `data:image/png;base64,${Buffer.from(
    Buffer.from(page.data.buffer, page.data.byteOffset, page.data.length),
  ).toString("base64")}`;

  // fetch() must hand back pixels for the data URL the caller supplied.
  globalThis.fetch = async () => {
    const decoded = Buffer.from(dataUrl.split(",")[1], "base64");
    return {
      ok: true,
      blob: async () =>
        makeBlob({
          width: page.width,
          height: page.height,
          data: new Uint8ClampedArray(
            decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength),
          ),
        }),
    };
  };

  screenshotReply = null;
  const replyPromise = new Promise((resolve) => {
    replyResolve = resolve;
  });

  const handled = capturedListener(
    {
      type: "process-screenshot",
      requestId: "test-1",
      dataUrl,
      width: page.width,
      height: page.height,
      sensitiveRegions,
      dpr: DPR,
      regionScale: DPR,
      regionOffsetY: 0,
      privacy: {
        destroyFaces: true,
        maskCredentials: true,
        showRedactionLabels: false,
        scanFrameText: false,
        ...privacy,
      },
      knownSpans: [],
    },
    {},
    () => {},
  );
  assert.equal(handled, true, "the offscreen listener must accept a process-screenshot message");

  const reply = await Promise.race([
    replyPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("offscreen produced no reply")), 10_000)),
  ]);
  assert.equal(reply.error, undefined, `offscreen errored: ${reply.error}`);
  return { result: reply.result, page };
}

// The module logs progress on every frame. Print this test's own lines through
// process.stdout so the harness can silence the module without silencing itself.
const log = (line) => process.stdout.write(`${line}\n`);

// ── Warm-up: the OCR worker is started at run start, not on first capture ──
// Tesseract's first recognition costs ~10.5 s of cold start (measured: WASM
// core + eng data + engine init). It used to be paid inside the user's FIRST
// capture, because nothing warmed it — the model self-test warms NER, the
// injection guard and BlazeFace. The service worker now sends `warm-ocr` when
// it creates the offscreen document, and this drives that exact message through
// the real listener.
ok(
  "the listener accepts a warm-ocr message without handling it asynchronously",
  capturedListener({ type: "warm-ocr" }, {}, () => {}) === false,
);
ok("and that message actually starts the OCR worker", (globalThis.__pryOcrWarmed ?? 0) === 1,
  `warm calls=${globalThis.__pryOcrWarmed ?? 0}`);
ok(
  "the warm-up is fire-and-forget: unknown message types are still declined",
  capturedListener({ type: "not-a-real-message" }, {}, () => {}) === false,
);
log("\n=== offscreen pipeline: real message path, real pixels ===\n");
console.log = () => {};

// ── 1. A text-PII span is reported where it was painted ─────────────────────
const EMAIL_RECT = { x: 20, y: 30, width: 90, height: 12 };
const textRun = await runPipeline({
  sensitiveRegions: [{ ...EMAIL_RECT, kind: "email_text", label: "Email address" }],
  glyphs: [EMAIL_RECT],
});

ok("the listener replies with a redacted image", /^data:image\/jpeg;base64,/.test(textRun.result.redactedDataUrl));
ok("the span is reported as a detection", textRun.result.detections.length === 1, JSON.stringify(textRun.result.detections));
ok("the span was counted as a redaction", textRun.result.redactedCount === 1, `count=${textRun.result.redactedCount}`);

const reportedBox = textRun.result.detections[0].box;

// Recover the shipped pixels from the reply's own data URL and assert the
// reported box is where the black actually is — the assertion that would have
// caught the drift bug, because it compares a REPORT against PIXELS.
const decoded = Buffer.from(textRun.result.redactedDataUrl.split(",")[1], "base64");
const shippedCanvas = {
  width: PAGE_WIDTH * DPR,
  height: PAGE_HEIGHT * DPR,
  data: new Uint8ClampedArray(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength)),
};
// The stub FileReader encodes raw RGBA, so the byte length is width*height*4.
assert.equal(
  shippedCanvas.data.length,
  shippedCanvas.width * shippedCanvas.height * 4,
  "the shipped frame is a raw RGBA buffer of the documented size",
);

const boxX = Math.round(reportedBox.x * shippedCanvas.width);
const boxY = Math.round(reportedBox.y * shippedCanvas.height);
const boxW = Math.round(reportedBox.width * shippedCanvas.width);
const boxH = Math.round(reportedBox.height * shippedCanvas.height);
ok(
  "the reported box is almost entirely the black that was painted",
  isBlack(shippedCanvas, boxX, boxY, boxW, boxH) > 0.9,
  `black=${isBlack(shippedCanvas, boxX, boxY, boxW, boxH).toFixed(3)} box=${JSON.stringify({ boxX, boxY, boxW, boxH })}`,
);
ok(
  "and the padding is inside the box, not beside it (box starts left of the glyphs)",
  boxX <= EMAIL_RECT.x * DPR && boxY <= EMAIL_RECT.y * DPR,
  `box=${boxX},${boxY} glyphs=${EMAIL_RECT.x * DPR},${EMAIL_RECT.y * DPR}`,
);
ok(
  "the unpainted page around the box is NOT black (the fill is bounded)",
  isBlack(shippedCanvas, 0, 0, 10, 10) < 0.1,
  `black=${isBlack(shippedCanvas, 0, 0, 10, 10).toFixed(3)}`,
);

// ── 2. The egress evidence is produced, and the guard accepts it ────────────
const protection = textRun.result.protection;
ok("the offscreen pipeline PRODUCES egress evidence", Boolean(protection), JSON.stringify(protection));
ok("its own scans are reported complete", protection.facesComplete === true && protection.finalScanComplete === true, JSON.stringify(protection));
ok("residual detections are zero on a successful frame", protection.residualDetections === 0);
// The pixel findings are a rebuild TRIGGER now, so the ordinary frame is the
// regression risk in this direction: if the verifier reported a finding on a
// correct paint, every captured frame would be rebuilt to solid black.
ok(
  "a clean frame escalates for nothing (no pixel findings on a correct paint)",
  textRun.result.verification.escalated !== true &&
  !(textRun.result.verification.escalationReasons ?? []).length,
  JSON.stringify({
    escalated: textRun.result.verification.escalated,
    reasons: textRun.result.verification.escalationReasons,
  }),
);
ok("policy is reported enabled when both toggles are on", protection.policyEnabled === true);
ok(
  "the service-worker halves are left unclaimed until assembly",
  protection.textComplete === false && protection.mappingValid === false,
  JSON.stringify(protection),
);
ok(
  "a frame with no residual leaks and complete scans can ship",
  offscreen.screenshotSendDecision({
    ...textRun.result,
    protection: offscreen.applyCaptureEvidence(protection, { textComplete: true, mappingValid: true }),
  }).allowed === true,
);
ok(
  "and the same frame is refused if the DOM channel did not complete",
  offscreen.screenshotSendDecision({
    ...textRun.result,
    protection: offscreen.applyCaptureEvidence(protection, { textComplete: false, mappingValid: true }),
  }).allowed === false,
);

// ── 3. Verification measured exactly the regions that were painted ──────────
ok("verification ran over the painted regions", textRun.result.verification.regionsChecked === 1, JSON.stringify(textRun.result.verification));
ok("and confirmed the redaction", textRun.result.verification.verified === true);
ok(
  "regions redacted equals regions checked (no unverified claim)",
  textRun.result.verification.regionsRedacted === textRun.result.verification.regionsChecked,
);

// ── 4. A skipped region is reported but not painted, and not counted ────────
const faceRun = await runPipeline({
  sensitiveRegions: [{ ...EMAIL_RECT, kind: "face", label: "Avatar" }],
  privacy: { destroyFaces: false },
});
const faceBox = faceRun.result.detections[0].box;
const faceDecoded = Buffer.from(faceRun.result.redactedDataUrl.split(",")[1], "base64");
const faceShipped = {
  width: PAGE_WIDTH * DPR,
  height: PAGE_HEIGHT * DPR,
  data: new Uint8ClampedArray(faceDecoded.buffer.slice(faceDecoded.byteOffset, faceDecoded.byteOffset + faceDecoded.byteLength)),
};
ok("a detection with face destruction off is still reported", faceRun.result.detections.length === 1);
ok(
  "but labelled as NOT redacted",
  /NOT redacted/i.test(faceRun.result.detections[0].label),
  faceRun.result.detections[0].label,
);
// The tier is recorded by the painter, so the panel and the inspector can label
// this box from the record instead of inferring a redaction from its kind. A
// skipped region's badge must read `none` — the honest word — and not a tier.
ok(
  "and its recorded tier is `skip`, which the UI badges as `none`",
  faceRun.result.detections[0].tier === "skip" && offscreen.tierBadge("skip") === "none",
  `tier=${faceRun.result.detections[0].tier} badge=${offscreen.tierBadge(faceRun.result.detections[0].tier)}`,
);
ok("and NOT counted as a redaction", faceRun.result.redactedCount === 0, `count=${faceRun.result.redactedCount}`);
ok(
  "and its pixels really were left alone",
  isBlack(faceShipped, Math.round(faceBox.x * faceShipped.width), Math.round(faceBox.y * faceShipped.height), 20, 10) < 0.1,
);
ok("policy is reported disabled, so it cannot ship", faceRun.result.protection.policyEnabled === false);
ok(
  "and the guard refuses it",
  offscreen.screenshotSendDecision({
    ...faceRun.result,
    protection: offscreen.applyCaptureEvidence(faceRun.result.protection, { textComplete: true, mappingValid: true }),
  }).allowed === false,
);

// ── 5. Credential fields get the tier the table promises ────────────────────
const fieldRun = await runPipeline({
  sensitiveRegions: [
    { x: 10, y: 10, width: 80, height: 14, kind: "input_field", label: "Search" },
    { x: 10, y: 40, width: 80, height: 14, kind: "password", label: "Password" },
  ],
  glyphs: [
    { x: 10, y: 10, width: 80, height: 14 },
    { x: 10, y: 40, width: 80, height: 14 },
  ],
});
ok("both field regions were painted", fieldRun.result.redactedCount === 2, `count=${fieldRun.result.redactedCount}`);
// The audit list keeps field kinds distinct (the side panel colours a password
// differently from an expiry box) and collapses only the two generic container
// kinds. Pinned because normalising everything to `credential` would quietly
// drop that distinction, and dropping the normalisation would push `input_field`
// into the panel's fallback colour, which is what it did before.
ok(
  "a generic input reports as `credential`, a password box keeps its own kind",
  fieldRun.result.detections.map((d) => d.kind).join(",") === "credential,password",
  JSON.stringify(fieldRun.result.detections.map((d) => d.kind)),
);
ok(
  "every reported kind is one the audit vocabulary can colour",
  fieldRun.result.detections.every((d) => KNOWN_AUDIT_KINDS.has(d.kind)),
  JSON.stringify(fieldRun.result.detections.map((d) => d.kind)),
);
ok(
  "a soft-tier field is verified as altered rather than opaque",
  fieldRun.result.verification.verified === true &&
    fieldRun.result.verification.regionsRedacted === 2,
  JSON.stringify(fieldRun.result.verification),
);

// ── 6. The tier table itself ───────────────────────────────────────────────
const on = { destroyFaces: true, maskCredentials: true };
const off = { destroyFaces: true, maskCredentials: false };
const offFaces = { destroyFaces: false, maskCredentials: true };
ok("face → opaque, and skip when destruction is off", offscreen.tierForKind("face", on) === "opaque" && offscreen.tierForKind("face", offFaces) === "skip");
ok("an exact-PII span → opaque", offscreen.tierForKind("email_text", on) === "opaque" && offscreen.tierForKind("ner_text", on) === "opaque");
ok("a field label / generic input → blur", offscreen.tierForKind("credential_label", on) === "blur" && offscreen.tierForKind("input_field", on) === "blur");
ok("a confirmed credential FIELD → surrogate", offscreen.tierForKind("password", on) === "surrogate" && offscreen.tierForKind("credit_card", on) === "surrogate");
ok("masking off degrades every kind to blur", ["email_text", "password", "credential_label", "input_field"].every((k) => offscreen.tierForKind(k, off) === "blur"));
const setsOn = offscreen.tierSetsFor(on);
const setsOff = offscreen.tierSetsFor(off);
ok("the verifier's destroyed set follows the painter's opaque tier", setsOn.destroyed.has("face") && setsOn.destroyed.has("email_text") && !setsOn.destroyed.has("password"));
ok("and with masking off nothing is measured as opaque", setsOff.destroyed.size === 1 && setsOff.destroyed.has("face"), [...setsOff.destroyed].join(","));
// ── 6b. The reported tier is the PLAN's tier — re-deriving it would lie ─────
// Viewers used to recompute the tier from a detection's `kind`. That is not
// equivalent to the paint: a generic input is REPORTED as `credential`, whose
// derived tier would be `surrogate`, while its pixels were soft-blurred. With
// the tier carried in the record, the label cannot disagree with the pixels.
ok(
  "every reported detection carries the tier it was painted with",
  fieldRun.result.detections.every((d) => typeof d.tier === "string" && d.tier.length > 0),
  JSON.stringify(fieldRun.result.detections.map((d) => `${d.kind}:${d.tier ?? "MISSING"}`)),
);
ok(
  "each recorded tier is one the badge vocabulary can name",
  fieldRun.result.detections.every((d) => offscreen.tierBadge(d.tier) !== null),
  JSON.stringify(fieldRun.result.detections.map((d) => d.tier)),
);
ok(
  "a generic input records `blur`, not the `surrogate` its reported kind would derive",
  fieldRun.result.detections.find((d) => d.kind === "credential")?.tier === "blur" &&
    offscreen.tierForKind("credential", on) === "surrogate",
  JSON.stringify(fieldRun.result.detections.map((d) => `${d.kind}:${d.tier}`)),
);
ok(
  "an unrecognised tier is reported as unknown rather than guessed",
  offscreen.tierBadge("opaque-ish") === null && offscreen.tierBadge(undefined) === null,
);
ok(
  "and every tier the vocabulary defines has a badge",
  ["opaque", "blur", "surrogate", "skip"].every(
    (t) => offscreen.TIER_BADGES[t] === offscreen.tierBadge(t),
  ),
);

ok("a rewritten plan cannot drift from its ops", offsetCheck());

function offsetCheck() {
  const plan = offscreen.planRegionPaints(
    [{ x: 5, y: 5, width: 10, height: 10, kind: "email_text", label: "e" }],
    { scale: 2, offsetY: 100, imageWidth: 1000, imageHeight: 1000 },
    on,
  );
  const op = plan[0];
  return (
    op.box !== null &&
    Math.round(op.box.x * 1000) === op.rect.x &&
    Math.round(op.box.y * 1000) === op.rect.y &&
    Math.round(op.box.width * 1000) === op.rect.width
  );
}

// ── 7. The adversarial attack runs on the real path ─────────────────────────
// The pipeline's OWN soft tier (input_field → blur) is attacked with its own
// probe on the bytes it actually shipped. This is the honest negative the whole
// calibration rests on: PRY's shipped blur must be judged NON-recoverable, or
// every frame would escalate to solid black.
const attackRun = await runPipeline({
  sensitiveRegions: [{ x: 10, y: 10, width: 120, height: 20, kind: "input_field", label: "Search" }],
  glyphs: [{ x: 10, y: 10, width: 120, height: 20 }],
});
const attackV = attackRun.result.verification.attack;
ok("the adversarial probe ran on the shipped pixels", attackV && attackV.ran === true, JSON.stringify(attackV));
ok("PRY's own shipped blur is NOT judged reconstructable",
  attackV.reconstructableRegions === 0 && attackV.details.length === 0,
  JSON.stringify(attackV));
ok("no uncovered face is invented on a page with no faces", attackV.uncoveredFaces === 0);
ok("and a frame the attack cleared is not marked escalated", attackRun.result.verification.escalated !== true);

// ── 8. Calibration against PRY's REAL blur ─────────────────────────────────
// The probe's whole job is to notice when the SOFT tier stops destroying things.
// So it is measured against the blur this pipeline ships, not against a blur the
// test wrote to make itself pass: the same pixels at the same scale, blurred by
// `boxBlurRegion`'s own channel kernel at four radii.
// Content patterns matter: a 6px blur over 2px strokes and the same blur over
// 6px strokes leave very different residual energy, so a single fixture would
// calibrate the probe to itself. These five span the range (2px strokes at a 4px
// pitch through 6px strokes at a 12px pitch).
const CONTENT_PATTERNS = [
  { pitch: 4, stroke: 2, weight: 20 },
  { pitch: 6, stroke: 2, weight: 20 },
  { pitch: 8, stroke: 2, weight: 20 },
  { pitch: 10, stroke: 4, weight: 20 },
  { pitch: 12, stroke: 6, weight: 110 },
];
const ATTACK_REGION = { x: 20, y: 20, width: 360, height: 80, kind: "input_field", label: "Field" };

function blurredFixture({ pitch, stroke, weight }, radius) {
  const w = 400;
  const h = 200;
  const img = makeCanvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = 250; img.data[i + 1] = 248; img.data[i + 2] = 244; img.data[i + 3] = 255;
    }
  }
  for (let y = 20; y < 100; y++) {
    for (let x = 20; x < 380; x++) {
      if ((x - 20) % pitch < stroke && (y - 20) % 14 < 10) {
        const i = (y * w + x) * 4;
        img.data[i] = weight; img.data[i + 1] = weight; img.data[i + 2] = weight; img.data[i + 3] = 255;
      }
    }
  }
  const original = { width: w, height: h, data: new Uint8ClampedArray(img.data) };
  if (radius > 0) {
    // Blurred by the module's OWN kernel at the module's own radius, through a
    // region buffer — exactly how the paint path applies it.
    const region = { width: 360, height: 80, data: new Uint8ClampedArray(360 * 80 * 4) };
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 360; x++) {
        const s = ((20 + y) * w + (20 + x)) * 4;
        const t = (y * 360 + x) * 4;
        for (let c = 0; c < 4; c++) region.data[t + c] = original.data[s + c];
      }
    }
    for (const channel of [0, 1, 2]) offscreen.blurChannel(region, channel, radius);
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 360; x++) {
        const s = ((20 + y) * w + (20 + x)) * 4;
        const t = (y * 360 + x) * 4;
        for (let c = 0; c < 4; c++) img.data[s + c] = region.data[t + c];
      }
    }
  } else {
    for (let y = 20; y < 100; y++) {
      for (let x = 20; x < 380; x++) {
        const i = (y * w + x) * 4;
        img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0;
      }
    }
  }
  const origE = offscreen.edgeEnergy(original, ATTACK_REGION);
  const shipE = offscreen.edgeEnergy(img, ATTACK_REGION);
  return {
    original,
    shipped: img,
    residual: origE === 0 ? 0 : shipE / origE,
    fires: offscreen.attackSoftRegions(original, img, [ATTACK_REGION]).length > 0,
  };
}

// THE invariant that keeps the probe safe to run on every frame: no shipped blur
// radius, on any content pattern, may be flagged. A false positive here would
// silently repaint frames as solid black.
const shippedReadings = [];
let shippedFlagged = 0;
for (const pattern of CONTENT_PATTERNS) {
  for (const radius of [6, 8, 12]) {
    const reading = blurredFixture(pattern, radius);
    shippedReadings.push(reading.residual);
    if (reading.fires) shippedFlagged++;
    if (radius === 6) {
      ok(`the shipped radius-6 blur is not flagged on the ${pattern.pitch}px-pitch pattern`,
        !reading.fires, `residual=${reading.residual.toFixed(3)}`);
    }
  }
}
log(
  `  · shipped blur residual across ${CONTENT_PATTERNS.length} content patterns and radii 6/8/12: ` +
  `${Math.min(...shippedReadings).toFixed(3)} – ${Math.max(...shippedReadings).toFixed(3)}`,
);
ok("NO shipped blur radius is ever flagged, on any content pattern",
  shippedFlagged === 0, `flagged=${shippedFlagged}`);

// The other side: a blur weakened past the shipped range must be caught. These
// are the readings that sit ABOVE every shipped one — a radius-2 blur on coarse
// content (0.47) and a radius-3 blur on the coarsest (0.69).
const weakOnFine = blurredFixture(CONTENT_PATTERNS[2], 2);
const weakOnCoarse = blurredFixture(CONTENT_PATTERNS[4], 3);
const grosslyWeak = blurredFixture(CONTENT_PATTERNS[4], 2);
log(
  `  · weakened blur residual — radius 2 on 8px pitch: ${weakOnFine.residual.toFixed(3)}, ` +
  `radius 3 on 12px pitch: ${weakOnCoarse.residual.toFixed(3)}, ` +
  `radius 2 on 12px pitch: ${grosslyWeak.residual.toFixed(3)}`,
);
ok("a weakened blur IS caught (radius 2 on fine content)",
  weakOnFine.fires, `residual=${weakOnFine.residual.toFixed(3)}`);
ok("and on coarse content, at radius 3 and radius 2",
  weakOnCoarse.fires && grosslyWeak.fires,
  `r3=${weakOnCoarse.residual.toFixed(3)} r2=${grosslyWeak.residual.toFixed(3)}`);
ok("every flagged residual is above the threshold, every silent one below it",
  weakOnFine.residual > 0.35 && grosslyWeak.residual > 0.35 &&
  Math.max(...shippedReadings) < 0.35,
  `max shipped=${Math.max(...shippedReadings).toFixed(3)}`);

// The failure mode with the worst consequences: the blur silently doing nothing
// (the documented `ctx.filter` no-op). An untouched region must always be caught.
const untouchedBlur = blurredFixture(CONTENT_PATTERNS[0], 12);
const untouched = offscreen.attackSoftRegions(
  untouchedBlur.original,
  untouchedBlur.original,
  [ATTACK_REGION],
);
ok("a blur that silently did NOTHING is always caught (residual 1.0)",
  untouched.length === 1 && Math.round(untouched[0].residualFraction * 100) === 100,
  JSON.stringify(untouched.map((f) => f.residualFraction)));

const opaqueFill = blurredFixture(CONTENT_PATTERNS[0], 0);
ok("and an opaque fill has nothing left to reconstruct",
  !opaqueFill.fires && opaqueFill.residual === 0);
ok("the gate is on the residual, so it is independent of the sharpening amount",
  !offscreen.attackSoftRegions(blurredFixture(CONTENT_PATTERNS[0], 12).original,
    blurredFixture(CONTENT_PATTERNS[0], 12).shipped, [ATTACK_REGION], { amount: 6 }).length);

// ── 9. A face the pipeline MISSED is found, escalated, and destroyed ───────
// Simulates the failure this probe exists for: the detector finds nothing over
// the original pixels but finds a face over the shipped frame (detection runs are
// not deterministic across the redaction pass — and a face near a redacted field
// is exactly the case the channels were fixed for). Call 1 is the original pass;
// the probe's calls are 2 and 3.
const MISSED_FACE = { x: 300, y: 150, width: 40, height: 40 };
globalThis.__pryFaceProbe = { from: 2, boxes: [MISSED_FACE] };
const escalateRun = await runPipeline({
  sensitiveRegions: [{ x: 10, y: 10, width: 120, height: 20, kind: "input_field", label: "Search" }],
  glyphs: [{ x: 10, y: 10, width: 120, height: 20 }],
});
globalThis.__pryFaceProbe = null;

const escalated = escalateRun.result.verification;
ok("the re-probe found a face the original pass did not, and the record keeps it",
  escalated.attack.details.some((d) => /FACE COVERAGE/.test(d) && /300,150/.test(d)),
  JSON.stringify(escalated.attack.details));
// The counts must describe the image that SHIPS, and the details are the trail of
// what the rebuild was for. Overwriting the counts with the first pass's numbers
// made the record argue with itself: this same frame rendered as "no uncovered
// face" printed directly above a FACE COVERAGE line — reported live, and a face
// the re-probe finds on the REBUILT frame is the one finding escalation cannot
// cover. The pair of assertions below is the invariant: counts zero, and every
// face those details name is opaque in the shipped bytes.
ok("the attack counts describe the SHIPPED image, not the first paint",
  escalated.attack.uncoveredFaces === 0 && escalated.attack.reconstructableRegions === 0,
  JSON.stringify(escalated.attack));
ok("the frame was rebuilt and marked escalated", escalated.escalated === true, JSON.stringify({ verified: escalated.verified }));
ok("the escalated frame verifies", escalated.verified === true);
// The summary is what a user reads. It must name the reason that actually fired
// and must not pad the count of the reasons that did not ("proved 0 recoverable
// blur(s)" beside a real finding reads as a bug even when the pixels are right).
ok("the escalated summary names the coverage failure that caused it",
  /1 face the pipeline had not covered/.test(escalated.summary) &&
  /ESCALATED/.test(escalated.summary),
  escalated.summary);
ok("and does not claim zero recoverable blurs as a finding",
  !/0 blur/.test(escalated.summary), escalated.summary);

const escalatedDecoded = Buffer.from(escalateRun.result.redactedDataUrl.split(",")[1], "base64");
const escalatedShipped = {
  width: PAGE_WIDTH * DPR,
  height: PAGE_HEIGHT * DPR,
  data: new Uint8ClampedArray(
    escalatedDecoded.buffer.slice(escalatedDecoded.byteOffset, escalatedDecoded.byteOffset + escalatedDecoded.byteLength),
  ),
};
ok("the face the pipeline missed is BLACK in the bytes that ship",
  isBlack(escalatedShipped, MISSED_FACE.x, MISSED_FACE.y, MISSED_FACE.width, MISSED_FACE.height) > 0.9,
  `black=${isBlack(escalatedShipped, MISSED_FACE.x, MISSED_FACE.y, MISSED_FACE.width, MISSED_FACE.height).toFixed(3)}`);
ok("and it is reported as a detection with the re-probe's own label",
  escalateRun.result.detections.some((d) => d.kind === "face" && /adversarial re-probe/.test(d.label)),
  JSON.stringify(escalateRun.result.detections.map((d) => d.kind)));
ok("the face counts as a redaction, because it now IS one",
  escalateRun.result.redactedCount === escalateRun.result.detections.filter((d) => d.kind !== "face" || /re-probe/.test(d.label)).length);
// Remediated, not merely reported: nothing residual remains, and the evidence of
// what was found survives on the attack record so the audit can show its work.
ok("a remediated frame reports no residual leak",
  escalateRun.result.protection.residualDetections === 0 && escalated.leakedPatterns.length === 0,
  JSON.stringify({ residual: escalateRun.result.protection.residualDetections, leaks: escalated.leakedPatterns }));
ok("and still ships",
  offscreen.screenshotSendDecision({
    ...escalateRun.result,
    protection: offscreen.applyCaptureEvidence(escalateRun.result.protection, { textComplete: true, mappingValid: true }),
  }).allowed === true);

// A frame the probe cannot judge must not claim it did: with no detector boxes
// the probe still runs, but the same page with no soft-tier region at all has
// nothing to reconstruct and reports that honestly.
const opaqueOnly = await runPipeline({
  sensitiveRegions: [{ x: 10, y: 10, width: 120, height: 20, kind: "email_text", label: "Email" }],
  glyphs: [{ x: 10, y: 10, width: 120, height: 20 }],
});
ok("an opaque-only frame reports the probe as run with nothing to attack",
  opaqueOnly.result.verification.attack.ran === true &&
  opaqueOnly.result.verification.attack.reconstructableRegions === 0,
  JSON.stringify(opaqueOnly.result.verification.attack));

// ── 10. The OCR re-read must not flag PRY's OWN painting ────────────────────
// Real bug, reproduced: every frame containing a masked credential field
// reported ~4 residual leaks and failed its own mask verification, because the
// surrogate tier paints a synthetic value that satisfies the verifier's own
// patterns — "4111 8703 3161 1545" is both a valid card and (4-4-4 digits) an
// Aadhaar shape, and the synthetic email/phone match too. The scan is scoped to
// regions that could still hold the USER's pixels, so a surrogate region is out.
const SYNTHETIC_CARD = offscreen.getSyntheticSurrogate("credit_card");
const SYNTHETIC_EMAIL = offscreen.getSyntheticSurrogate("email");
ok("the synthetic card the inpaint draws trips the verifier's own patterns",
  offscreen.detectPIIInText(SYNTHETIC_CARD).length >= 2,
  `${SYNTHETIC_CARD} → ${offscreen.detectPIIInText(SYNTHETIC_CARD).join(", ")}`);

// The pure rule first: which regions the re-read may look at.
const onPolicy = { destroyFaces: true, maskCredentials: true };
const checkable = offscreen.ocrCheckableRegions([
  { kind: "password", label: "Password" },
  { kind: "credit_card", label: "Card" },
  { kind: "id_number", label: "Aadhaar" },
  { kind: "email_text", label: "Email" },
  { kind: "input_field", label: "Search" },
  { kind: "face", label: "Face" },
], onPolicy).map((r) => r.kind);
ok("the OCR re-read skips every surrogate kind",
  !checkable.includes("password") && !checkable.includes("credit_card") && !checkable.includes("id_number"),
  JSON.stringify(checkable));
ok("and still reads the soft and opaque tiers",
  checkable.includes("input_field") && checkable.includes("email_text") && checkable.includes("face"),
  JSON.stringify(checkable));

// Then behaviourally, on the real strip the module composites. The stub OCR
// cannot see pixels, so the assertion is DIFFERENTIAL: if the surrogate's crop
// is excluded, adding that region to the frame must not change the strip at all.
const stripSizes = [];
const runAndMeasureStrip = async (regions, glyphs) => {
  globalThis.__pryOcrScript = [`${SYNTHETIC_CARD} ${SYNTHETIC_EMAIL}`];
  globalThis.__pryOcrStrips = [];
  const run = await runPipeline({ sensitiveRegions: regions, glyphs });
  globalThis.__pryOcrScript = null;
  return { run, strips: [...globalThis.__pryOcrStrips] };
};
const PW = { x: 10, y: 10, width: 100, height: 14, kind: "password", label: "Password" };
const SPAN = { x: 10, y: 40, width: 100, height: 14, kind: "email_text", label: "Email in text" };
const GLYPHS_BOTH = [{ x: 10, y: 10, width: 100, height: 14 }, { x: 10, y: 40, width: 100, height: 14 }];

const spanOnly = await runAndMeasureStrip([SPAN], [GLYPHS_BOTH[1]]);
const surrogateOnly = await runAndMeasureStrip([PW], [GLYPHS_BOTH[0]]);
const both = await runAndMeasureStrip([PW, SPAN], GLYPHS_BOTH);
stripSizes.push(spanOnly.strips.length, surrogateOnly.strips.length, both.strips.length);

ok("both frames did composite an OCR strip (the check ran)",
  spanOnly.strips.length > 0 && both.strips.length > 0, JSON.stringify({ spanOnly: spanOnly.strips.length, both: both.strips.length }));
ok("a frame whose ONLY region is a surrogate composites NO strip at all",
  surrogateOnly.strips.length === 0,
  JSON.stringify(surrogateOnly.strips));
ok("so adding a surrogate field does not change the strip (its crop is excluded)",
  spanOnly.strips.length > 1 && both.strips.length > 1 &&
  spanOnly.strips[1] === both.strips[1] &&
  JSON.stringify(spanOnly.strips) !== JSON.stringify(surrogateOnly.strips),
  JSON.stringify({ spanOnly: spanOnly.strips, both: both.strips, surrogateOnly: surrogateOnly.strips }));
ok("and the synthetic values those frames read are not reported as leaks",
  !both.run.result.verification.leakedPatterns.some((l) => /OCR: (Card|Aadhaar|Email)/.test(l)),
  JSON.stringify(both.run.result.verification.leakedPatterns));
ok("and nothing residual reaches the egress guard",
  both.run.result.protection.residualDetections === 0 &&
  offscreen.screenshotSendDecision({
    ...both.run.result,
    protection: offscreen.applyCaptureEvidence(both.run.result.protection, { textComplete: true, mappingValid: true }),
  }).allowed === true,
  JSON.stringify(both.run.result.protection.reasons));
// The scoping must not disable the check: a soft region the OCR CAN still read
// is a real leak and must still fail, escalate and be reported.
const realLeakText = "write to priya.sharma@example.com today";
// First read finds the address; the rebuilt frame is black, so the second reads
// nothing — exactly what the real engine does after escalation.
globalThis.__pryOcrScript = [realLeakText, null];
const leakRun = await runPipeline({
  sensitiveRegions: [{ x: 10, y: 10, width: 120, height: 20, kind: "input_field", label: "Search" }],
  glyphs: [{ x: 10, y: 10, width: 120, height: 20 }],
});
globalThis.__pryOcrScript = null;
ok("a soft region the OCR can still READ is still caught and remediated",
  leakRun.result.verification.escalated === true &&
  /OCR still reading Email address/.test(leakRun.result.verification.summary),
  leakRun.result.verification.summary);
// The two lists must not be conflated: `leakedPatterns` is what is STILL in the
// shipped bytes (so a remediated finding must leave it, or residualDetections
// stays above zero and the frame is withheld forever), while
// `escalationReasons` is the record of what triggered the rebuild.
ok("the remediated leak leaves the residual list, so the frame can ship",
  leakRun.result.verification.leakedPatterns.length === 0 &&
  leakRun.result.protection.residualDetections === 0);
ok("but the reason for the rebuild is kept in the record",
  (leakRun.result.verification.escalationReasons ?? []).some((r) => /OCR: Email address was still readable/.test(r)),
  JSON.stringify(leakRun.result.verification.escalationReasons));
ok("and the escalated frame is allowed to ship",
  offscreen.screenshotSendDecision({
    ...leakRun.result,
    protection: offscreen.applyCaptureEvidence(leakRun.result.protection, { textComplete: true, mappingValid: true }),
  }).allowed === true,
  JSON.stringify(leakRun.result.protection.reasons));
ok("every residual is labelled with the channel that found it",
  [...leakRun.result.verification.leakedPatterns, ...(leakRun.result.verification.escalationReasons ?? [])]
    .every((l) => /^(OCR|PIXEL|RECONSTRUCTION|FACE COVERAGE):/.test(l)),
  JSON.stringify((leakRun.result.verification.escalationReasons ?? []).map((l) => l.slice(0, 14))));

log(`\n${passed} offscreen integration assertions passed (real message path, real pixels).\n`);
