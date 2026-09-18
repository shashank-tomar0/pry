import type { ProviderId } from "../background/providers/types";
import type { AuditVerificationRollup, RedactionTally } from "./metrics";

/**
 * Wire types shared by the side panel, the service worker, and the content
 * script. The three run in separate JS realms and only ever exchange these.
 */

/** One interactive or informative node the agent is allowed to reference. */
export interface PageElement {
  /** Stable-within-a-snapshot handle. The model only ever sees this. */
  id: number;
  /** ARIA role, or a normalised fallback derived from the tag name. */
  role: string;
  /** Accessible name: aria-label, associated <label>, placeholder, or text. */
  name: string;
  /** Current value for form controls, truncated. */
  value?: string;
  /** Extra hints the planner needs: checked, disabled, expanded, href host. */
  attrs?: Record<string, string>;
}

/** What the agent knows about the page at one point in time. */
export interface PageSnapshot {
  /**
   * Which page read produced these element ids, as a per-document counter.
   *
   * Ids are positional indices into the page's element registry, so the same
   * number means a DIFFERENT control after any re-render — and on a fresh
   * document it is a different registry entirely. The generation is what lets
   * an action say which read its id came from, so the page can refuse an id
   * from an older read instead of silently acting on whatever now sits at that
   * index. Absent on snapshots from before this field existed; callers treat
   * that as "unverifiable" rather than as a match.
   */
  generation?: number;
  url: string;
  title: string;
  /** Interactive elements plus enough text nodes to give the page meaning. */
  elements: PageElement[];
  /** Visible text of the main content region, truncated. */
  text: string;
  /** True when the snapshot was cut off by the element budget. */
  truncated: boolean;
  /** Scroll position as a 0-1 fraction, so the model can tell it can scroll. */
  scroll: { y: number; maxY: number };
}

export type ActionName =
  | "click"
  /** Click by visible text — the handle that exists when no element id does. */
  | "click_text"
  | "type"
  /** Type by the field's visible name — the same handle, for text entry. */
  | "type_text"
  | "select"
  | "scroll"
  | "navigate"
  | "go_back"
  | "key"
  | "wait"
  | "read_page"
  | "find_text"
  | "open_tab"
  | "switch_tab"
  | "close_tab"
  | "list_tabs";

/** A single action the planner asked for, already schema-validated. */
export interface AgentAction {
  name: ActionName;
  input: Record<string, unknown>;
  /**
   * The page read whose element ids this action refers to.
   *
   * Set by the agent loop from the snapshot it rendered for the planner — never
   * by the model, which only ever sees a number. The page compares it against
   * its own current read and refuses a mismatch: a positional id from an older
   * read may point at a different control by the time the action lands.
   */
  snapshotGeneration?: number;
}

/** Result of executing one action, fed back to the planner as a tool result. */
export interface ActionResult {
  ok: boolean;
  /** Human- and model-readable description of what happened. */
  detail: string;
  /** Populated when the action changed the page enough to warrant a re-read. */
  snapshot?: PageSnapshot;
  /** Populated when screenshot capture was requested. */
  screenshot?: ProcessedScreenshotResult;
  /**
   * Values a locator saw rendered but could not box, because their client rects
   * lie outside the area a viewport capture covers (see `locateSpans`). The
   * service worker needs this to keep "not in this image" apart from "detected
   * and unplaceable": only the second one is a leak, and only the second one
   * withholds the frame (see `unplacedAfterLocators`).
   */
  offCapture?: string[];
  /**
   * True only when the locator walked the whole document inside its node and
   * time budget. A truncated walk proves nothing about what it did not reach,
   * so an absent value then stays unplaceable.
   */
  locatorScanComplete?: boolean;
}

