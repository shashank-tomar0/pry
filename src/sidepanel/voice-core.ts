/**
 * Voice core — pure helpers for the ElevenLabs integration.
 *
 * No DOM, no WebSocket, no audio devices: everything here is a pure function
 * so the verification harness can pin the privacy-critical transforms
 * (especially the speak-safe token redaction) headlessly.
 *
 * The two privacy rules of the voice stack live here:
 *   1. What the agent SPEAKS is derived from transcript text that the vault
 *      already re-redacted — and any token that still appears is pronounced
 *      as "[redacted]", never as its literal syntax.
 *   2. PCM conversion helpers exist only to move audio; no audio is retained
 *      anywhere (buffers are dropped after scheduling).
 *
 * The module's third job is words: the mic's announced contract and the click
 * decision behind it both live here, because the panel shipped text that
 * described a different interaction than the one it implemented. "Hold the mic
 * button to talk (release to send)" was on screen while the button ran a
 * click-to-start / click-to-send toggle, so users held a button that had
 * already started recording and released it expecting a send that a hold could
 * no longer perform. Prose living next to the code it describes drifts; prose
 * pinned by the harness (see scripts/voice-test.mjs) does not.
 */

/** Pronunciation used for vault tokens in spoken output. */
const SPOKEN_REDACTED = "redacted";

/**
 * The one line the panel shows when dictation becomes available.
 *
 * Deliberately describes the interaction the button ACTUALLY implements —
 * tap to start, tap again to send — and deliberately free of any hold/release
 * wording, which is what it used to say. It is a constant rather than a
 * literal at the render site so the copy cannot drift from the button again
 * without a test failing (scripts/voice-test.mjs asserts both halves).
 */
export const MIC_READY_ANNOUNCEMENT =
  "Voice: dictation ready. Tap the mic button to start recording, then tap it again to send.";

/** What a click on the mic button should do right now. */
export type MicToggleAction =
  /** Voice is available and idle: a tap opens the mic and starts dictating. */
  | "start"
  /** A recording is open: a tap closes it and sends what was heard. */
  | "stop"
  /** Voice is not configured (no key, STT off) or failed to initialize. */
  | "unavailable";

/**
 * The mic button's ONE decision, extracted from the panel's click handler.
 *
 * The panel used to inline this as `if (!voice) … if (voice.isListening) …`,
 * which meant "tap to start, tap to send" was only observable by reading a
 * closure inside a 1900-line DOM module — and so it could not be pinned by a
 * test, which is exactly how the announcement above came to describe
 * hold-to-talk for a button that had already been converted to a toggle.
 *
 * Note the third tap: `stop` is not a one-way door. A user who stops and taps
 * again starts a NEW recording rather than resuming a commit, which is what
 * makes a mis-tap cheap.
 */
export function micToggleAction(opts: {
  /** Is a VoiceController constructed and usable? */
  hasController: boolean;
  /** Is a recording open right now? */
  isListening: boolean;
}): MicToggleAction {
  if (!opts.hasController) return "unavailable";
  return opts.isListening ? "stop" : "start";
}

/**
 * Transform assistant text into a speak-safe string.
 *
 * - Vault tokens (<CRED_1>, <EMAIL_2>, <ID_3>) become "redacted" so the
 *   voice never reads token syntax aloud and never hints at the value type
 *   beyond what the panel already shows.
 * - Markdown link syntax is flattened ([label](url) -> label), emphasis
 *   markers and heading hashes are stripped, so TTS doesn't read punctuation.
 * - Long text is capped so a runaway answer can't monopolize the speaker.
 */
