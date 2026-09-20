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

import { DEFAULT_TTS_VOICE_ID, drainAligned, pcm16ToFloat32, TTS_OUTPUT_FORMAT, ttsRequestBody } from "./voice-core";

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

  // The hi-fi format is requested first; a 422 (validation) means the tier
  // rejected it — documented for 44.1 kHz PCM on non-Pro plans, possible for
  // anything above 16 kHz later — and the run falls back to telephone-grade
  // rather than failing voiceless. Only 422 retries: 401/402/4xx name the
  // real problem (key, voice, quota) and must surface, not loop.
  const formats: string[] =
    TTS_OUTPUT_FORMAT === "pcm_16000" ? ["pcm_16000"] : [TTS_OUTPUT_FORMAT, "pcm_16000"];
  let res: Response | null = null;
  let downgraded = false;
  for (const format of formats) {
    url.searchParams.set("output_format", format);
    res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/pcm",
      },
      body: JSON.stringify(ttsRequestBody(text)),
      signal,
    });
    if (res.status === 422 && !downgraded) {
      downgraded = true;
      await res.text().catch(() => "");
      continue;
    }
    break;
  }
  if (!res) {
    callbacks.onError?.("ElevenLabs TTS returned no response.");
    return;
  }
  if (downgraded) {
    // Said once per utterance would spam; the panel surfaces errors, and a
    // downgrade is worth one line so "why does it sound thin" is answerable.
    callbacks.onError?.(
      "ElevenLabs rejected the 24 kHz stream for this plan — playing telephone-grade 16 kHz instead.",
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // 402 is the one users will actually hit: ElevenLabs' free plan rejects
    // library voices over the API. The raw body says `paid_plan_required`
    // without explaining that a PREMADE voice fixes it for free.
    if (res.status === 402) {
      callbacks.onError?.(
        "ElevenLabs refuses this voice on the free plan (402 paid_plan_required). " +
          "Library voices need a paid subscription; set the voice id in PRY's options to a " +
          `premade voice instead — the default (${DEFAULT_TTS_VOICE_ID}) works on the free plan.`,
      );
      return;
    }
    if (res.status === 401 || res.status === 403) {
      callbacks.onError?.(
        "ElevenLabs rejected the API key for text-to-speech (401 unauthorized). " +
          "Re-copy it from elevenlabs.io → Profile → API keys into PRY's options and save.",
      );
      return;
    }
    callbacks.onError?.(`ElevenLabs TTS error (${res.status}): ${detail.slice(0, 200)}`);
    return;
  }
  if (!res.body) {
    callbacks.onError?.("ElevenLabs TTS returned no audio stream.");
    return;
  }

  const reader = res.body.getReader();
  let leftover: Uint8Array = new Uint8Array();
  // Flush whatever's in the buffer (PCM16 samples must be 2-byte aligned).
  // The tail byte of an odd-length read is CARRIED, not dropped: it is the
  // first half of the next sample, and dropping it deletes a sample per odd
  // read (an audible tick each time). drainAligned splits head from tail so
  // the bookkeeping cannot drift again.
  const flush = (): void => {
    const { aligned, rest } = drainAligned(leftover);
    if (aligned.length < 2) return;
    callbacks.onChunk?.(pcm16ToFloat32(aligned));
    leftover = rest;
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
