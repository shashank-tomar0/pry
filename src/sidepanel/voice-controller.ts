/**
 * Voice controller — wires Scribe Realtime (STT) and Flash TTS into the
 * side panel's task lifecycle with privacy-first defaults.
 *
 * Responsibilities:
 *  - Mic capture: getUserMedia -> AudioWorklet (16 kHz PCM16) -> base64 frames
 *    into the Scribe WebSocket. Audio buffers are dropped the moment a chunk
 *    is sent; nothing is persisted.
 *  - Hold-to-talk: capture starts on press and stops on release, at which
 *    point Scribe's `commit()` is called and the final transcript is fed into
 *    submit().
 *  - TTS: subscribe to the final-answer transcript stream and play each
 *    step's text through the shared AudioContext. Spoken text is run through
 *    voice-core.speakSafeTransform() so vault tokens never reach the speaker.
 *
 * The whole module is feature-flagged on settings.elevenlabs.sttEnabled /
 * .ttsEnabled; UI must consult the flag before constructing this.
 */

import { containsVaultToken, speakSafeTransform } from "./voice-core";
import {
  SCRIBE_SAMPLE_RATE_HZ,
  ScribeConnection,
  micFrameToScribeBase64,
  mintScribeToken,
} from "./scribe-client";
import { streamTts } from "./tts-client";

export interface VoiceControllerCallbacks {
  /** Called with live partial text while the user is speaking. */
  onPartial?: (text: string) => void;
  /** Called with the final transcript after Scribe commits. */
  onFinal?: (text: string) => void;
  /** Called on STT or TTS errors so the UI can surface them. */
  onError?: (message: string) => void;
  /** Called when STT state changes (idle, listening, connecting, error). */
  onStateChange?: (state: "idle" | "connecting" | "listening" | "error") => void;
  /** Called when the Scribe WebSocket finishes opening. */
  onOpen?: () => void;
}

export interface VoiceControllerConfig {
  apiKey: string;
  /** Voice id used for streaming TTS. */
  voiceId: string;
  /** Push a value into the task input. The host wires this to its submit(). */
  submitTask: (task: string) => void;
  /** Replace the panel's user-entry line so partials render live. */
  setUserEntryText: (text: string) => void;
  /**
   * Optional callback when TTS playback starts for a chunk.
   * Audio is scheduled internally via Web Audio; this is informational only.
   */
  speakAssistantText?: (text: string) => void;
  callbacks?: VoiceControllerCallbacks;
}

const MIC_CHUNK_FRAMES = 1600; // 100 ms at 16 kHz — keeps latency bounded.

export class VoiceController {
  private scribe: ScribeConnection | null = null;
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private playbackAudioCtx: AudioContext | null = null;
  private playbackGain: GainNode | null = null;
  private nextPlaybackTime = 0;
  private ttsAbort: AbortController | null = null;
  private cancelListening = false;
  private state: "idle" | "connecting" | "listening" | "error" = "idle";
  /** Frames actually handed to the socket (0 means the mic produced nothing). */
  private framesSent = 0;
  /** Resolved the moment a committed transcript arrives (or the session dies). */
  private finalWaiter: (() => void) | null = null;
  private heardFinal = false;
  private readonly config: VoiceControllerConfig;
  private callbacks: VoiceControllerCallbacks;

  constructor(config: VoiceControllerConfig) {
    this.config = config;
    this.callbacks = config.callbacks ?? {};
  }

  get isListening(): boolean {
    return this.state === "listening" || this.state === "connecting";
  }

