/**
 * ElevenLabs Scribe Realtime client (STT — voice task input).
 *
 * Wire protocol (from the published AsyncAPI spec for
 * GET /v1/speech-to-text/realtime — NOT the SDK's convenience API):
 *   - Client-side browser usage requires a single-use token minted via the
 *     REST endpoint POST /v1/single-use-token/realtime_scribe (the raw key
 *     must never be sent from the extension).
 *   - Token + model id + audio format + commit strategy are connection query
 *     params. commit_strategy=manual is explicit: we call commit() ourselves
 *     when the user taps the mic again to send, so VAD must not race us.
 *   - The ONLY client message the server accepts is an InputAudioChunk:
 *       { message_type: "input_audio_chunk", audio_base_64, commit, sample_rate }
 *     `message_type`, `audio_base_64`, `commit` and `sample_rate` are all
 *     REQUIRED. Sending the SDK's `{audioBase64}` shape (which is what this
 *     module used to do) is silently dropped — audio was never transcribed.
 *   - Server events are discriminated by `message_type`: session_started,
 *     partial_transcript, committed_transcript, error, auth_error, …
 *
 * This module owns the connection; the side panel wires it up.
 */

import { bytesToBase64, floatTo16BitPCM } from "./voice-core";

const SCRIBE_TOKEN_URL =
  "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const SCRIBE_WS_BASE = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const SCRIBE_MODEL = "scribe_v2_realtime";
const SCRIBE_SAMPLE_RATE = 16000;
const SCRIBE_AUDIO_FORMAT = "pcm_16000";

/** The one client→server message type the Realtime STT API accepts. */
export interface ScribeInputAudioChunk {
  message_type: "input_audio_chunk";
  audio_base_64: string;
  commit: boolean;
  sample_rate: number;
}

/**
 * Build the wire frame for one audio chunk. Exported (and pure) so the
 * verification harness can pin the exact shape — a wrong field name here is
 * invisible at runtime and silently disables speech-to-text.
 *
 * An empty `audio_base_64` with `commit: true` is the documented commit
 * signal (the field is required but the audio may be empty).
 */
export function scribeAudioChunk(
  base64Audio: string,
  commit = false,
  sampleRate: number = SCRIBE_SAMPLE_RATE,
): ScribeInputAudioChunk {
  return {
    message_type: "input_audio_chunk",
    audio_base_64: base64Audio,
    commit,
    sample_rate: sampleRate,
  };
}

/**
 * Mint a single-use WebSocket token using the user's API key (sent only
 * server-to-server, never embedded in the extension code).
 */
