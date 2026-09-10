/**
 * ElevenLabs Scribe Realtime client (STT — voice task input).
 *
 * Wire protocol (from @elevenlabs/client 1.25 type defs):
 *   - Client-side browser usage requires a single-use token minted via the
 *     REST endpoint POST /v1/single-use-token/realtime_scribe (the raw key
 *     must never be sent from the extension).
 *   - Token + model id + audio format are sent as connection query params.
 *   - Audio frames are PCM16 base64-encoded and sent as WebSocket messages
 *     with {audioBase64} / {commit} shapes.
 *   - Events arrive as PARTIAL_TRANSCRIPT (live) and COMMITTED_TRANSCRIPT
 *     (final) via the SDK's RealtimeEvents map.
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

  constructor(private readonly callbacks: ScribeTranscriptCallbacks = {}) {}

  connect(token: string): void {
    if (this.ws) this.close();
    this.closed = false;
    const ws = new WebSocket(scribeWebSocketUrl(token));
    this.ws = ws;
    ws.onopen = () => this.callbacks.onOpen?.();
    ws.onclose = (ev) => {
      if (!this.closed) this.callbacks.onClose?.(ev.reason || `code ${ev.code}`);
    };
    ws.onerror = () => this.callbacks.onError?.("Scribe WebSocket error");
    ws.onmessage = (ev) => {
      let payload: { type?: string; text?: string };
      try {
        payload = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (payload.type === "partial_transcript" && typeof payload.text === "string") {
        this.callbacks.onPartial?.(payload.text);
      } else if (payload.type === "committed_transcript" && typeof payload.text === "string") {
        this.callbacks.onFinal?.(payload.text);
      } else if (payload.type === "error" || payload.type === "auth_error") {
        this.callbacks.onError?.(payload.text || payload.type);
      }
    };
  }

  /** Send a base64-encoded PCM16 audio frame. */
  sendAudioBase64(b64: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ audioBase64: b64 }));
  }

  /** End-of-utterance commit so Scribe flushes the final transcript. */
  commit(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ commit: true }));
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
