/**
 * Voice stack verification — the mic's announced contract, and the toggle it
 * actually implements.
 *
 * WHY THIS EXISTS
 *
 * The panel told users "Hold the mic button to talk (release to send)" while the
 * button ran a click-to-start / click-to-send toggle. Nothing failed: the copy
 * was a string literal at the render site, the toggle was a closure inside a
 * 1900-line DOM module, and no test could see either one. So the app shipped a
 * transcript line that taught an interaction it no longer had.
 *
 * Two things fix that class of bug, and both are exercised here:
 *   1. The copy and the tap decision are pure values in `voice-core.ts`, so
 *      they can be asserted directly (and the panel's source is checked to
 *      confirm it uses them instead of restating them).
 *   2. The REAL `VoiceController` is bundled and driven end to end against a
 *      fake microphone, a fake WebSocket and a fake AudioContext, so "tap to
 *      start, tap again to send" is verified as behaviour rather than read as
 *      intent: one tap opens exactly one session, a stray second start is a
 *      no-op, the second tap commits and submits the words exactly once, and
 *      the input is released afterwards.
 *
 * Runs in Node directly; bundles its TypeScript entry in memory with esbuild
 * (the same approach as screenshot-egress-test.mjs) so nothing here has to be
 * kept in sync with a build step.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let passed = 0;
function ok(name, cond, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

// ─── Browser stubs (installed BEFORE the modules are imported) ──────────────
// These stand in for the four capabilities the controller reaches for. They are
// deliberately permissive; what is asserted below is what the controller DOES
// with them (how many sessions it opens, which frames it sends, what it
// releases), not that the stubs behave like real hardware.

const getUserMediaCalls = [];
const stoppedTracks = [];
const audioContexts = [];

function makeMicStream() {
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
      stoppedTracks.push(this);
    },
  };
  return { id: "fake-mic-stream", getTracks: () => [track] };
}

class FakeScriptProcessor {
  constructor() {
    this.onaudioprocess = null;
    this.connected = false;
  }
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

class FakeAudioContext {
  constructor(options = {}) {
    this.options = options;
    this.state = "running";
    this.currentTime = 0;
    this.sampleRate = options.sampleRate ?? 16000;
    this.destination = { kind: "destination" };
    this.processors = [];
    this.closed = false;
    audioContexts.push(this);
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createScriptProcessor() {
    const processor = new FakeScriptProcessor();
    this.processors.push(processor);
    return processor;
  }
  createGain() {
    return { gain: { value: 0 }, connect() {}, disconnect() {} };
  }
  createBuffer(_channels, length, rate) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {} };
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
}

/**
 * A Scribe Realtime socket that speaks just enough of the protocol to exercise
 * the controller: it opens, announces `session_started`, records every frame
 * the client sends, and answers a commit with a `committed_transcript` built
 * from `FakeWebSocket.committedText`.
 */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  static committedText = "";

  static reset() {
    FakeWebSocket.instances = [];
    FakeWebSocket.committedText = "";
  }

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
      this.reply({ message_type: "session_started" });
    }, 0);
  }

  /** Server → client. */
  reply(payload) {
    try {
      this.onmessage?.({ data: JSON.stringify(payload) });
    } catch {
      // A listener that throws is the client's bug, not the harness's.
    }
  }

  /** Client → server. Every frame is parsed, so a malformed one is visible. */
  send(raw) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (frame.commit) {
      setTimeout(() => {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.reply({ message_type: "committed_transcript", text: FakeWebSocket.committedText });
      }, 0);
    }
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "client closed" });
  }
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

defineGlobal("WebSocket", FakeWebSocket);
defineGlobal("AudioContext", FakeAudioContext);
// The controller reads `window.AudioContext` (with a webkit fallback), so the
// constant lives on a window object rather than only on globalThis.
defineGlobal("window", { AudioContext: FakeAudioContext });
defineGlobal("navigator", {
  mediaDevices: {
    async getUserMedia(constraints) {
      getUserMediaCalls.push(constraints);
      return makeMicStream();
    },
    async enumerateDevices() {
      return [{ kind: "audioinput" }];
    },
  },
});
defineGlobal("chrome", {
  runtime: { getURL: (path) => path, getManifest: () => ({ permissions: ["audioCapture"] }) },
});
// The single-use token mint. Asserted below: the API key must never end up in
// a URL.
defineGlobal("fetch", async () => ({
  ok: true,
  status: 200,
  json: async () => ({ token: "tok_single_use_test" }),
  text: async () => "",
}));