export async function mintScribeToken(apiKey: string): Promise<string> {
  if (!apiKey) throw new Error("ElevenLabs API key is required for Scribe Realtime.");
  const res = await fetch(SCRIBE_TOKEN_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey, accept: "application/json" },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // A 401 is the user's key, not a PRY bug, and the raw JSON body ("Invalid
    // API key" plus a request id) does not say what to do about it. Say it.
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "ElevenLabs rejected the API key (401 unauthorized). Re-copy the key from " +
          "elevenlabs.io → Profile → API keys into PRY's options and save — keys that " +
          "were rotated, revoked, or pasted with a trailing space fail here.",
      );
    }
    throw new Error(`ElevenLabs token mint failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("ElevenLabs token mint returned no token.");
  return body.token;
}

/** Builds the WS URL with the auth token, model, and audio format params. */
export function scribeWebSocketUrl(token: string): string {
  const u = new URL(SCRIBE_WS_BASE);
  u.searchParams.set("token", token);
  u.searchParams.set("model_id", SCRIBE_MODEL);
  u.searchParams.set("audio_format", SCRIBE_AUDIO_FORMAT);
  u.searchParams.set("sample_rate", String(SCRIBE_SAMPLE_RATE));
  // Manual commit: the mic button's second tap ("send") is the
  // end-of-utterance signal, so server-side VAD must not commit a segment out
  // from under us.
  u.searchParams.set("commit_strategy", "manual");
  return u.toString();
}

/** Sample rate Scribe expects (PCM_16000). */
export const SCRIBE_SAMPLE_RATE_HZ = SCRIBE_SAMPLE_RATE;

/** Convert Float32 mic frames to the base64 PCM16 frame Scribe expects. */
export function micFrameToScribeBase64(samples: Float32Array): string {
  return bytesToBase64(floatTo16BitPCM(samples));
}

export interface ScribeTranscriptCallbacks {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onOpen?: () => void;
  onClose?: (reason?: string) => void;
}

/**
 * Thin promise wrapper around a Scribe WebSocket connection.
 * Caller is responsible for the mic capture loop and for committing
 * (the SDK does both for you; we keep this raw so the verification
 * harness can drive it without a real microphone).
 */
export class ScribeConnection {
  private ws: WebSocket | null = null;
  private closed = false;
  /** True once the server sent session_started — before that, audio is dropped. */
  private sessionReady = false;

  constructor(private readonly callbacks: ScribeTranscriptCallbacks = {}) {}

  /** True once the server confirmed the session and will accept audio. */
  get isReady(): boolean {
    return this.sessionReady && this.isOpen;
  }

  connect(token: string): void {
    if (this.ws) this.close();
    this.closed = false;
    this.sessionReady = false;
    const ws = new WebSocket(scribeWebSocketUrl(token));
    this.ws = ws;
    ws.onopen = () => this.callbacks.onOpen?.();
    ws.onclose = (ev) => {
      if (!this.closed) this.callbacks.onClose?.(ev.reason || `code ${ev.code}`);
    };
    ws.onerror = () => this.callbacks.onError?.("Scribe WebSocket error");
    ws.onmessage = (ev) => {
      // The server discriminates events by `message_type`. Older SDK builds
      // used `type`; accept both so a server-side rename cannot silently mute
      // live transcription again.
      let payload: { message_type?: string; type?: string; text?: string; error?: string; warning?: string };
      try {
        payload = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const kind = payload.message_type ?? payload.type ?? "";
      if (kind === "session_started") {
        this.sessionReady = true;
        return;
      }
      if (kind === "partial_transcript" && typeof payload.text === "string") {
        this.callbacks.onPartial?.(payload.text);
      } else if (
        (kind === "committed_transcript" || kind === "committed_transcript_with_timestamps") &&
        typeof payload.text === "string"
      ) {
        this.callbacks.onFinal?.(payload.text);
      } else if (kind === "warning" || kind === "error" || kind.endsWith("error") || kind === "quota_exceeded" || kind === "rate_limited" || kind === "commit_throttled") {
        // Human-readable reason first — `error` carries the server's message.
        this.callbacks.onError?.(payload.error || payload.warning || kind || "Scribe error");
      }
    };
  }

  /** True once the socket is open and audio/commits will actually send. */
  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Wait until the session can accept audio AND a commit.
   *
   * Waiting merely for WebSocket OPEN is not enough: a commit sent before
   * session_started arrives is accepted by the socket but produces no
   * transcript, which looks exactly like "the mic did nothing".
   */
  async waitForReady(timeoutMs = 3000): Promise<boolean> {
    if (this.isReady) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.closed) return false;
      if (this.isReady) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.isReady;
  }

  /** Wait for the socket to open (a quick second tap can precede onopen). */
  async waitForOpen(timeoutMs = 2000): Promise<boolean> {
    if (this.isOpen) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.closed) return false;
      if (this.isOpen) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.isOpen;
  }

  /** Send a base64-encoded PCM16 audio frame in the documented wire shape. */
  sendAudioBase64(b64: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(scribeAudioChunk(b64, false)));
  }

  /** End-of-utterance commit so Scribe flushes the final transcript. */
  commit(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(scribeAudioChunk("", true)));
  }

  close(): void {
    if (!this.ws || this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
