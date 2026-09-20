/**
 * Voice controller — wires Scribe Realtime (STT) and Flash TTS into the
 * side panel's task lifecycle with privacy-first defaults.
 *
 * Responsibilities:
 *  - Mic capture: getUserMedia -> AudioWorklet (16 kHz PCM16) -> base64 frames
 *    into the Scribe WebSocket. Audio buffers are dropped the moment a chunk
 *    is sent; nothing is persisted.
 *  - Tap-to-toggle: one tap on the mic opens capture, and the NEXT tap closes
 *    it, at which point Scribe's `commit()` is called and the final transcript
 *    is fed into submit(). Nothing here listens for press/release: the button
 *    is a toggle, and this module only exposes startListening/stopListening
 *    for the panel's click handler to call (see voice-core.micToggleAction).
 *  - TTS: subscribe to the final-answer transcript stream and play each
 *    step's text through the shared AudioContext. Spoken text is run through
 *    voice-core.toSpeakable(), which is the single decision about what may be
 *    read aloud: vault tokens are pronounced "redacted" (never refused, see
 *    that function), markdown is flattened, and the result is length-capped.
 *
 * The whole module is feature-flagged on settings.elevenlabs.sttEnabled /
 * .ttsEnabled; UI must consult the flag before constructing this.
 */

import {
  MIC_AUDIO_CONSTRAINTS,
  MIC_FALLBACK_CONSTRAINTS,
  PLAYBACK_SAMPLE_RATE_HZ,
  classifyMicFailure,
  mergeFloat32Arrays,
  micFailureAdvice,
  toSpeakable,
} from "./voice-core";
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
  /**
   * Called when a spoken utterance's stream ends, with its scheduling health.
   * Gaps mean the network delivered slower than realtime and the ear heard
   * silence between buffers — the measurable form of "good start, then
   * choppy". The panel reports it only when nonzero, so clean speech stays
   * quiet and a starving stream names itself instead of sounding like a bad
   * microphone.
   */
  onStats?: (stats: SpeechStats) => void;
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

/**
 * Minimum speech buffered before one AudioBufferSource is scheduled.
 *
 * The TTS stream flushes whatever bytes each network read delivered —
 * sometimes a few milliseconds — and every scheduled buffer is a splice
 * point: an arbitrary cut mid-waveform is a click, and dozens per second
 * read as a permanent crackle bed under the voice (the reported "background
 * noise every time"). Flooring at 0.25 s trades a quarter-second of start
 * latency for far fewer, longer buffers. Remainder flushes at stream end.
 * Derived from the playback rate (not a magic count) so a format change
 * keeps the TIME trade. Exported so the harness pins it.
 */
export const MIN_SPEECH_CHUNK_SAMPLES = Math.floor(PLAYBACK_SAMPLE_RATE_HZ / 4);

/**
 * Speech buffered before the FIRST scheduled source of an utterance.
 *
 * The TTS stream arrives as an initial burst followed by a trickle, and the
 * 0.25 s floor above starts playback off the burst — the first words sound
 * clean, then the trickle cannot sustain realtime and every later floor
 * underruns into gaps (the reported "first 2 words good, then bad mic-open
 * voice"). Holding the first schedule until 0.75 s is banked trades a beat
 * of start latency for a reservoir the trickle rarely empties; later floors
 * stay at 0.25 s so steady speech adds no further delay. Stream end still
 * flushes whatever remains. Rate-derived like the floor. Exported so the
 * harness pins the trade.
 */
export const PREBUFFER_SAMPLES = Math.floor((PLAYBACK_SAMPLE_RATE_HZ * 3) / 4);

/**
 * A playback gap in milliseconds, or 0 when scheduling is continuous.
 *
 * Pure so the underrun detector is pinned without an AudioContext: when the
 * next buffer starts later than the previous one ends, the ear heard
 * silence — the stream trickled slower than realtime. Sub-50 ms slips are
 * scheduling jitter, not starvation, and are not counted.
 */
export const AUDIO_GAP_FLOOR_MS = 50;
export function audioGapMs(expectedEndSec: number, startSec: number): number {
  if (!(expectedEndSec > 0)) return 0;
  const gapMs = (startSec - expectedEndSec) * 1000;
  return gapMs > AUDIO_GAP_FLOOR_MS ? Math.round(gapMs) : 0;
}

/** Stream-health summary for one spoken utterance (see onStats). */
export interface SpeechStats {
  gaps: number;
  gapMsTotal: number;
  gapMsMax: number;
  chunks: number;
}

