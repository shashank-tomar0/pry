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
    this.connectedTo = [];
  }
  connect(dest) {
    this.connected = true;
    this.connectedTo.push(dest ?? null);
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
    this.gains = [];
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
    const node = { gain: { value: 0 }, connect() {}, disconnect() {} };
    this.gains.push(node);
    return node;
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
const { MIC_READY_ANNOUNCEMENT, micToggleAction, VoiceController, mergeFloat32Arrays, drainAligned, MIN_SPEECH_CHUNK_SAMPLES, PREBUFFER_SAMPLES, PLAYBACK_SAMPLE_RATE_HZ, TTS_OUTPUT_FORMAT, audioGapMs, AUDIO_GAP_FLOOR_MS } = mod;

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

// ─── 6. The mic is never audible ────────────────────────────────────────────
// The capture processor must join the output graph (Chrome only fires
// onaudioprocess on a connected node) but must never reach the speakers:
// a straight processor→destination wire makes room noise ride under
// everything ("someone's mic is on"). The keep-alive runs through a
// zero-gain node instead — structural silence, not a spec promise.
console.log("\n=== Capture never monitors the microphone ===\n");

FakeWebSocket.reset();
const monitor = makeHarness();
await monitor.controller.startListening();
await settle();
const micCtx = audioContexts.at(-1);
const micProcessor = micCtx.processors.at(-1);
const keepAliveGains = micCtx.gains.filter((g) => g.gain.value === 0);
ok("the capture processor runs through a zero-gain keep-alive",
  micProcessor.connectedTo.length === 1 && keepAliveGains.includes(micProcessor.connectedTo[0]),
  JSON.stringify(micProcessor.connectedTo.map((t) => t?.kind ?? "gain")));
ok("and nothing in the capture graph touches the speakers",
  !micProcessor.connectedTo.includes(micCtx.destination));
await monitor.controller.stopListening();

// ─── 7. Streamed speech schedules floors, not slivers ───────────────────────
// The TTS stream flushes whatever each network read delivered — sometimes a
// few milliseconds — and every scheduled buffer is a splice point. Unfloored,
// dozens of slivers per second read as a permanent crackle bed under the
// voice (the reported "background noise every time"). The controller queues
// to a 0.25 s floor and flushes the remainder at stream end.
console.log("\n=== Speech playback floors network-sized reads ===\n");

ok("the speech floor is a quarter second at the playback rate",
  PLAYBACK_SAMPLE_RATE_HZ === 24000 && MIN_SPEECH_CHUNK_SAMPLES === 6000);
ok("and the opening prebuffer is three floors (0.75 s)",
  PREBUFFER_SAMPLES === 18000 && PREBUFFER_SAMPLES > MIN_SPEECH_CHUNK_SAMPLES);
ok("and the wire asks for 24 kHz PCM, not telephone-grade",
  TTS_OUTPUT_FORMAT === "pcm_24000");
ok("merge preserves order across uneven parts",
  (() => {
    const merged = mergeFloat32Arrays([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]);
    return merged.length === 3 && merged[0] === 1 && merged[1] === 2 && merged[2] === 3;
  })());
ok("even reads split cleanly with no tail",
  (() => {
    const { aligned, rest } = drainAligned(new Uint8Array([1, 2, 3, 4]));
    return aligned.length === 4 && rest.length === 0;
  })());
ok("an odd read keeps its dangling byte instead of dropping a sample",
  (() => {
    const { aligned, rest } = drainAligned(new Uint8Array([1, 2, 3, 4, 5]));
    return aligned.length === 4 && rest.length === 1 && rest[0] === 5;
  })());
ok("a lone byte waits rather than decoding half a sample",
  (() => {
    const { aligned, rest } = drainAligned(new Uint8Array([9]));
    return aligned.length === 0 && rest.length === 1;
  })());

let scheduledBuffers = 0;
const realCreateBuffer = FakeAudioContext.prototype.createBuffer;
FakeAudioContext.prototype.createBuffer = function (...args) {
  scheduledBuffers++;
  return realCreateBuffer.apply(this, args);
};
const tts = makeHarness();
const bufsBefore = scheduledBuffers;
tts.controller.queueSpeechChunk(new Float32Array(100));
ok("a short read schedules nothing on its own", scheduledBuffers === bufsBefore);
tts.controller.queueSpeechChunk(new Float32Array(3900));
tts.controller.queueSpeechChunk(new Float32Array(8000));
ok("even past the old floor, the opening prebuffer holds", scheduledBuffers === bufsBefore);
tts.controller.queueSpeechChunk(new Float32Array(6000));
ok("hitting the prebuffer schedules exactly one merged buffer", scheduledBuffers === bufsBefore + 1);
tts.controller.queueSpeechChunk(new Float32Array(100));
ok("after starting, short reads wait for the speaking floor again", scheduledBuffers === bufsBefore + 1);
tts.controller.queueSpeechChunk(new Float32Array(5900));
ok("and the floor still schedules exactly one merged buffer", scheduledBuffers === bufsBefore + 2);
tts.controller.queueSpeechChunk(new Float32Array(100));
tts.controller.queueSpeechChunk(new Float32Array(0), true);
ok("stream end flushes the remainder instead of dropping it", scheduledBuffers === bufsBefore + 3);
tts.controller.queueSpeechChunk(new Float32Array(100));
tts.controller.stopSpeaking();
tts.controller.queueSpeechChunk(new Float32Array(17900));
ok("stopping drops the queue — no utterance leaks into the next",
  scheduledBuffers === bufsBefore + 3);
FakeAudioContext.prototype.createBuffer = realCreateBuffer;

// ─── 8. Playback gaps are measured, not guessed ─────────────────────────────
// "First words clean, then choppy" is a starving stream: buffers scheduled
// later than the previous one ends. The detector counts only real gaps —
// startup latency (no predecessor) and sub-50 ms scheduling jitter are not
// starvation and must not report.
console.log("\n=== Audio underruns are measured at schedule time ===\n");

ok("continuous scheduling measures no gap", audioGapMs(1.0, 1.0) === 0);
ok("a first schedule has no predecessor to gap against", audioGapMs(0, 3.2) === 0);
ok("sub-floor slips are jitter, not starvation",
  audioGapMs(1.0, 1.0 + (AUDIO_GAP_FLOOR_MS - 1) / 1000) === 0);
ok("a real stall reports its milliseconds",
  audioGapMs(1.0, 1.4) === 400 && audioGapMs(2.0, 2.251) === 251);
const controllerSource = await readFile("src/sidepanel/voice-controller.ts", "utf8");
ok("gap stats ride the utterances completion callback",
  /onStats\?: \(stats: SpeechStats\)/.test(controllerSource) &&
  /this\.callbacks\.onStats\?\.\(\{/.test(controllerSource));
const ttsSource = await readFile("src/sidepanel/tts-client.ts", "utf8");
ok("a tier-rejected hi-fi stream falls back to 16 kHz instead of failing voiceless",
  /res\.status === 422/.test(ttsSource) && /"pcm_16000"/.test(ttsSource));

// ─── 9. Completed transcript stays scrollable ─────────────────────────────
// Reported UX: scrolling the completed tail feels stuck. Two mechanisms:
// (1) the renderer yanked to bottom on EVERY patch, so a 60 ms reasoning
// stream welded the view down; (2) audit screenshots decoded lazily WHEN
// SCROLLED TO, resizing boxes under the user's fingers. Auto-scroll now
// follows new cards only; audit images decode eagerly in the burst.
console.log("\n=== Completed transcript stays scrollable ===\n");

ok(
  "auto-scroll follows new cards, never live patches",
  /const isNew = !nodes\.has\(entry\.id\);/.test(sidepanelSource) &&
    /if \(stick && isNew\) transcriptEl\.scrollTop = transcriptEl\.scrollHeight;/.test(sidepanelSource),
);
ok(
  "audit screenshots decode eagerly so boxes never resize under a scroll",
  /img\.loading = "eager";/.test(sidepanelSource) &&
    !/img\.loading = "lazy";/.test(sidepanelSource),
);
ok(
  "streaming paints coalesce to one per frame instead of one per patch",
  /schedulePaint\(event\.id, \(\) => \{/.test(sidepanelSource) &&
    /requestAnimationFrame\(flush\)/.test(sidepanelSource),
);
ok(
  "a removed card never breaks the flush for the rest",
  /!target\.isConnected/.test(sidepanelSource) || /!target \|\| !target\.isConnected/.test(sidepanelSource),
);
// Reported live: the run settled (diagnostics printed, TTS spoke) but NO
// answer card ever appeared under the question — a lost worker→panel message
// with nothing to name it. The panel now balances the books at run end:
// diagnostics seen + no assistant card + no error card + no user Stop means
// the answer vanished downstream, and that renders a reportable error card
// instead of silence.
ok(
  "a run that ends with diagnostics but no answer and no error names the loss",
  /runDiagnosticsSeen && !runAssistantSeen && !runErrorSeen && !userStoppedRun/.test(sidepanelSource) &&
    /no answer reached the panel/.test(sidepanelSource),
);
ok(
  "the fallback never fires on user-stopped runs or runs that already errored",
  /userStoppedRun = true/.test(sidepanelSource) && /runErrorSeen = true/.test(sidepanelSource),
);
// Same run's other half: speech is async (settings fetch), so a Stop/NEW in
// the gap used to speak text for a transcript that no longer shows the card.
// The speaker re-checks the run is still current after the await.
ok(
  "speech after an async gap is dropped when the run moved on",
  /stillCurrent\?: \(\) => boolean/.test(sidepanelSource) &&
    /if \(stillCurrent && !stillCurrent\(\)\) return;/.test(sidepanelSource),
);
// Reported live: pressing Allow on a Gmail Send confirmation left RUNNING
// with a pending step forever — the approval wait is worker-idle time and an
// idle MV3 worker is suspended ~30 s in. The port below holds the worker
// through human-speed waits; if the worker dies anyway, the panel names the
// loss instead of displaying a live run that will never move again.
ok(
  "an open keepalive port holds the worker through approval waits",
  /chrome\.runtime\.connect\(\{ name: "pry-keepalive" \}\)/.test(sidepanelSource) &&
    /Lost the connection to the background worker mid-run/.test(sidepanelSource),
);
ok(
  "the disconnect card only fires on a run that was actually live",
  /if \(panelRunning\)/.test(sidepanelSource),
);

console.log(`\nvoice-test: ${passed} assertion(s) passed.\n`);
assert.ok(passed > 0);