/** Result of pixel-level re-OCR verification after screenshot redaction. */
export interface VerificationResult {
  /** Whether every sensitive region was confirmed redacted. */
  verified: boolean;
  /** Number of regions that were checked against the redacted pixels. */
  regionsChecked: number;
  /** Number of regions confirmed altered/masked in the redacted image. */
  regionsRedacted: number;
  /** Human-readable reasons for any region that failed the check. */
  leakedPatterns: string[];
  /** 0-1 confidence from the region checks. */
  confidence: number;
  /** One-line human summary, e.g. "VERIFIED: 4/4 regions confirmed redacted". */
  summary: string;
  timestamp: number;
  /** True when a real OCR pass ran over the shipped image. */
  ocrRan?: boolean;
  /** Raw OCR text when it surfaced a leak (truncated, evidence for the audit). */
  leakedText?: string;
  /**
   * True when the adversarial auditor found readable content in a soft
   * (blur-tier) region and rebuilt the image with those regions destroyed,
   * then re-verified. The shipped bytes are the escalated ones.
   */
  escalated?: boolean;
  /**
   * Why the frame was rebuilt — the findings that triggered escalation.
   *
   * Kept SEPARATE from `leakedPatterns` because the two answer different
   * questions, and conflating them broke the egress guard: `leakedPatterns`
   * means "still present in the bytes that ship", so a remediated finding must
   * leave it or `residualDetections` stays above zero and the frame is withheld
   * forever. Without this field the reason for the rebuild was then lost
   * entirely — an escalated frame reported a clean pass with no trace of what
   * the first paint got wrong.
   */
  escalationReasons?: string[];
  /**
   * What the ADVERSARIAL pass probed on the shipped pixels — the audit's answer
   * to "can this redaction be undone?" rather than "did it happen?".
   *
   * `leakedPatterns` already carries the human-readable findings; this exists so
   * the panel can separate "the pixel check passed" from "an attack on those
   * pixels failed", which is the distinction the whole feature rests on.
   */
  attack?: {
    /** True when the reconstruction probe completed (whether or not it hit). */
    ran: boolean;
    /** Soft regions a sharpening probe could still read energy out of. */
    reconstructableRegions: number;
    /** Faces the detector still finds in the shipped frame, unredacted. */
    uncoveredFaces: number;
    /** Full reason lines, one per finding. */
    details: string[];
  };
}

/** Completed scanning evidence; never a guarantee of detector recall. */
export interface ScreenshotProtection {
  facesComplete: boolean;
  textComplete: boolean;
  mappingValid: boolean;
  finalScanComplete: boolean;
  residualDetections: number;
  policyEnabled: boolean;
  reasons: string[];
}

/** Screenshot processing result from the privacy pipeline. */
export interface ProcessedScreenshotResult {
  protection?: ScreenshotProtection;
  redactedDataUrl: string;
  detections: Array<{
    kind: string;
    box?: { x: number; y: number; width: number; height: number };
    confidence: number;
    label: string;
    /**
     * Tier actually painted for this region: `opaque` | `blur` | `surrogate` |
     * `skip`. Optional so a record written before the field existed still
     * parses — but a pipeline-produced detection always carries it, and the UI
     * says `unknown` rather than guessing a tier it was not told.
     */
    tier?: string;
  }>;
  redactedCount: number;
  processingTimeMs: number;
  /** Re-OCR proof that redaction actually worked on the shipped pixels. */
  verification?: VerificationResult;
  /**
   * What the frame-text channel found when it was handed the values the DOM
   * channel could not place (`dom-targets-unresolved`).
   *
   * This is the evidence that decides whether an unplaceable value is a leak or
   * merely an unplaceable value. "Could not locate it in the DOM" and "it is not
   * legible in the frame" are different findings, and only the second one means
   * the frame is safe — which is why the pixel channel is asked directly rather
   * than the first being treated as the second.
   */
  unlocatedText?: {
    /** How many values the DOM channel asked to have cleared. */
    requested: number;
    /** True when the frame's pixels were actually read (no OCR, no proof). */
    searched: boolean;
    /**
     * Values the OCR read in the frame, wherever they were. Clearance requires
     * this to equal `requested`: an unfound value is NOT proven absent, because
     * OCR misreads and low-confidence lines are real limits of this channel.
     */
    legible: number;
    /** Values it read but which were left unpainted — none may be left. */
    stillLegible: number;
    /** Masked samples of anything still legible, for the warning line. */
    samples?: string[];
  };
}

