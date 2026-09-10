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
  /** Streamed chat answer line spoken via TTS (sanitize already applied). */
  speakAssistantText: (text: string) => void;
  callbacks?: VoiceControllerCallbacks;
}

const MIC_CHUNK_FRAMES = 1600; // 100 ms at 16 kHz — keeps latency bounded.

export class VoiceController {
  private scribe: ScribeConnection | null = null;
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private state: "idle" | "connecting" | "listening" | "error" = "idle";
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
    try {
      this.setState("connecting");
      const token = await mintScribeToken(this.config.apiKey);
      this.scribe = new ScribeConnection({
        onPartial: (text) => {
          this.callbacks.onPartial?.(text);
          this.config.setUserEntryText(text);
        },
        onFinal: (text) => {
          const trimmed = text.trim();
          this.callbacks.onFinal?.(trimmed);
          this.config.submitTask(trimmed);
          this.config.setUserEntryText("");
          void this.stopListening();
        },
        onError: (msg) => {
          this.callbacks.onError?.(msg);
          this.setState("error");
        },
      });
      this.scribe.connect(token);
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, sampleRate: SCRIBE_SAMPLE_RATE_HZ },
      });
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
        if (this.scribe && this.state === "listening") {
          this.scribe.sendAudioBase64(micFrameToScribeBase64(input));
        }
      };
      source.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);
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
    if (this.scribe) this.scribe.commit();
    // Give Scribe a beat to deliver the COMMITTED_TRANSCRIPT before we tear
    // down the mic; commit() returns immediately on the wire.
    await new Promise((r) => setTimeout(r, 350));
    this.cleanup();
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
    try {
      await streamTts(safe, this.config.voiceId, this.config.apiKey, {
        onChunk: (samples) => this.config.speakAssistantText(""),
        onError: (msg) => this.callbacks.onError?.(msg),
      });
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  /** Abort everything without committing (e.g. on user cancel). */
  cancel(): void {
    this.cleanup();
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
    this.setState("idle");
  }
}