export class VoiceController {
  private scribe: ScribeConnection | null = null;
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private playbackAudioCtx: AudioContext | null = null;
  private playbackGain: GainNode | null = null;
  private nextPlaybackTime = 0;
  /** Unscheduled speech bytes, in arrival order — see MIN_SPEECH_CHUNK_SAMPLES. */
  private speechQueue: Float32Array[] = [];
  private queuedSpeechSamples = 0;
  /** True once this utterance has started scheduling (prebuffer spent). */
  private playbackStarted = false;
  /** Scheduling health for the current utterance (see onStats). */
  private speechGaps = 0;
  private speechGapMsTotal = 0;
  private speechGapMsMax = 0;
  private speechChunks = 0;
  private ttsAbort: AbortController | null = null;
  private cancelListening = false;
  private state: "idle" | "connecting" | "listening" | "error" = "idle";
  /** Frames actually handed to the socket (0 means the mic produced nothing). */
  private framesSent = 0;
  /** Resolved the moment a committed transcript arrives (or the session dies). */
  private finalWaiter: (() => void) | null = null;
  private heardFinal = false;
  /**
   * True when the server committed a transcript that contained no words.
   *
   * Distinct from `heardFinal` on purpose. `heardFinal` means "the server
   * answered", which is what unblocks the commit wait; it is also what the
   * end-of-recording diagnostic used to be keyed on, so the common empty
   * utterance — tap, say nothing (or a muted input device), tap to send — set
   * `heardFinal = true`, skipped the "no transcript" branch, and produced no
   * feedback whatsoever. From the outside that is a dead button: the recording
   * badge had appeared, so the user believed words were captured.
   */
  private finalWasEmpty = false;
  private readonly config: VoiceControllerConfig;
  private callbacks: VoiceControllerCallbacks;

  constructor(config: VoiceControllerConfig) {
    this.config = config;
    this.callbacks = config.callbacks ?? {};
  }

  get isListening(): boolean {
    return this.state === "listening" || this.state === "connecting";
  }