/** Messages the content script accepts. */
export type ContentRequest =
  | { kind: "snapshot" }
  | { kind: "act"; action: AgentAction }
  | { kind: "ping" }
  | { kind: "capture-screenshot" }
  | { kind: "capture-and-act"; action: AgentAction }
  | { kind: "get-sensitive-regions" }
  | { kind: "locate-spans"; spans: string[] }
  /** Detector→pixel bridge: box PII found inside an element (aria-label,
   *  title, value) where no text node exists to measure. Each target carries
   *  the value it holds so the box can be attributed back to it. */
  | { kind: "locate-elements"; targets: Array<{ selector: string; value?: string }> }
  | { kind: "fullpage-begin" }
  | { kind: "fullpage-scroll"; y: number; hideSticky: boolean }
  | { kind: "fullpage-restore" };

/** A rendered entry in the side panel transcript. */
export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "step" | "error" | "system" | "egress" | "thought";
  text: string;
  /** Set on "step" entries so the UI can show an icon per action type. */
  action?: ActionName;
  /** Set while a step is still running. */
  pending?: boolean;
}

/** One MAIN-world tripwire alert forwarded to the panel's radar drawer. */
export interface TripwireAlertDetail {
  url: string;
  method: string;
  piiType: string;
  sample: string;
  /**
   * Whether the destination is a different site from the page that sent it.
   * `false` is the page talking to its own backend (Gmail autosaving a draft);
   * `true` is PII leaving for somebody else. Absent means the producer could
   * not tell, which the radar counts conservatively as third-party.
   */
  thirdParty?: boolean;
  timestamp: number;
}

/**
 * The privacy-audit payload — what the panel renders as proof of one run.
 *
 * Named rather than inlined in the event union because it travels two ways: the
 * service worker broadcasts it during a run (`privacy-audit`) and re-serves it
 * on request (`get-audit`), and both the panel and the test harness assert on
 * the same shape.
 */
export interface PrivacyAuditPayload {
  screenshots: Array<{
    original?: string;
    redacted?: string;
    timestamp: number;
    /** This frame's own detections — overlay proof, never another frame's. */
    detections?: Array<{
      kind: string;
      label: string;
      confidence: number;
      box?: { x: number; y: number; width: number; height: number };
      /** Tier the painter recorded for this region (`opaque` | `blur` | ...). */
      tier?: string;
    }>;
  }>;
  allDetections: Array<{
    kind: string;
    label: string;
    confidence: number;
    box?: { x: number; y: number; width: number; height: number };
    tier?: string;
  }>;
  allTokens: Array<{ token: string; kind: string; sample?: string }>;
  totalRedacted: number;
  totalScreenshots: number;
  totalPIIDetections: number;
  durationMs: number;
  /**
   * True only when a redacted frame actually left the browser (VLM vision
   * enabled with a key). With vision off — the default — every screenshot is
   * captured and redacted locally for the audit, and nothing is sent, so the
   * panel must not label the frame "what shipped to the model".
   */
  shipped?: boolean;
  /**
   * The MOST RECENT frame's re-OCR verification — per-frame evidence, and the
   * detail the audit panel draws its proof card from. It is deliberately not a
   * run-level verdict: the badge reads `verificationRollup`, which counts every
   * frame, because one passing frame used to license a run-wide
   * "✓ REDACTIONS VERIFIED" even when another frame's check had failed.
   */
  verification?: VerificationResult;
  /** Every frame's verification, rolled up into the claim the badge may make. */
  verificationRollup?: AuditVerificationRollup;
  /**
   * The run's redaction counts, each part named by the channel that produced
   * it, so the panel's numbers reconcile instead of merely coinciding.
   */
  tally?: RedactionTally;
}

/** Privacy audit snapshot — captured after each task for the judges. */
export interface PrivacyAuditSnapshot {
  /** Redacted screenshot as data URL (faces destroyed, credentials masked). */
  redactedScreenshot?: string;
  /** PII detections found during this snapshot. */
  detections: Array<{
    kind: string;
    label: string;
    confidence: number;
    box?: { x: number; y: number; width: number; height: number };
    tier?: string;
  }>;
  /** Token replacements made (e.g., <CRED_1> replaced "password123"). */
  tokens: Array<{ token: string; kind: string; sample?: string }>;
  /** Total PII items redacted in this snapshot. */
  redactedCount: number;
  /** Timestamp. */
  timestamp: number;
}

