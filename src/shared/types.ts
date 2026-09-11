import type { ProviderId } from "../background/providers/types";

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
  | "type"
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
}

/** Screenshot processing result from the privacy pipeline. */
export interface ProcessedScreenshotResult {
  redactedDataUrl: string;
  detections: Array<{
    kind: string;
    box?: { x: number; y: number; width: number; height: number };
    confidence: number;
    label: string;
  }>;
  redactedCount: number;
  processingTimeMs: number;
  /** Re-OCR proof that redaction actually worked on the shipped pixels. */
  verification?: VerificationResult;
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
  | { kind: "fullpage-begin" }
  | { kind: "fullpage-scroll"; y: number; hideSticky: boolean }
  | { kind: "fullpage-restore" };

/** A rendered entry in the side panel transcript. */
export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "step" | "error" | "system" | "egress";
  text: string;
  /** Set on "step" entries so the UI can show an icon per action type. */
  action?: ActionName;
  /** Set while a step is still running. */
  pending?: boolean;
}

/** One MAIN-world tripwire intercept forwarded to the panel's radar drawer. */
export interface TripwireAlertDetail {
  url: string;
  method: string;
  piiType: string;
  sample: string;
  timestamp: number;
}

/** Privacy audit snapshot — captured after each task for the judges. */
export interface PrivacyAuditSnapshot {
  /** Redacted screenshot as data URL (faces blurred, credentials masked). */
  redactedScreenshot?: string;
  /** PII detections found during this snapshot. */
  detections: Array<{
    kind: string;
    label: string;
    confidence: number;
    box?: { x: number; y: number; width: number; height: number };
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
  | { kind: "patch"; id: string; text?: string; pending?: boolean }  | { kind: "status"; running: boolean }
  | {
      kind: "egress";
      /** Total bytes sent to remote planners this task (0 for local-only). */
      bytes: number;
    }
  | { kind: "confirm";
      id: string;
      summary: string;
    }
  | {
      kind: "privacy-audit";
      audit: {
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
          }>;
        }>;
        allDetections: Array<{
          kind: string;
          label: string;
          confidence: number;
          box?: { x: number; y: number; width: number; height: number };
        }>;
        allTokens: Array<{ token: string; kind: string; sample?: string }>;
        totalRedacted: number;
        totalScreenshots: number;      totalPIIDetections: number;
      durationMs: number;
      /** Latest re-OCR verification result, when a screenshot was redacted. */
      verification?: VerificationResult;
      };
    }
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
  /** Hold-to-talk voice task input via Scribe Realtime. */
  sttEnabled: boolean;
  /** Spoken narration + final answers via streaming TTS. */
  ttsEnabled: boolean;
}

export interface PrivacySettings {
  /** Enable face detection and blur on screenshots. */
  blurFaces: boolean;
  /** Enable credential field masking. */
  maskCredentials: boolean;
  /** Enable PII tokenization for DOM values. */
  tokenizePII: boolean;
  /** Show redaction labels on screenshots (demo mode). */
  showRedactionLabels: boolean;
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
    blurFaces: true,
    maskCredentials: true,
    tokenizePII: true,
    showRedactionLabels: false,
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
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(raw.privacy ?? {}) },
    elevenlabs: { ...DEFAULT_SETTINGS.elevenlabs, ...(raw.elevenlabs ?? {}) },
    ml: { ...DEFAULT_SETTINGS.ml, ...(raw.ml ?? {}) },
  };

  // Pre-multi-provider installs stored a bare Anthropic key and model.
  if (raw.apiKey && !settings.apiKeys.anthropic) settings.apiKeys.anthropic = raw.apiKey;
  if (raw.model && !raw.models) settings.models.anthropic = raw.model;

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
  width: number;
  height: number;
  tiles: number;
  detections: Array<{
    kind: string;
    label: string;
    confidence: number;
    box?: { x: number; y: number; width: number; height: number };
  }>;
  redactedCount: number;
  processingTimeMs: number;
  verification?: {
    verified: boolean;
    confidence: number;
    summary: string;
    checkedAt: number;
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