  /**
   * Begin dictation capture: opens mic, connects Scribe, streams audio.
   *
   * Idempotent by design — this is what makes the button a toggle rather than
   * a press/release pair. A second call while a recording is open is a no-op,
   * so a double-tap cannot open two mic streams or lose the first utterance.
   */
  async startListening(): Promise<void> {
    if (this.isListening) return;
    this.stopSpeaking();
    this.cancelListening = false;
    this.framesSent = 0;
    this.heardFinal = false;
    this.finalWasEmpty = false;
    this.finalWaiter = null;
    try {
      this.setState("connecting");
      // Mic FIRST (inside the user gesture): the permission prompt and the
      // AudioContext appear instantly, and the context isn't suspended for
      // being created in a detached async continuation after the network mint.
      this.mediaStream = await this.openMicrophone();
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
      // Keep-alive WITHOUT monitoring: a ScriptProcessor only fires
      // onaudioprocess while connected through to the destination, so it
      // must join the output graph — but the mic must never be audible.
      // The spec zero-fills unwritten output, yet routing live input
      // straight at the speakers relies on every Chromium variant doing so,
      // and the failure mode is exactly the reported one ("someone's mic is
      // on" under everything). A zero-gain node keeps the graph alive with
      // structural silence instead of a spec promise.
      const silentKeepAlive = this.audioCtx.createGain();
      silentKeepAlive.gain.value = 0;
      this.processor.connect(silentKeepAlive);
      silentKeepAlive.connect(this.audioCtx.destination);
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
          // A committed-but-wordless transcript is a real answer, so record it:
          // stopListening() reads this to tell "heard nothing" apart from "the
          // session never answered" (see the class comment on finalWasEmpty).
          this.finalWasEmpty = trimmed.length === 0;
          this.finalWaiter?.();
          this.finalWaiter = null;
          this.callbacks.onFinal?.(trimmed);
          if (trimmed) {
            this.config.submitTask(trimmed);
            this.config.setUserEntryText("");
          }
          this.finishUtterance();
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

  /**
   * Open the microphone, or explain in one sentence why it did not open.
   *
   * The panel used to surface Chrome's raw error, and Chrome reports four
   * completely different problems with the same few words — "Requested device
   * not found" is the message for a missing `audioCapture` permission (an
   * extension page sees no devices at all without it), for a machine with no
   * input device, and for a device another app has taken. There is no next move
   * a user can infer from that string, so the failure is classified here from
   * two facts that are checkable at runtime: whether THIS build declares the
   * permission, and whether any `audioinput` is visible.
   */
  private async openMicrophone(): Promise<MediaStream> {
    const tuned: MediaStreamConstraints = {
      audio: { ...MIC_AUDIO_CONSTRAINTS, sampleRate: SCRIBE_SAMPLE_RATE_HZ },
    };
    try {
      return await navigator.mediaDevices.getUserMedia(tuned);
    } catch (err) {
      const first = err as { name?: string; message?: string };
      // A device that dislikes the tuned set should still dictate. Plain
      // constraint values are "ideal" rather than required, so this is rare —
      // but a rare total failure of a feature the user has to click blind is
      // worth one cheap retry.
      if (first?.name === "OverconstrainedError" || first?.name === "TypeError") {
        try {
          return await navigator.mediaDevices.getUserMedia(MIC_FALLBACK_CONSTRAINTS);
        } catch {
          // Fall through to the diagnostic using the ORIGINAL error.
        }
      }

      const hasCapturePermission = (() => {
        try {
          const perms: string[] = (chrome.runtime.getManifest() as { permissions?: string[] }).permissions ?? [];
          return perms.includes("audioCapture");
        } catch {
          // No extension context (a test harness, a plain page): do not claim
          // the permission is missing when we cannot check it.
          return true;
        }
      })();

      let audioInputs: number | null = null;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        audioInputs = devices.filter((d) => d.kind === "audioinput").length;
      } catch {
        audioInputs = null;
      }

      const kind = classifyMicFailure({
        name: first?.name,
        message: first?.message,
        hasCapturePermission,
        audioInputs,
      });
      throw new Error(micFailureAdvice(kind, first?.message));
    }
  }

  /**
   * Close the session once the server has delivered a final transcript.
   *
   * Deliberately NOT `stopListening()`. That method's whole job is to COMMIT the
   * in-flight utterance, and its only caller on this path is the commit it just
   * sent — so calling it from `onFinal` re-entered itself and pushed a SECOND
   * commit frame on a session that had already committed. A redundant commit is
   * answered with a throttle/duplicate event, which the error branch below would
   * surface as a failure line after an otherwise clean dictation, and it made
   * "how many commits did one tap-to-send produce?" depend on microtask
   * ordering between the re-entrant call and the first one's cleanup.
   * Tearing down instead is both cheaper and deterministic: no commit, mic
   * released, state back to idle so the next tap starts a new recording.
   */
  private finishUtterance(): void {
    // Set first: the socket is about to close, and a close that was the
    // pipeline's own doing must not be reported as a dropped session.
    this.cancelListening = true;
    this.cleanup();
  }

  /**
   * Stop capture and commit the in-flight utterance — the "send" half of the
   * toggle. Safe to call when nothing is open (it returns immediately).
   */
  async stopListening(): Promise<void> {
    if (!this.scribe && !this.isListening) return;
    this.cancelListening = true;
    const scribe = this.scribe;
    // A tap-to-send can land before the session is live (the user taps twice in
    // quick succession); a commit on a socket that has not received
    // session_started is accepted but produces no transcript, so the utterance
    // is silently lost. Wait for the session, then commit.
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
      // say exactly which third (capture, words, or the server itself) came up
      // empty. Three cases, because the fix for each is different and the old
      // two-way check merged the middle one into the first.
      if (!this.heardFinal) {
        this.callbacks.onError?.(
          this.framesSent === 0
            ? "No microphone audio was captured - grant mic access to the side panel and try again."
            : "Scribe returned no transcript. Check that the ElevenLabs key is valid and has STT quota.",
        );
      } else if (this.finalWasEmpty) {
        // The server answered, it just heard no words. Saying "check your
        // ElevenLabs quota" here sent the user to their billing page over a
        // muted microphone, so say what to check instead.
        this.callbacks.onError?.(
          "Scribe heard no words in that recording, so nothing was sent. Check that the input " +
            "device is not muted, then tap the mic and speak.",
        );
      }
    }
    this.cleanup();
  }