/** Service worker -> side panel events. */
export type AgentEvent =
  | { kind: "entry"; entry: TranscriptEntry }
  | {
      kind: "patch";
      id: string;
      text?: string;
      pending?: boolean;
      /**
       * Replace the entry's text instead of appending it.
       *
       * Assistant text normally arrives as streaming DELTAS, so a patch appends.
       * The one case that needs the opposite is a stream that has just been
       * declared not-language: by the time the guard sees it, the card already
       * painted it as PRY's answer with a Copy button, and leaving it there would
       * present the glitch as a result the run stood behind.
       */
      replace?: boolean;
    }
  | { kind: "status"; running: boolean }
  | {
      kind: "egress";
      /** Total bytes sent to remote planners this task (0 for local-only). */
      bytes: number;
    }
  | { kind: "confirm";
      id: string;
      summary: string;
    }
  | { kind: "privacy-audit"; audit: PrivacyAuditPayload }
  | { kind: "experience"; experience: Record<string, unknown> }
  | { kind: "tripwire-update"; alert: TripwireAlertDetail }
  | {
      kind: "learning-update";
      stats: {
        totalRuns: number;
        successRate: number;
        piiDetected: number;
        piiRedacted: number;
        falsePositives: number;
        missedPII: number;
        sitesVisited: number;
        rulesLearned: number;
        improvementDelta: number;
        /** User-flagged corrections across all runs (ground truth for precision). */
        corrections: number;
        rulesSummary: {
          total: number;
          byCategory: Record<string, number>;
          highConfidence: number;
          recentlyCreated: number;
          recent?: Array<{
            id: string;
            category: string;
            description: string;
            confidence: number;
            confirmedCount: number;
            createdAt: number;
          }>;
        };
        lastReflection: string;
      };
    };

/** Side panel -> service worker commands. */
export type PanelCommand =
  | { kind: "run"; task: string; tabId: number }
  | { kind: "stop" }
  | { kind: "reset" }
  | { kind: "confirm-reply"; id: string; approved: boolean }
  | { kind: "get-state" }
  | { kind: "get-history" }
  | { kind: "delete-history"; sessionId?: string; clearAll?: boolean }
  | { kind: "get-learning-stats" }
  | { kind: "clear-learning" }
  | { kind: "get-ledger" }
  | { kind: "get-tripwire-log" }
  | { kind: "get-wire-log" }
  | { kind: "clear-wire-log" }
  | {
      kind: "record-correction";
      /** Omit to correct the most recent run. */
      experienceId?: string;
      /** PII kind being corrected (e.g. "credential", "id_number", "face"). */
      piiKind: string;
      /** Human label shown on the chip. */
      label: string;
      /** The user says this detection was wrong. */
      correction: "false_positive";
    }
  | {
      kind: "record-outcome";
      /** The run's experience id (`exp-<start time>`). */
      experienceId: string;
      /** True = the run satisfied the user; false = it did not. */
      helpful: boolean;
    }
  | { kind: "capture-fullpage"; tabId: number }
  | { kind: "inspect-tab"; tabId: number; fullPage?: boolean }
  /** Re-serve the current run's privacy audit (see buildPrivacyAudit). */
  | { kind: "get-audit" }
  | { kind: "export-ledger" };

export interface Settings {
  provider: ProviderId;
  /** Keys are kept per provider so switching does not lose the others. */
  apiKeys: Record<ProviderId, string>;
  /** Chosen model per provider, likewise remembered independently. */
  models: Record<ProviderId, string>;
  /** Hard ceiling on planner turns, so a confused agent cannot spin forever. */
  maxSteps: number;
  /** Ask before click/type on anything that looks irreversible. */
  confirmRisky: boolean;
  /** Full-page scroll stitching capture for whole-document privacy inspection. */
  fullPageCapture?: boolean;
  /**
   * Optional VLM vision: after each page change, the REDACTED screenshot is
   * sent to a vision-capable model (same provider key as the planner) and its
   * description is appended to the tool result. Only redacted pixels leave
   * the browser; vision request bytes count toward the honest egress badge.
   */
  vision: VisionSettings;
  /** Privacy pipeline configuration. */
  privacy: PrivacySettings;
  /** ElevenLabs voice (hack branch, off by default). */
  elevenlabs: ElevenLabsSettings;
  /**
   * On-device ML (Tier 0). Both flags default ON because the runtime
   * degrades automatically: when a model file is missing the feature falls
   * back to the non-ML path (regex/checksum detection, regex injection
   * guard, skin-color faces). Fetch models with scripts/fetch-models.mjs.
   */
  ml: MlSettings;
}