  /** Begin hold-to-talk capture: opens mic, connects Scribe, streams audio. */
  async startListening(): Promise<void> {
    if (this.isListening) return;
    this.stopSpeaking();
    this.cancelListening = false;
    this.framesSent = 0;
    this.heardFinal = false;
    this.finalWaiter = null;
    try {
      this.setState("connecting");
      // Mic FIRST (inside the user gesture): the permission prompt and the
      // AudioContext appear instantly, and the context isn't suspended for
      // being created in a detached async continuation after the network mint.
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, sampleRate: SCRIBE_SAMPLE_RATE_HZ },
      });
      if (this.cancelListening) {
        this.cleanup();
        return;
      }
      const Ctor = (window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctor) throw new Error("Web Audio API unavailable in this context.");
      this.audioCtx = new Ctor({ sampleRate: SCRIBE_SAMPLE_RATE_HZ });
      const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
      // ScriptProcessorNode is deprecated but still universally supported and
      // gives us a synchronous PCM frame stream without a separate worklet
      // bundle. We drop buffers immediately after push; nothing is held.
      this.processor = this.audioCtx.createScriptProcessor(MIC_CHUNK_FRAMES, 1, 1);
      this.processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        // Send whenever a socket exists — sendAudioBase64 already no-ops
        // until OPEN. Gating on `state === "listening"` dropped the first
        // ~500ms of speech while the socket was still connecting.
        if (this.scribe) {
          this.framesSent++;
          this.scribe.sendAudioBase64(micFrameToScribeBase64(input));
        }
      };
      source.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);
      if (this.cancelListening) {
        this.cleanup();
        return;
      }
      // Network mint AFTER the mic is live so a slow/failed key doesn't leave
      // the button stuck on "connecting" with no mic prompt ever shown.
      const token = await mintScribeToken(this.config.apiKey);
      if (this.cancelListening) {
        this.cleanup();
        return;
      }
      this.scribe = new ScribeConnection({
        onPartial: (text) => {
          this.callbacks.onPartial?.(text);
          this.config.setUserEntryText(text);
        },
        onFinal: (text) => {
          const trimmed = text.trim();
          this.heardFinal = true;
          this.finalWaiter?.();
          this.finalWaiter = null;
          this.callbacks.onFinal?.(trimmed);
          if (trimmed) {
            this.config.submitTask(trimmed);
            this.config.setUserEntryText("");
          }
          void this.stopListening();
        },
        onClose: (reason) => {
          // Session dropped: unblock stopListening so the button never hangs.
          this.finalWaiter?.();
          this.finalWaiter = null;
          if (!this.heardFinal && !this.cancelListening) {
            this.callbacks.onError?.(`Scribe session closed before any transcript (${reason}).`);
          }
        },
        onError: (msg) => {
          this.callbacks.onError?.(msg);
          this.finalWaiter?.();
          this.finalWaiter = null;
          this.setState("error");
        },
      });
      this.scribe.connect(token);
      this.setState("listening");
      this.callbacks.onOpen?.();
    } catch (err) {
      this.cleanup();
      const message = err instanceof Error ? err.message : String(err);
      this.callbacks.onError?.(message);
      this.setState("error");
    }
  }

  /** Stop capture and commit the in-flight utterance. */
  async stopListening(): Promise<void> {
    if (!this.scribe && !this.isListening) return;
    this.cancelListening = true;
    const scribe = this.scribe;
    // Quick taps release before the session is live; a commit on a socket that
    // has not received session_started is accepted but produces no transcript,
    // so the utterance is silently lost. Wait for the session, then commit.
    if (scribe) {
      if (scribe.isOpen) {
        const finalArrived = new Promise<void>((resolve) => {
          this.finalWaiter = resolve;
        });
        await scribe.waitForReady(3000);
        scribe.commit();
        // Wait for the server's committed transcript (bounded) instead of a
        // blind sleep — a fixed 900ms could tear the mic down mid-flight on a
        // slow link and drop the words the user just spoke.
        await Promise.race([
          finalArrived,
          new Promise<void>((r) => setTimeout(r, 3000)),
        ]);
      }
      // Silence here is the failure mode that used to look like a dead button:
      // say exactly which half (capture vs. transcript) came up empty.
      if (!this.heardFinal) {
        this.callbacks.onError?.(
          this.framesSent === 0
            ? "No microphone audio was captured - grant mic access to the side panel and try again."
            : "Scribe returned no transcript. Check that the ElevenLabs key is valid and has STT quota.",
        );
      }
    }
    this.cleanup();
  }

  private ensurePlaybackContext(): AudioContext | null {
    if (!this.playbackAudioCtx || this.playbackAudioCtx.state === "closed") {
      const Ctor = (window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctor) return null;
      this.playbackAudioCtx = new Ctor({ sampleRate: SCRIBE_SAMPLE_RATE_HZ });
      this.playbackGain = this.playbackAudioCtx.createGain();
      this.playbackGain.gain.value = 1.0;
      this.playbackGain.connect(this.playbackAudioCtx.destination);
    }
    if (this.playbackAudioCtx.state === "suspended") {
      void this.playbackAudioCtx.resume();
    }
    return this.playbackAudioCtx;
  }

  private playAudioChunk(samples: Float32Array): void {
    const ctx = this.ensurePlaybackContext();
    if (!ctx || !this.playbackGain || samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackGain);
    const now = ctx.currentTime;
    const start = Math.max(now, this.nextPlaybackTime);
    source.start(start);
    this.nextPlaybackTime = start + buffer.duration;
  }

  /** Stop any active or queued TTS speech immediately. */
  stopSpeaking(): void {
    if (this.ttsAbort) {
      this.ttsAbort.abort();
      this.ttsAbort = null;
    }
    if (this.playbackGain && this.playbackAudioCtx) {
      try {
        this.playbackGain.disconnect();
      } catch {
        // ignore
      }
      this.playbackGain = null;
    }
    if (this.playbackAudioCtx) {
      try {
        void this.playbackAudioCtx.close();
      } catch {
        // ignore
      }
      this.playbackAudioCtx = null;
    }
    this.nextPlaybackTime = 0;
  }

  /** Speak text via streaming TTS. Refuses any string containing a raw vault token. */
  async speak(text: string): Promise<void> {
    if (containsVaultToken(text)) {
      this.callbacks.onError?.(
        "Refusing to speak: raw vault token in assistant text (this is a bug, please report).",
      );
      return;
    }
    const safe = speakSafeTransform(text);
    if (!safe) return;
    if (!this.config.voiceId) {
      this.callbacks.onError?.("ElevenLabs voice id is required for TTS.");
      return;
    }
    this.stopSpeaking();
    const ctx = this.ensurePlaybackContext();
    if (ctx) {
      this.nextPlaybackTime = ctx.currentTime;
    }
    const abort = new AbortController();
    this.ttsAbort = abort;
    try {
      await streamTts(
        safe,
        this.config.voiceId,
        this.config.apiKey,
        {
          onChunk: (samples) => {
            if (!abort.signal.aborted) {
              this.playAudioChunk(samples);
              this.config.speakAssistantText?.(safe);
            }
          },
          onError: (msg) => {
            if (!abort.signal.aborted) {
              this.callbacks.onError?.(msg);
            }
          },
        },
        abort.signal,
      );
    } catch (err) {
      if (!abort.signal.aborted) {
        this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (this.ttsAbort === abort) {
        this.ttsAbort = null;
      }
    }
  }

  /** Abort everything without committing (e.g. on user cancel). */
  cancel(): void {
    this.cancelListening = true;
    this.cleanup();
    this.stopSpeaking();
    this.config.setUserEntryText("");
  }

  private setState(state: "idle" | "connecting" | "listening" | "error"): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private cleanup(): void {
    if (this.processor) {
      try {
        this.processor.disconnect();
      } catch {
        // ignore
      }
      this.processor = null;
    }
    if (this.audioCtx) {
      try {
        void this.audioCtx.close();
      } catch {
        // ignore
      }
      this.audioCtx = null;
    }
    if (this.mediaStream) {
      for (const t of this.mediaStream.getTracks()) t.stop();
      this.mediaStream = null;
    }
    if (this.scribe) {
      this.scribe.close();
      this.scribe = null;
    }
    this.finalWaiter?.();
    this.finalWaiter = null;
    this.setState("idle");
  }
}