// ─── Bundle and import the real modules ────────────────────────────────────

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./src/sidepanel/voice-core.ts";
      export * from "./src/sidepanel/scribe-client.ts";
      export * from "./src/sidepanel/voice-controller.ts";
    `,
    resolveDir: root,
    sourcefile: "voice-test-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const { MIC_READY_ANNOUNCEMENT, micToggleAction, VoiceController } = mod;

/** A controller wired to collectors, so one tap's effects are all inspectable. */
function makeHarness() {
  const submitted = [];
  const entryText = [];
  const states = [];
  const errors = [];
  const controller = new VoiceController({
    apiKey: "sk_test_key_never_in_a_url",
    voiceId: "voice_test",
    submitTask: (task) => submitted.push(task),
    setUserEntryText: (text) => entryText.push(text),
    callbacks: {
      onStateChange: (state) => states.push(state),
      onError: (message) => errors.push(message),
    },
  });
  return { controller, submitted, entryText, states, errors };
}

/** Let the fake session's open/session_started macrotask land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Push one 100 ms-ish mic frame through the live processor. */
function speakIntoLatestContext() {
  const ctx = audioContexts.at(-1);
  const processor = ctx.processors.at(-1);
  processor.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array([0.5, -0.5, 0.25]) },
  });
  return processor;
}

// ─── 1. The announced contract ──────────────────────────────────────────────

console.log("\n=== The mic-ready announcement describes the real interaction ===\n");

ok(
  "the announcement exists and is addressed to the user",
  typeof MIC_READY_ANNOUNCEMENT === "string" && MIC_READY_ANNOUNCEMENT.startsWith("Voice:"),
  MIC_READY_ANNOUNCEMENT,
);
ok(
  "it never says hold",
  !/\bhold/i.test(MIC_READY_ANNOUNCEMENT),
  MIC_READY_ANNOUNCEMENT,
);
ok(
  "it never says release-to-send",
  !/release/i.test(MIC_READY_ANNOUNCEMENT),
  MIC_READY_ANNOUNCEMENT,
);
ok(
  "it states tap to start",
  /tap the mic button to start/i.test(MIC_READY_ANNOUNCEMENT),
  MIC_READY_ANNOUNCEMENT,
);
ok(
  "it states tap again to send",
  /then tap it again to send/i.test(MIC_READY_ANNOUNCEMENT),
  MIC_READY_ANNOUNCEMENT,
);
ok(
  "it names the tap twice, once per half of the toggle",
  (MIC_READY_ANNOUNCEMENT.match(/tap/gi) ?? []).length >= 2,
  MIC_READY_ANNOUNCEMENT,
);
ok(
  "it fits on one transcript line",
  MIC_READY_ANNOUNCEMENT.length <= 140,
  `${MIC_READY_ANNOUNCEMENT.length} chars`,
);

// The panel must RENDER that sentence, not restate it. A second copy at the
// render site is exactly how the two drifted apart the first time.
const sidepanelSource = await readFile(new URL("../src/sidepanel/sidepanel.ts", import.meta.url), "utf8");
ok(
  "the panel renders the shared announcement constant",
  sidepanelSource.includes("text: MIC_READY_ANNOUNCEMENT"),
);
ok(
  "the panel carries no second copy of the old hold-to-talk line",
  !/hold the mic button/i.test(sidepanelSource),
);
ok(
  "the mic button's tooltip uses the same tap wording as the announcement",
  sidepanelSource.includes('"Tap to dictate — tap again to send"'),
);
ok(
  "the tap is routed through the shared toggle decision",
  sidepanelSource.includes("micToggleAction({"),
);

// ─── 2. The toggle decision table ───────────────────────────────────────────

console.log("\n=== Tap decision: start / stop / unavailable ===\n");

ok(
  "idle + a working controller → start recording",
  micToggleAction({ hasController: true, isListening: false }) === "start",
);
ok(
  "recording + a working controller → stop and send",
  micToggleAction({ hasController: true, isListening: true }) === "stop",
);
ok(
  "no controller → unavailable",
  micToggleAction({ hasController: false, isListening: false }) === "unavailable",
);
ok(
  "no controller wins even if some state claims to be recording",
  micToggleAction({ hasController: false, isListening: true }) === "unavailable",
);
ok(
  "a tap after a send starts a NEW recording rather than resuming",
  micToggleAction({ hasController: true, isListening: false }) === "start",
);

// ─── 3. The real controller, driven through one full tap-tap cycle ──────────

console.log("\n=== One tap starts, the next tap sends (real VoiceController) ===\n");

FakeWebSocket.reset();
const h = makeHarness();

ok("starts idle", h.controller.isListening === false);

await h.controller.startListening();
await settle();
ok("the first tap opens exactly one microphone", getUserMediaCalls.length === 1, `${getUserMediaCalls.length}`);
ok("the first tap opens exactly one Scribe session", FakeWebSocket.instances.length === 1, `${FakeWebSocket.instances.length}`);
ok("the tap reports listening", h.controller.isListening === true);
ok(
  "the state goes connecting → listening, never straight to listening",
  h.states.join(">") === "connecting>listening",
  h.states.join(">"),
);

const session = FakeWebSocket.instances[0];
const sessionUrl = new URL(session.url);
ok(
  "the session carries the minted single-use token, never the API key",
  sessionUrl.searchParams.get("token") === "tok_single_use_test" && !session.url.includes("sk_test_key_never_in_a_url"),
);
ok(
  "the session pins manual commit, so the second tap is the end of the utterance",
  sessionUrl.searchParams.get("commit_strategy") === "manual",
  sessionUrl.searchParams.get("commit_strategy") ?? "(unset)",
);

await h.controller.startListening();
ok(
  "a second start while recording opens no second mic and no second session (the toggle is idempotent)",
  getUserMediaCalls.length === 1 && FakeWebSocket.instances.length === 1,
  `${getUserMediaCalls.length} mic(s), ${FakeWebSocket.instances.length} session(s)`,
);
ok("the controller still reports listening after the ignored start", h.controller.isListening === true);

speakIntoLatestContext();
const audioFrames = session.sent.filter((f) => !f.commit);
ok(
  "mic audio goes out in the documented wire shape",
  audioFrames.length === 1 &&
    audioFrames[0].message_type === "input_audio_chunk" &&
    audioFrames[0].commit === false &&
    audioFrames[0].sample_rate === 16000 &&
    typeof audioFrames[0].audio_base_64 === "string" &&
    audioFrames[0].audio_base_64.length > 0,
  JSON.stringify(audioFrames[0] ?? null),
);

FakeWebSocket.committedText = "open yt and search for harkirat singh";
await h.controller.stopListening();

ok(
  "the second tap submits the dictated text exactly once",
  h.submitted.length === 1 && h.submitted[0] === "open yt and search for harkirat singh",
  JSON.stringify(h.submitted),
);
const commitFrames = session.sent.filter((f) => f.commit);
ok(
  "the send is the empty-audio commit signal, and only one is sent",
  commitFrames.length === 1 && commitFrames[0].audio_base_64 === "" && commitFrames[0].commit === true,
  JSON.stringify(commitFrames),
);
ok(
  "a clean utterance produces no error line",
  h.errors.length === 0,
  JSON.stringify(h.errors),
);
ok(
  "the state returns to idle so the next tap starts again",
  h.controller.isListening === false && h.states.at(-1) === "idle",
  h.states.join(">"),
);
ok(
  "the microphone is actually released after the send",
  stoppedTracks.length >= 1 && stoppedTracks.every((t) => t.stopped),
);
ok(
  "the task input is cleared, so the words are not left half-typed in the box",
  h.entryText.at(-1) === "",
  JSON.stringify(h.entryText),
);

// ─── 4. A tap that hears nothing must not look like a dead button ───────────

console.log("\n=== Silent recordings and dead sessions both explain themselves ===\n");

FakeWebSocket.reset();
const quiet = makeHarness();
await quiet.controller.startListening();
await settle();
speakIntoLatestContext();
FakeWebSocket.committedText = "";
await quiet.controller.stopListening();

ok("an empty utterance sends nothing", quiet.submitted.length === 0, JSON.stringify(quiet.submitted));
ok(
  "an empty utterance is explained instead of passing in silence",
  quiet.errors.filter((m) => /heard no words/i.test(m)).length === 1,
  JSON.stringify(quiet.errors),
);
ok(
  "the empty-utterance notice blames the microphone, not the API key or quota",
  !quiet.errors.some((m) => /quota|API key/i.test(m)),
  JSON.stringify(quiet.errors),
);
ok("state still returns to idle after an empty utterance", quiet.controller.isListening === false);

// (a) The session dies before a single frame is captured.
FakeWebSocket.reset();
const deaf = makeHarness();
await deaf.controller.startListening();
await settle();
FakeWebSocket.instances[0].close();
await deaf.controller.stopListening();
ok(
  "a session that drops before any audio is reported as a session drop",
  deaf.errors.some((m) => /closed before any transcript/i.test(m)),
  JSON.stringify(deaf.errors),
);
ok(
  "and the capture half is named too, so the user knows which side failed",
  deaf.errors.some((m) => /No microphone audio was captured/i.test(m)),
  JSON.stringify(deaf.errors),
);

// (b) Audio flowed, but the server never committed a transcript.
FakeWebSocket.reset();
const mute = makeHarness();
await mute.controller.startListening();
await settle();
speakIntoLatestContext();
FakeWebSocket.instances[0].close();
await mute.controller.stopListening();
ok(
  "audio that yields no transcript tells the user to check the key/quota",
  mute.errors.some((m) => /Scribe returned no transcript/i.test(m)),
  JSON.stringify(mute.errors),
);
ok(
  "and reports no words as sent when none arrived",
  mute.submitted.length === 0,
  JSON.stringify(mute.submitted),
);

// ─── 5. A send with nothing open is a no-op ─────────────────────────────────

console.log("\n=== Tapping send twice cannot corrupt the next utterance ===\n");

const idle = makeHarness();
await idle.controller.stopListening();
ok(
  "stopListening while idle does nothing and says nothing",
  idle.errors.length === 0 && idle.submitted.length === 0,
  JSON.stringify({ errors: idle.errors, submitted: idle.submitted }),
);

console.log(`\nvoice-test: ${passed} assertion(s) passed.\n`);
assert.ok(passed > 0);