export interface MlSettings {
  /** NER detection (GLiNER-style token classification) fused into the detector. */
  ner: boolean;
  /** Prompt-injection classifier scanning page text before the planner. */
  guard: boolean;
}

export interface VisionSettings {
  /** Whether visual observation is active after page-changing actions. */
  enabled: boolean;
  /**
   * Vision model id for the active provider. Empty means "use the provider's
   * default vision model" (see VISION_DEFAULT_MODELS in background/vision.ts).
   */
  model: string;
}

/**
 * ElevenLabs voice settings (hack branch). Off by default; the key is stored
 * client-side exactly like every other provider key in this extension.
 * STT = Scribe Realtime (voice task input); TTS = Flash (spoken narration).
 */
export interface ElevenLabsSettings {
  /** API key (required for both STT and TTS). */
  apiKey: string;
  /** Voice id for spoken output (ElevenLabs voice id). */
  voiceId: string;
  /** Tap-to-toggle voice task input via Scribe Realtime (tap to start, tap again to send). */
  sttEnabled: boolean;
  /** Spoken narration + final answers via streaming TTS. */
  ttsEnabled: boolean;
}

export interface PrivacySettings {
  /**
   * Detect faces in screenshots and DESTROY them (opaque fill).
   *
   * Not a blur: Gaussian-blurred faces are recoverable by super-resolution
   * deanonymization (arXiv 2506.12344 concludes blur should not be used for
   * face anonymization), and a reversible redaction of a biometric identifier
   * is not a redaction. The legacy key was `blurFaces`; see normaliseSettings
   * for the migration.
   */
  destroyFaces: boolean;
  /** Enable credential field masking. */
  maskCredentials: boolean;
  /** Enable PII tokenization for DOM values. */
  tokenizePII: boolean;
  /** Show redaction labels on screenshots (demo mode). */
  showRedactionLabels: boolean;
  /**
   * Read the finished frame back with on-device OCR and black-box any PII the
   * DOM channels could not see — text baked into an image, a canvas, a video
   * frame or a PDF viewer's output. Every other pixel channel starts from the
   * DOM, so without this those pixels are unredactable by construction.
   *
   * Costs one OCR pass per capture; unrelated to the re-OCR verification of
   * redacted regions, which always runs.
   */
  scanFrameText: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "ollama",
  apiKeys: { anthropic: "", openai: "", openrouter: "", ollama: "", groq: "", nvidia: "" },
  models: {
    anthropic: "claude-opus-5",
    openai: "gpt-5",
    openrouter: "anthropic/claude-opus-5",
    ollama: "qwen2.5:1.5b",
    groq: "openai/gpt-oss-20b",
    nvidia: "nvidia/nemotron-3.5-lightning-30b-a3b",
  },
  maxSteps: 40,
  confirmRisky: true,
  fullPageCapture: false,
  vision: {
    enabled: false,
    model: "",
  },
  privacy: {
    destroyFaces: true,
    maskCredentials: true,
    tokenizePII: true,
    showRedactionLabels: false,
    scanFrameText: false,
  },
  elevenlabs: {
    apiKey: "",
    voiceId: "",
    sttEnabled: false,
    ttsEnabled: false,
  },
  ml: {
    ner: true,
    guard: true,
  },
};

/** The shape stored before multi-provider support landed. */
interface LegacySettings {
  apiKey?: string;
  model?: string;
}

/**
 * Reads settings out of storage, upgrading anything written by an older
 * version so an existing install keeps its key instead of silently losing it.
 */
