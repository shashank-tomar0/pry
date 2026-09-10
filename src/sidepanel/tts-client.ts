/**
 * ElevenLabs Flash v2.5 streaming TTS client.
 *
 * REST endpoint: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream
 *   with xi-api-key header, JSON body {text, model_id}, query param
 *   output_format=pcm_16000.
 *
 * Returns audio bytes that the caller schedules for playback. We never
 * persist audio; the response is fed to the AudioContext and dropped.
 *
 * Speak-safety: the caller MUST pass text already transformed by
 * voice-core.speakSafeTransform() — vault tokens are replaced with
 * "redacted" before any bytes leave the device.
 */

import { pcm16ToFloat32, TTS_OUTPUT_FORMAT, ttsRequestBody } from "./voice-core";

const TTS_STREAM_URL = (voiceId: string) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`;

export interface TtsCallbacks {
  onChunk?: (samples: Float32Array) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

export async function streamTts(
  text: string,
  voiceId: string,
  apiKey: string,
  callbacks: TtsCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  if (!apiKey) throw new Error("ElevenLabs API key is required for TTS.");
  if (!voiceId) throw new Error("ElevenLabs voice id is required for TTS.");
  if (!text.trim()) return;

  const url = new URL(TTS_STREAM_URL(voiceId));
  url.searchParams.set("output_format", TTS_OUTPUT_FORMAT);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "content-type": "application/json",
      accept: "audio/pcm",
    },
    body: JSON.stringify(ttsRequestBody(text)),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    callbacks.onError?.(`ElevenLabs TTS error (${res.status}): ${detail.slice(0, 200)}`);
    return;
  }
  if (!res.body) {
    callbacks.onError?.("ElevenLabs TTS returned no audio stream.");
    return;
  }

  const reader = res.body.getReader();
  let leftover = new Uint8Array();
  // Flush whatever's in the buffer (PCM16 samples must be 2-byte aligned).
  const flush = (): void => {
    let buf = leftover;
    const alignedLen = buf.length - (buf.length % 2);
    if (alignedLen < 2) return;
    if (alignedLen !== buf.length) buf = buf.subarray(0, alignedLen);
    callbacks.onChunk?.(pcm16ToFloat32(buf));
    leftover = buf.subarray(alignedLen);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    // Concat with any unaligned bytes from the previous chunk.
    const merged = new Uint8Array(leftover.length + value.length);
    merged.set(leftover, 0);
    merged.set(value, leftover.length);
    leftover = merged;
    flush();
  }
  // Trailing odd byte (shouldn't happen on a well-behaved server) is dropped.
  callbacks.onDone?.();
}