  private ensurePlaybackContext(): AudioContext | null {
    if (!this.playbackAudioCtx || this.playbackAudioCtx.state === "closed") {
      const Ctor = (window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
      if (!Ctor) return null;
      // Playback runs at the WIRE rate (24 kHz), not the mic rate (16 kHz):
      // scheduling 24 kHz samples on a 16 kHz clock plays everything slow
      // and low. The mic context elsewhere in this file stays 16 kHz for Scribe.
      this.playbackAudioCtx = new Ctor({ sampleRate: PLAYBACK_SAMPLE_RATE_HZ });
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
    // Gaps measure only BETWEEN scheduled buffers: the first schedule has no
    // predecessor, and startup latency (network time before any audio) is not
    // starvation. speechChunks>0 exactly marks "a buffer ends at expected".
    const expected = this.speechChunks > 0 ? this.nextPlaybackTime : 0;
    const start = Math.max(now, this.nextPlaybackTime);
    const gap = audioGapMs(expected, start);
    if (gap > 0) {
      this.speechGaps++;
      this.speechGapMsTotal += gap;
      this.speechGapMsMax = Math.max(this.speechGapMsMax, gap);
    }
    source.start(start);
    this.nextPlaybackTime = start + buffer.duration;
    this.speechChunks++;
  }

  /**
   * Queue streamed speech, scheduling only whole floors of it. Short reads
   * accumulate instead of each becoming a click-prone sliver of a buffer;
   * `force` (stream end) flushes whatever remains, even a stub. The first
   * schedule of an utterance waits for the deeper prebuffer (see
   * PREBUFFER_SAMPLES); everything after it uses the speaking floor.
   */
  private queueSpeechChunk(samples: Float32Array, force = false): void {
    if (samples.length > 0) {
      this.speechQueue.push(samples);
      this.queuedSpeechSamples += samples.length;
    }
    const floor = this.playbackStarted ? MIN_SPEECH_CHUNK_SAMPLES : PREBUFFER_SAMPLES;
    if (!force && this.queuedSpeechSamples < floor) return;
    if (this.queuedSpeechSamples === 0) return;
    const merged = mergeFloat32Arrays(this.speechQueue);
    this.speechQueue = [];
    this.queuedSpeechSamples = 0;
    this.playAudioChunk(merged);
    this.playbackStarted = true;
  }

  /** Stop any active or queued TTS speech immediately. */
  stopSpeaking(): void {
    if (this.ttsAbort) {
      this.ttsAbort.abort();
      this.ttsAbort = null;
    }
    // Drop unscheduled audio too: a queued floor must never outlive the
    // utterance it belonged to, or stopping one answer leaks into the next.
    this.speechQueue = [];
    this.queuedSpeechSamples = 0;
    this.playbackStarted = false;
    this.speechGaps = 0;
    this.speechGapMsTotal = 0;
    this.speechGapMsMax = 0;
    this.speechChunks = 0;
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

  /**
   * Speak text via streaming TTS.
   *
   * Tokens are REDACTED for the speaker, never a reason to refuse: every token
   * in the text is pronounced as "redacted" by `toSpeakable`, which is the whole
   * point of that transform. The old guard here ran before the transform and
   * returned early whenever a token was present, so any answer that quoted one
   * back — the Gmail tab title alone carries `<CRED_1>` — produced the error
   * line "Refusing to speak: raw vault token in assistant text (this is a bug,
   * please report)" and no audio. The token count is surfaced instead, so a
   * silent substitution is never mistaken for the model's own wording.
   */
  async speak(text: string): Promise<void> {
    const { text: safe, redactedTokens } = toSpeakable(text);
    if (!safe) return;
    if (redactedTokens > 0) {
      this.callbacks.onError?.(
        `Voice: spoke ${redactedTokens} vault token(s) as "redacted" — no secret was read aloud.`,
      );
    }
    if (!this.config.voiceId) {
      this.callbacks.onError?.("ElevenLabs voice id is required for TTS.");
      return;
    }
    this.stopSpeaking();
    const ctx = this.ensurePlaybackContext();
    if (ctx) {
      this.nextPlaybackTime = ctx.currentTime;
    }    const abort = new AbortController();
    this.ttsAbort = abort;
    try {
      await streamTts(
        safe,
        this.config.voiceId,
        this.config.apiKey,
        {
          onChunk: (samples) => {
            if (!abort.signal.aborted) {
              this.queueSpeechChunk(samples);
              this.config.speakAssistantText?.(safe);
            }
          },
          onDone: () => {
            if (!abort.signal.aborted) {
              this.queueSpeechChunk(new Float32Array(0), true);
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
    // Stream-health report: what scheduling observed, up to stream end
    // (already-scheduled buffers may still be playing — the stats describe
    // delivery, which is where starvation lives). Skipped for aborted
    // utterances: a cancelled stream's gaps are the cancellation, not news.
    if (!abort.signal.aborted) {
      this.callbacks.onStats?.({
        gaps: this.speechGaps,
        gapMsTotal: this.speechGapMsTotal,
        gapMsMax: this.speechGapMsMax,
        chunks: this.speechChunks,
      });
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