export function normaliseSettings(stored: unknown): Settings {
  const source = (stored ?? {}) as Partial<Settings> & LegacySettings;

  // The pre-vision builds shipped a dead "PRY server" toggle. Read its
  // intent off the raw input, then strip the key so it never leaks into the
  // settings object (old stored settings may still carry it).
  const legacyServerEnabled =
    (source as unknown as { server?: { enabled?: boolean } }).server?.enabled === true;
  const raw = { ...source };
  delete (raw as unknown as { server?: unknown }).server;

  // Face redaction used to be a Gaussian blur under `privacy.blurFaces`. Blur
  // is recoverable, so the setting is now `privacy.destroyFaces` (opaque).
  // Preserve the user's intent across the rename — someone who had turned
  // face redaction OFF should not silently get it switched ON — then strip the
  // dead key so it never lands in the settings object.
  const legacyBlurFaces = (source.privacy as { blurFaces?: boolean } | undefined)?.blurFaces;
  if (raw.privacy) {
    delete (raw.privacy as { blurFaces?: boolean }).blurFaces;
  }

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    fullPageCapture: raw.fullPageCapture ?? DEFAULT_SETTINGS.fullPageCapture,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(raw.apiKeys ?? {}) },
    models: { ...DEFAULT_SETTINGS.models, ...(raw.models ?? {}) },
    vision: {
      ...DEFAULT_SETTINGS.vision,
      ...(raw.vision ?? {}),
      enabled: raw.vision?.enabled ?? legacyServerEnabled,
    },
    privacy: {
      ...DEFAULT_SETTINGS.privacy,
      ...(raw.privacy ?? {}),
      destroyFaces:
        raw.privacy?.destroyFaces ?? (legacyBlurFaces === false ? false : DEFAULT_SETTINGS.privacy.destroyFaces),
    },
    elevenlabs: { ...DEFAULT_SETTINGS.elevenlabs, ...(raw.elevenlabs ?? {}) },
    ml: { ...DEFAULT_SETTINGS.ml, ...(raw.ml ?? {}) },
  };

  // Pre-multi-provider installs stored a bare Anthropic key and model.
  if (raw.apiKey && !settings.apiKeys.anthropic) settings.apiKeys.anthropic = raw.apiKey;
  if (raw.model && !raw.models) settings.models.anthropic = raw.model;

  // A stored ElevenLabs key with both voice toggles off is the legacy state:
  // the user added a key (clear intent to use voice) but the build that saved
  // it never turned STT/TTS on, so the mic button could never appear. Options
  // now auto-enables both when a key is present — mirror that here so an
  // existing install does not stay permanently voiceless.
  if (settings.elevenlabs.apiKey && !settings.elevenlabs.sttEnabled && !settings.elevenlabs.ttsEnabled) {
    settings.elevenlabs.sttEnabled = true;
    settings.elevenlabs.ttsEnabled = true;
  }

  // The old suggested voice (Rachel, 21m00Tcm4TlvDq8ikWAM) is a LIBRARY voice:
  // ElevenLabs' free plan rejects it over the API with 402 paid_plan_required,
  // so installs that saved it get a TTS error on every run even though the
  // bundled default (a premade voice) works. Migrate the legacy id to empty —
  // the empty string falls back to DEFAULT_TTS_VOICE_ID — the same way the
  // legacy blurFaces key is healed above.
  if (settings.elevenlabs.voiceId.trim() === "21m00Tcm4TlvDq8ikWAM") {
    settings.elevenlabs.voiceId = "";
  }

  return settings;
}

export interface PageMetrics {
  scrollX: number;
  scrollY: number;
  pageWidth: number;
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  stickyHidden: number;
}

export interface InspectData {
  tab: { id?: number; title?: string; url?: string };
  original: string;
  redacted: string;
  /** True when the redacted frame can actually be sent to a vision model. */
  visionEnabled?: boolean;
  width: number;
  height: number;
  tiles: number;
  detections: Array<{
    kind: string;
    label: string;
    confidence: number;
    box?: { x: number; y: number; width: number; height: number };
    /** See ProcessedScreenshotResult — the tier the painter actually applied. */
    tier?: string;
  }>;
  redactedCount: number;
  processingTimeMs: number;
  verification?: {
    verified: boolean;
    confidence: number;
    summary: string;
    checkedAt: number;
    /**
     * True when the adversarial auditor remediated a soft region it could
     * recover (or a face it re-found) and rebuilt the frame. The bytes on
     * screen are the escalated ones, so the inspector must not present them as
     * the ordinary paint output.
     */
    escalated?: boolean;
    /** What the adversarial pass probed, carried through to the inspector. */
    attack?: VerificationResult["attack"];
  };
  vault: Array<{
    token: string;
    kind: string;
    original: string;
    createdAt: number;
  }>;
  snapshot?: {
    elements?: PageElement[];
    text?: string;
    title?: string;
    url?: string;
  } | null;
}
