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
 */

/** Pronunciation used for vault tokens in spoken output. */
const SPOKEN_REDACTED = "redacted";

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

export function ttsRequestBody(text: string): Record<string, unknown> {
  return {
    text,
    model_id: TTS_MODEL_FLASH,
  };
}