export function speakSafeTransform(text: string, maxChars = 600): string {
  let out = String(text ?? "");
  // Tokens first: <CRED_1>, <PII_12>, <EMAIL_2> — even mid-word glue noise.
  out = out.replace(/<[A-Z]+_\d+>/g, SPOKEN_REDACTED);
  // Markdown: links, emphasis, headings, code ticks.
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/[*_`#>]+/g, " ");
  // Collapse whitespace artifacts left by the strip.
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars).trimEnd()}…`;
  return out;
}

/** True when text still contains a raw vault token (must never be spoken). */
export function containsVaultToken(text: string): boolean {
  return /<[A-Z]+_\d+>/.test(String(text ?? ""));
}

/** Blunt sweep used only as a last resort (see toSpeakable). */
export function stripVaultTokens(text: string): string {
  return String(text ?? "").replace(/<[A-Z]+_\d+>/g, SPOKEN_REDACTED);
}

/** What the speaker should actually be handed, plus what it cost. */
export interface SpeakableText {
  /** Guaranteed token-free, markdown-flattened, length-capped. */
  text: string;
  /** How many vault tokens were pronounced as "redacted". */
  redactedTokens: number;
}

/**
 * The ONE decision about what may be spoken aloud.
 *
 * Why this function exists instead of the guard that used to live in
 * `voice-controller.speak()`: the controller refused to speak at all when the
 * text contained a token, and it refused BEFORE `speakSafeTransform` ran — so
 * the transform whose entire documented job is "pronounce tokens as [redacted]"
 * was unreachable exactly when it was needed. The reported symptom was a
 * transcript line reading "Voice: Refusing to speak: raw vault token in
 * assistant text (this is a bug, please report)" instead of audio, on any run
 * where the model quoted a token back (the Gmail tab title alone carries
 * `<CRED_1>`, so this is the common case, not an edge case).
 *
 * A token in the text is not a reason to go silent — it is the reason the
 * redaction below exists. Refusing is now impossible by construction: the
 * transform runs first, and anything it somehow missed is swept afterwards, so
 * `containsVaultToken(result.text)` is always false.
 */
export function toSpeakable(text: string, maxChars = 600): SpeakableText {
  const raw = String(text ?? "");
  const redactedTokens = (raw.match(/<[A-Z]+_\d+>/g) ?? []).length;
  const transformed = speakSafeTransform(raw, maxChars);
  // Defense in depth: `speakSafeTransform` strips tokens before it caps, so
  // this only fires if its pattern is ever changed out from under this. Even
  // then, the speaker gets clean text rather than guaranteed silence.
  const text2 = containsVaultToken(transformed) ? stripVaultTokens(transformed) : transformed;
  return { text: text2, redactedTokens };
}

/**
 * Convert Float32 audio samples [-1, 1] to 16-bit PCM (little-endian bytes),
 * the format Scribe Realtime expects after base64 encoding.
 *
 * Quantisation is rounded (not truncated) so a 1.0 sample encodes to the
 * positive peak (0x7FFF) rather than collapsing to 0. Float values are
 * clamped into the [-1, 1] range first so loud inputs don't wrap.
 */
export function floatTo16BitPCM(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    // Map [-1, 1] to [-32768, 32767] with proper rounding so 1.0 hits +32767
    // (and -1.0 hits -32768, not 0), and so 0.5 lands at +16384, not 0.
    const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    view.setInt16(i * 2, v, true);
  }
  return out;
}

/** Convert 16-bit PCM little-endian bytes back to Float32 [-1, 1] samples.
 *  Positive values divide by 32767 (the positive peak) so a 1.0 input
 *  decodes back to exactly 1.0; negatives divide by 32768 (the negative
 *  peak) so -1.0 maps to exactly -1.0. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.length / 2);
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true);
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

/** Base64-encode binary audio for the Scribe WebSocket frames. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Build the request init for the TTS REST call. Kept pure-ish (fetch is
 * injectable) so tests can assert the exact payload — model id, output
 * format, and the header that carries the key.
 */
const TTS_MODEL_FLASH = "eleven_flash_v2_5";
export const TTS_OUTPUT_FORMAT = "pcm_16000"; // 16 kHz mono PCM for streaming playback

/**
 * Default narration voice — a PREMADE voice, deliberately.
 *
 * The obvious choice (Rachel, `21m00Tcm4TlvDq8ikWAM`) is a LIBRARY voice, and
 * ElevenLabs' free plan rejects library voices over the API with
 * 402 `paid_plan_required` — so the hardcoded fallback made speak-aloud fail
 * with a payment error on every free-tier install, for a reason that has
 * nothing to do with the user's setup. Premade voices work on the free plan.
 */
export const DEFAULT_TTS_VOICE_ID = "SAz9YHcvj6GT2YYXdXww"; // River — relaxed, neutral

/**
 * Why a microphone request failed, as far as a caller can tell.
 *
 * Chrome reports every one of these as some flavour of "Requested device not
 * found" or "Permission denied", and the fixes are completely different — so
 * the panel used to show the raw error and the user had no next move. The
 * causes are distinguishable at runtime, and this is the decision table.
 */
export type MicFailureKind =
  /** The extension build never requested audioCapture — getUserMedia cannot work. */
  | "missing-permission"
  /** The permission is declared, but no audio input device is visible. */
  | "no-device"
  /** The user (or a previous silent dismissal) blocked mic access. */
  | "blocked"
  /** A device exists but the OS or another app holds it. */
  | "busy"
  /** Device is fine; the requested constraints are not supported by it. */
  | "constraints"
  | "unknown";

export interface MicFailureSignals {
  /** Error `name`, e.g. `NotFoundError`, `NotAllowedError`, `NotReadableError`. */
  name?: string;
  /** Raw message, shown verbatim as the last resort. */
  message?: string;
  /** Does THIS build declare `audioCapture` in its manifest? */
  hasCapturePermission: boolean;
  /** `audioinput` entries visible to the page, or null when enumeration failed. */
  audioInputs: number | null;
}

export function classifyMicFailure(s: MicFailureSignals): MicFailureKind {
  const name = String(s.name ?? "");
  const message = String(s.message ?? "");
  // Decisive and checkable at runtime: without the permission, Chrome hides
  // every input device from an extension page and reports NotFoundError.
  if (!s.hasCapturePermission) return "missing-permission";
  if (name === "NotAllowedError" || name === "SecurityError") return "blocked";
  if (/dismiss|denied|not allowed/i.test(message)) return "blocked";
  if (name === "NotReadableError" || name === "TrackStartError") return "busy";
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") return "constraints";
  // No devices at all is the other cause of the SAME error string, so it is
  // only reachable once the permission question is settled.
  if (s.audioInputs === 0) return "no-device";
  return "unknown";
}

/** The actionable next step for a failure kind — what the panel shows. */
export function micFailureAdvice(kind: MicFailureKind, raw?: string): string {
  const detail = raw ? ` (${raw})` : "";
  switch (kind) {
    case "missing-permission":
      return (
        "this build of PRY has no `audioCapture` permission, so Chrome refuses to hand any " +
        "microphone to the side panel — it reports every device as missing. Rebuild/reload the " +
        `extension from a current source tree (the permission is in src/manifest.json)${detail}.`
      );
    case "no-device":
      return (
        "no microphone is visible to the browser. Connect or enable an input device, check " +
        "the OS sound settings, then press the mic again" +
        detail +
        "."
      );
    case "blocked":
      return (
        "mic access was blocked. Chrome shows the Allow prompt once; after a dismissal it stays " +
        "silent, so allow it permanently: open chrome://extensions → PRY → Details → Site " +
        `settings → set Microphone to "Allow", then press the mic again${detail}.`
      );
    case "busy":
      return `another app is holding the microphone. Close it and retry${detail}.`;
    case "constraints":
      return `the microphone rejected the requested audio settings${detail}. Retrying with defaults…`;
    default:
      return (
        "could not open the microphone" + detail +
        ". Check chrome://extensions → PRY → Details → Site settings → Microphone is " +
        '"Allow", and that an input device is connected.'
      );
  }
}

/**
 * Constraints for the dictation capture.
 *
 * The tuned set asks for 16 kHz mono with echo cancellation and noise
 * suppression — but a device that does not support those exact constraints
 * fails the whole `getUserMedia` call, which used to end the attempt. Callers
 * try this first and fall back to `{ audio: true }` (see voice-controller).
 */
export const MIC_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  channelCount: 1,
};

/** Fallback constraints: any input the browser will give us. */
export const MIC_FALLBACK_CONSTRAINTS: MediaStreamConstraints = { audio: true };

export function ttsRequestBody(text: string): Record<string, unknown> {
  return {
    text,
    model_id: TTS_MODEL_FLASH,
  };
}
