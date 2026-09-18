/**
 * Agent Loop
 *
 * The core perceive → plan → act → verify loop, now with the full privacy
 * pipeline integrated. Every piece of data that might cross a network
 * boundary goes through PII detection and redaction first.
 *
 * Privacy flow:
 *   1. DOM perception → PII detection → snapshot tokenization
 *   2. Screenshot capture → face detection → canvas redaction
 *   3. Only sanitized data reaches the LLM/VLM
 *   4. Token resolution happens at the last moment before action execution
 */

import type {
  AgentEvent,
  PageSnapshot,
  Settings,
  TranscriptEntry,
  VerificationResult,
} from "../shared/types";
import { sendProtectedScreenshot } from "../shared/screenshot-egress";
import { tierForKind, type RegionTier } from "../shared/region-paint";
import type { ProcessedScreenshotResult } from "../shared/types";

import { SYSTEM_PROMPT, SYSTEM_PROMPT_LOCAL, taskPrompt } from "./prompt";
import { TOOLS, actionChangesFrame, actionLoopFinding, LOOP_THRESHOLD, LOOP_WINDOW, type ActionStamp } from "./tools";
import { TabController, execute, isRestricted } from "./executor";
import { detectInjection, gate } from "./safety";
import { detectAllPIIDetailed } from "./pii-detector";
import { redactSnapshot } from "./redaction";
import { tokenizer, repairTokenConcatenation, buildTokenLegend } from "./tokenizer";
import { tryDeterministic, bareNavigationGoal, hostSatisfiesBareGoal } from "./deterministic";
import { createPlanner } from "./providers";
import type { ConvMessage, ToolOutcome } from "./providers/types";
import type { ActionExperience, PIIExperience, RunExperience } from "./experience-memory";
import { extractDomain, classifyPageType } from "./experience-memory";
import { classifyFailure } from "./failure-causes";
import { detectContextualPII, contextualToDetectedPII } from "./contextual-pii";
import { getApplicableRules, buildSuppressionKeys, recommendsLLMOnly } from "./learned-rules";
import { getLessons, matchLessons } from "./lessons";
import { getTrajectories, matchTrajectories, renderTrajectoryRoutes } from "./trajectories";
import { piiKindFromOcrLabel } from "./reocr-verification";
import type { DetectedPII } from "./pii-detector";
import { observeWithVision, VISION_SUPPORTED, VISION_DEFAULT_MODELS } from "./vision";
import { recordWire, tokensIn, scanForLeaks } from "./wire-log";
import { matchPiiInText } from "../shared/text-pii-patterns";
import { requestMlNer, requestMlGuard, setActiveNerSpans, setActivePiiTargets, type PiiTarget, probeMlFiles, selfTestMl } from "./ml-bridge";
import { appSwitcherRefusal } from "../shared/route-guard";
import {
  redactionTally,
  describeRedactionTally,
  type RedactionTally,
} from "../shared/metrics";
import { fuseDetections, type NerSpanInput } from "./detector-v2";
import {
  initLedger, recordSnapshot, recordDetections,
  recordAction as ledgerRecordAction,
  recordTokenization as ledgerRecordTokenization,
  recordRedaction as ledgerRecordRedaction,
  recordVerification as ledgerRecordVerification,
} from "./privacy-ledger";

let counter = 0;
const nextId = () => `e${++counter}`;

// ─── Privacy-Aware Snapshot Rendering ───────────────────────────────────────

/**
 * Cheap 32-bit FNV-1a. Used only as a "did this page text change" signature,
 * so the per-page Tier-0 models are not re-run on a page that did not move.
 * Not cryptographic and never used as one.
 */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Strips sensitive query parameters, auth tokens, and session fragments from
 * URLs before they reach any model context or external provider.
 */
export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return `${u.protocol}//${u.host || ""}`;
    }
    // Drop query parameters (?token=..., ?email=...) and hash fragments
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl.split(/[?#]/)[0] ?? rawUrl;
  }
}

/**
 * Sanitizes free text that rides alongside the snapshot but outside its
 * detectors: the page title (and any other raw string rendered into a prompt).
 *
 * This closes the title leak: Gmail's title is "Inbox (n) - you@gmail.com - Gmail",
 * and the signed-in address (plus honorific names in document titles) reached
 * the model raw — the wire-log leak scanner flagged it every run ("Email
 * address (sh•••@gmail.com) reached the model") while the image channel was
 * verified clean. Vault values map back to their existing token so the same
 * value keeps ONE token across title, elements, and text; matches the vault
 * has never seen are tokenized fresh.
 */
export function sanitizeTextPII(text: string): string {
  if (!text || text.length < 6) return text;
  // Pass 1: anything the vault already holds (the same email tokenized in the
  // page body) becomes the SAME token here.
  let out = tokenizer.redactValues(text);
  // Pass 2: PII that lives only in this string. Matches arrive sorted by
  // position — replace from the end so earlier indices stay valid.
  const matches = matchPiiInText(out);
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const kind = m.kind === "id_text" ? "id_number" : "credential";
    const token = tokenizer.tokenize(m.value, kind);
    out = out.slice(0, m.start) + token + out.slice(m.end);
  }
  return out;
}

/**
 * Renders a snapshot for the LLM. If the snapshot has been tokenized
 * (sensitive values replaced with <CRED_1> etc.), the model sees tokens
 * instead of real values.
 */
function renderSnapshot(snapshot: PageSnapshot): string {
  const lines = snapshot.elements.map((el) => {
    const parts = [`[${el.id}]${el.role}`];
    if (el.name) parts.push(JSON.stringify(el.name.length > 40 ? el.name.slice(0, 40) + "..." : el.name));
    if (el.value) parts.push(`=${JSON.stringify(el.value.length > 30 ? el.value.slice(0, 30) + "..." : el.value)}`);
    if (el.attrs) {
      const attrs = Object.entries(el.attrs)
        .filter(([k]) => k !== "offscreen")
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      if (attrs) parts.push(`(${attrs})`);
    }
    return parts.join(" ");
  });

  return [
    `URL: ${sanitizeUrl(snapshot.url)}`,
    `Title: ${sanitizeTextPII(snapshot.title)}`,
    `Scroll: ${snapshot.scroll.y}/${snapshot.scroll.maxY}`,
    `Elements${snapshot.truncated ? "(truncated)" : ""}:`,
    ...lines,
    `Text: ${snapshot.text}`,
  ].join("\n");
}

/**
 * Per-run learning context consulted by the sanitizer. Built once per task
 * from the rules stored for (domain, page type) — this is what closes the
 * self-improvement loop: rules learned on earlier runs change what this run
 * detects, suppresses, and how it plans.
 */
interface SanitizeCtx {
  /** `kind:method` keys to drop (learned false positives). */
  fpKeys: Set<string>;
  /** Learned strategy rule says deterministic fails here — skip it. */
  llmOnly: boolean;
  /** Total applicable rules loaded for logging/experience. */
  ruleCount: number;
  /** When false, DOM PII is redacted directly instead of tokenized (user toggle). */
  tokenize: boolean;
  /**
   * Tier-0 NER spans (Detection v2), fetched per snapshot by the caller and
   * fused into detection here. Fused first so tokenize/redact see one list.
   */
  mlDetections?: DetectedPII[];
}

const EMPTY_SANITIZE_CTX: SanitizeCtx = { fpKeys: new Set(), llmOnly: false, ruleCount: 0, tokenize: true };

/** Readable audit label per PII kind (visual detections already carry theirs). */
const AUDIT_KIND_LABELS: Record<string, string> = {
  credential: "Credential (text)",
  id_number: "ID number (text)",
  api_key: "API key",
  pii_text: "PII text",
  face: "Face",
  image_text: "PII in image (OCR)",
};

/** Map DOM sanitize detections into the audit shape so the proof view shows
 * what was actually tokenized/redacted from page text, not just visuals. */
function auditFromDetections(
  detections: Array<{ kind: string; confidence: number }>,
  policy: { destroyFaces: boolean; maskCredentials: boolean },
): Array<{ kind: string; label: string; confidence: number; tier: RegionTier }> {
  return detections.map((d) => ({
    kind: d.kind,
    label: AUDIT_KIND_LABELS[d.kind] ?? d.kind,
    confidence: d.confidence,
    // DOM-side detections have no paint plan of their own — their pixels are
    // redacted through the same tier table, so ask it with the SAME policy the
    // frame was painted under rather than leaving the tier blank.
    tier: tierForKind(d.kind, policy),
  }));
}

/**
 * Apply the full privacy pipeline to a snapshot before it reaches the LLM.
 * Returns a sanitized snapshot, the kept PII list, and the false-positive
 * candidates that were rejected (learned-rule suppression or checksum
 * failures) so they become measured FP signal instead of over-redaction.
 */
function sanitizeSnapshot(
  snapshot: PageSnapshot,
  ctx: SanitizeCtx = EMPTY_SANITIZE_CTX,
): {
  sanitized: PageSnapshot;
  piiCount: number;
  /** Splits of `piiCount`: vault-tokenized items vs [REDACTED] replacements. */
  tokenCount: number;
  textRedactedCount: number;
  detections: Array<{ kind: string; method: string; confidence: number }>;
  suppressed: Array<{ kind: string; method: string; confidence: number; value?: string }>;
  rejected: Array<{ kind: string; method: string; confidence: number; value?: string }>;
  /**
   * What the detectors kept this snapshot, as value/selector pairs. The
   * screenshot path needs them: the text channels read accessible names,
   * element values and attributes, which the pixel channel cannot see on its
   * own. Without them a detected item is tokenized for the model but stays
   * readable in the frame ("2 detected / 0 redacted").
   */
  piiTargets: PiiTarget[];
} {
  // 1. Detect PII: validated regex patterns + contextual analysis. Aadhaar
  //    lookalikes that fail Verhoeff and card lookalikes that fail Luhn are
  //    returned separately (never redacted, never sent).
  const detailed = detectAllPIIDetailed(snapshot);
  const regexDetections = detailed.detections;
  const contextualDetections = detectContextualPII(snapshot);
  const contextualPII = contextualToDetectedPII(contextualDetections);

  // 2. Learned false-positive suppression — rules from previous runs decide
  //    that `kind` detected by `method` is noise on this domain/page type.
  const suppressed: Array<{ kind: string; method: string; confidence: number; value?: string }> = [];
  const keptRegex = regexDetections.filter((d) => {
    if (ctx.fpKeys.has(`${d.kind}:regex`)) {
      suppressed.push({ kind: d.kind, method: "regex", confidence: d.confidence, value: d.value });
      return false;
    }
    return true;
  });
  // Merge: regex first, then contextual (avoid duplicates by element ID).
  const seenElementIds = new Set(keptRegex.filter((d) => d.elementSelector).map((d) => d.elementSelector));
  const contextualCandidates = contextualPII.filter((d) => !d.elementSelector || !seenElementIds.has(d.elementSelector));
  const keptContextual = contextualCandidates.filter((d) => {
    if (ctx.fpKeys.has(`${d.kind}:contextual`)) {
      suppressed.push({ kind: d.kind, method: "contextual", confidence: d.confidence, value: d.value });
      return false;
    }
    return true;
  });
  const allDetections = [...keptRegex, ...keptContextual];

  // 2.5 Detection v2 fusion: NER spans (fetched per snapshot by the caller)
  // merge with the regex/contextual detections. Checksum-backed detections
  // win duplicates; NER adds the recall the patterns never had.
  let mlMerged: Array<{ kind: string; method: string; confidence: number }> = [];
  if (ctx.mlDetections && ctx.mlDetections.length > 0) {
    // Only spans literally present on THIS page count — see fuseDetections.
    const haystack = [
      snapshot.text,
      ...snapshot.elements.map((el) => `${el.name}\n${el.value ?? ""}`),
    ].join("\n");
    const fused = fuseDetections(allDetections, ctx.mlDetections.map((d) => ({
      text: d.value ?? "",
      label: d.label.startsWith("NER ") ? d.label.slice(4) : d.label,
      score: d.confidence,
    })), haystack);
    allDetections.length = 0;
    allDetections.push(...fused.detections);
    mlMerged = ctx.mlDetections.map((d) => ({
      kind: d.kind,
      method: "ml_ner",
      confidence: d.confidence,
    }));
  }

  // 3. Tokenize the values the detectors actually flagged (names, emails,
  //    phones, ID numbers) so they become vault tokens the LLM can reference
  //    instead of raw values. When the user disabled tokenization, skip the
  //    vault and go straight to [REDACTED] (still redacted, never leaked).
  let tokenized;
  let swept;
  if (ctx.tokenize !== false) {
    tokenized = tokenizer.tokenizeDetections(snapshot, allDetections);

    // 3b. Vault sweep: replace ANY remaining vault value in element values,
    //     names, or page text with its token — even on elements no detector
    //     flagged. Without this, a value the agent just typed into a field
    //     (e.g. an email in Gmail's compose To box, which sits outside the
    //     container pageText() reads) would ride raw into the next planner turn.
    swept = tokenizer.redactVaultValuesInSnapshot({
      elements: tokenized.elements,
      text: tokenized.text,
    });
  } else {
    tokenized = { elements: snapshot.elements, text: snapshot.text, tokenCount: 0 };
    swept = tokenized;
  }

  // 4. Redact whatever could not be tokenized (replace with [REDACTED]).
  const { elements, text, redactedCount } = redactSnapshot(
    {
      elements: swept.elements,
      text: swept.text,
    },
    allDetections,
  );

  return {
    sanitized: {
      ...snapshot,
      // The title bypasses the element/text detectors entirely (it is not part
      // of `elements` or `text`), so it must be sanitized explicitly or the
      // signed-in account's email in "Inbox (n) - you@gmail.com - Gmail" rides
      // raw into every prompt that renders this snapshot.
      title: sanitizeTextPII(snapshot.title),
      elements,
      text,
    },
    piiCount: tokenized.tokenCount + redactedCount,
    tokenCount: tokenized.tokenCount,
    textRedactedCount: redactedCount,
    detections: [
      ...keptRegex.map((d) => ({ kind: d.kind, method: "regex", confidence: d.confidence })),
      ...keptContextual.map((d) => ({ kind: d.kind, method: "contextual", confidence: d.confidence })),
      ...mlMerged,
    ],
    suppressed,
    rejected: detailed.rejected.map((r) => ({
      kind: r.kind,
      method: "checksum",
      confidence: r.confidence,
      value: r.value,
    })),
    // What the detectors kept (tokenized or [REDACTED] in the text channel),
    // each with the element it came from when there was one — the capture path
    // locates these as text and/or as an element box.
    piiTargets: [...keptRegex, ...keptContextual]
      .map((d) => ({ value: d.value, selector: d.elementSelector }))
      .filter((t) => Boolean(t.value || t.selector)),
  };
}

// ─── Agent Dependencies ─────────────────────────────────────────────────────

export interface AgentDeps {
  settings: Settings;
  emit: (event: AgentEvent) => void;
  /** Resolves true when the user approves a gated action. */
  askConfirm: (id: string, summary: string) => Promise<boolean>;
  signal: AbortSignal;
  /** Capture and process a screenshot through the privacy pipeline. */
  captureScreenshot?: (tabId: number) => Promise<{
    original: string;
    processed: import("../shared/types").ProcessedScreenshotResult;
  } | null>;
  /** Record a privacy audit entry for the judges. */
  recordAudit?: (entry: {
    /** True when this frame's redacted image was actually sent to a VLM. */
    shipped?: boolean;
    original?: string;
    redacted?: string;
    detections: Array<{ kind: string; label: string; confidence: number; box?: { x: number; y: number; width: number; height: number }; tier?: string }>;
    tokens: Array<{ token: string; kind: string; sample?: string }>;
    redactedCount: number;
    /** Why this frame's pixels were refused egress, when they were. */
    withheld?: string[];
    verification?: VerificationResult;
  }) => void;
  /**
   * Report the run's redaction tally whenever it changes.
   *
   * The audit payload is assembled in the service worker, which sees frames but
   * never the DOM/text channel's counts. Without this the panel had to tally the
   * run from whichever frames its entry buffer happened to still hold, which is
   * how the same run showed 231 and 227 at once.
   */
  reportTally?: (tally: RedactionTally) => void;
  /** Compact memory of finished exchanges so follow-ups can continue the chat. */
  history?: Array<{ task: string; answer: string; timestamp: number }>;
  /**
   * Override for how long the run will wait on one frame pipeline.
   *
   * Defaults to FRAME_AUDIT_WAIT_MS, which sits above the measured worst case
   * (6.5 s at the 6-tile triage cap) with headroom. Exists so the harness can
   * drive a capture that never settles in milliseconds instead of minutes and
   * assert that the run gives up rather than hanging.
   */
  frameAuditWaitMs?: number;
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

/**
 * Runs one task to completion: perceive, sanitize, plan, act, verify,
 * repeat, until the model stops calling tools or a limit is reached.
 *
 * The privacy pipeline is applied at every perception step:
 *   - DOM snapshots are tokenized before rendering for the LLM
 *   - Screenshot data is redacted before any network transmission
 *   - Token resolution happens only at action execution time
 */
export async function runTask(
  task: string,
  startTabId: number,
  deps: AgentDeps,
): Promise<void> {
  const { settings, emit, askConfirm, signal, captureScreenshot, recordAudit, reportTally, history } = deps;

  /**
   * How long the run will wait on one frame pipeline, wherever it waits.
   *
   * Every wait on the pixel pipeline is bounded by this — the opening frame
   * that feeds the first planner turn, the post-action frame when vision is on,
   * and the join that folds deferred evidence back in. A local capture is
   * measured at 1.2 s for a 1× viewport and up to 6.5 s at the 6-tile triage
   * cap, so this is more than 2× the worst case; a capture that blows past it
   * has wedged, and the run continues without it rather than freezing with
   * nothing on screen to explain why.
   */
  const FRAME_AUDIT_WAIT_MS = deps.frameAuditWaitMs ?? 15_000;

  // Use a shorter system prompt for small local models to avoid context overflow.
  const isLocalModel = settings.provider === "ollama";
  const isFreeTier = settings.provider === "groq" || settings.provider === "nvidia";
  const systemPrompt = isLocalModel ? SYSTEM_PROMPT_LOCAL : SYSTEM_PROMPT;
  // Cap snapshot elements: free-tier providers need smaller snapshots for speed.
  const maxSnapshotElements = isLocalModel ? 15 : isFreeTier ? 30 : 50;

  const planner = createPlanner(settings);

  // ── Experience tracking for self-improvement ──
  const runStartTime = Date.now();
  const trackedActions: ActionExperience[] = [];
  const trackedPII: PIIExperience[] = [];
  /** `kind:method` keys of learned rules that fired this run (confirmations). */
  const firedRuleKeys = new Set<string>();
  let taskSuccess = false;
  // True when the model produced a final answer (a turn with no tool calls).
  // Runs that end by maxing out steps, looping, or aborting mid-stream never
  // set this, so they can no longer be recorded as successes.
  let finalAnswerGiven = false;
  let estimatedTokens = 0;
  let errorCount = 0;
  let sessionEgressBytes = 0;
  // Remote planners (everything except local Ollama) cause real data egress;
  // the badge shows the honest byte count instead of a fake "0 KB".
  const remotePlanner = settings.provider !== "ollama";

  // Optional VLM vision: active only when the user enabled it AND the active
  // provider supports image input. Only the REDACTED screenshot and sanitized
  // text are sent; the request bytes count toward the honest egress badge.
  const visionEnabled = settings.vision.enabled && VISION_SUPPORTED[settings.provider];
  const visionModel = (settings.vision.model || "").trim() || VISION_DEFAULT_MODELS[settings.provider];
  const visionApiKey = settings.apiKeys[settings.provider] ?? "";

  // False positives (learned-rule suppressions + checksum rejects) become
  // measured signals — deduped so the same number is not counted per snapshot.
  const fpSeen = new Set<string>();
  let falsePositiveCount = 0;
  function noteFalsePositive(kind: string, method: string, confidence: number, value?: string): void {
    const key = `${kind}:${method}:${value ?? ""}`;
    if (fpSeen.has(key)) return;
    fpSeen.add(key);
    falsePositiveCount++;
    trackedPII.push({ kind, method, outcome: "false_positive", confidence });
  }

  // Re-OCR (real OCR over the shipped pixels) evidence for this run: a leak
  // the page detectors never saw is an organic MISSED outcome — this is the
  // ground truth that makes recall measurable.
  const ocrLeakSeen = new Set<string>();
  let reocrVerified = true;
  const reocrLeakedPII: string[] = [];
  function noteVerification(v: VerificationResult | undefined): void {
    if (!v) return;
    if (!v.verified) reocrVerified = false;
    for (const leak of v.leakedPatterns ?? []) {
      if (ocrLeakSeen.has(leak)) continue;
      ocrLeakSeen.add(leak);
      reocrLeakedPII.push(leak);
      const label = leak.replace(/^OCR:\s*/, "");
      trackedPII.push({ kind: piiKindFromOcrLabel(label), method: "ocr", outcome: "missed", confidence: 0.6 });
    }
  }

  // ── Optional VLM vision ──
  let initialVisionNote = "";

  /**
   * Sends the REDACTED screenshot to the vision model and folds its
   * description into `fallback`. Best-effort by design: any failure degrades
   * to the DOM-only observation and never blocks the run.
   */
  async function observeScreen(
    processed: ProcessedScreenshotResult,
    fallback: string,
  ): Promise<{ text: string; shipped: boolean; withheld?: string[] }> {
    if (!visionEnabled || !visionApiKey || signal.aborted) return { text: fallback, shipped: false };
    const context = snapshot ? renderSnapshot(snapshot) : `URL: ${sanitizeUrl(tab.url ?? "")}`;
    try {
      const outcome = await sendProtectedScreenshot(processed, (dataUrl) => observeWithVision(
        settings.provider, visionModel, visionApiKey, dataUrl, context, signal,
      ));
      if (!outcome.sent) {
        emit({ kind: "entry", entry: { id: nextId(), role: "system", text: `Screenshot withheld: ${outcome.reasons.join("; ")}. Continuing without image.` } });
        // The reasons ride back to the audit entry: a withheld frame is not a
        // frame PRY may count as verified at run level, and the panel can only
        // say so if it is told (see rollupFrameVerification).
        return { text: fallback, shipped: false, withheld: [...outcome.reasons] };
      }
      const vision = outcome.value;
      sessionEgressBytes += vision.bytes;
      estimatedTokens += Math.ceil(vision.bytes / 4);
      emit({ kind: "egress", bytes: sessionEgressBytes });
      return { text: `${fallback}\n\n[VLM observation (${vision.model}): ${vision.text}]`, shipped: true };
    } catch {
      // A provider error may occur after request bytes left. Do not infer
      // "not sent" from an empty response or put provider error bodies in context.
      return { text: fallback, shipped: true };
    }
  }

  // ─── The frame pipeline, and the two policies for waiting on it ───────────

  /** Label the awaited frame's line carries in the planner's observation. */
  const FRAME_LABEL_AWAITED = "Screenshot";
  /**
   * Label for a frame reported one step late.
   *
   * It NAMES the lag rather than hiding it. The pixels are the previous
   * action's — captured at the same instant the awaited path would have
   * captured them, only consumed later — and a page read that mixed the two
   * silently would read as though it came from the wrong moment.
   */
  const FRAME_LABEL_DEFERRED = "Frame after the previous action";
  /** Label for the run's opening frame when it too is deferred (vision off). */
  const FRAME_LABEL_OPENING = "Opening frame";

  /**
   * The audit-only pipeline in flight, if any.
   *
   * Doubles as the serialisation handle (see startFrameAudit) and as the handle
   * a join waits on, which is why it is NOT cleared the moment it settles: a
   * slot cleared early would let the next capture run concurrently with a
   * pipeline that had merely outlived its join budget.
   */
  let pendingFrameAudit: Promise<{ summary: string } | null> | null = null;
  /** True once this pipeline's line has been handed over (delivered at most once). */
  let frameAuditDelivered = false;
  /**
   * Set when a frame the run waited on did not arrive in time. It stops the run
   * from paying that wait again — see `frameNeedsPlannerWait`.
   */
  let frameWaitOverran = false;
  /** Said once, when the wait stops being worth placing. */
  let announcedFrameWaitAbandoned = false;
  /** Said once, when a frame's stage breakdown is printed — see below. */
  let announcedFrameCost = false;
  /** Evidence joined after the last planner turn, not yet handed to the planner. */
  let carriedFrameNote = "";

  /**
   * One frame through the pixel pipeline: capture → redact → verify → attack →
   * record evidence. Returns the evidence line the planner reads, and the
   * observation text to use in place of `observationSoFar` (the VLM's
   * description when vision is on), or null when there was no frame.
   *
   * WHY THIS IS A NAMED FUNCTION AND NOT AN INLINE BLOCK
   *
   * There are two call sites and they must wait differently:
   *
   *   - before the first planner turn, and after every action while VISION IS
   *     ON, the caller AWAITS it — a frame, or the VLM's description of it, is
   *     what the next turn reasons about, so the chain belongs on the critical
   *     path;
   *   - after an action while VISION IS OFF, the caller STARTS it and keeps
   *     going (startFrameAudit). Nothing about that frame reaches the planner,
   *     so the work is purely local evidence — ledger entries, the audit panel,
   *     the run's PII totals and its re-OCR leak findings — and it was sitting
   *     between the action and the next planner turn for no reader's benefit.
   *     Measured at 1.2 s for a 1× viewport and up to 6.5 s at the 6-tile
   *     triage cap, once per page-changing action, all of it paid before the
   *     model was even asked what to do next.
   *
   * Keeping one implementation is the point: the two sites used to be two
   * copies of this ~55-line block, which is how a fix lands in one and not the
   * other.
   */
  async function runFrameAudit(
    domDetections: Array<{ kind: string; confidence: number }>,
    observationSoFar: string,
    /** `FRAME_LABEL_AWAITED` / `FRAME_LABEL_DEFERRED`, or "" for no line. */
    summaryLabel: string,
  ): Promise<{ summary: string; observation: string; shipped: boolean } | null> {
    if (!captureScreenshot) return null;
    // Snapshot the vault BEFORE any await: the audit entry describes the tokens
    // that were live for THIS frame, and a deferred pipeline can otherwise read
    // a vault that a later page read has already added to.
    const tokensAtCapture = tokenizer.getTokenSummary();
    try {
      const screenshotResult = await captureScreenshot(controller.tabId);
      if (!screenshotResult) return null;

      const processed = screenshotResult.processed;
      const visualDetections = processed.detections.map((d) => ({
        kind: d.kind,
        label: d.label,
        confidence: d.confidence,
        box: d.box,
        // Carried straight from the painter — the view never re-derives it.
        tier: d.tier,
      }));
      const verification = processed.verification;
      noteVerification(verification);

      // A frame that came back OVER the wait budget is the reported stall, and
      // the stage breakdown for it was measured in the browser — the only place
      // these numbers exist — so it is printed where the cost was felt. Said
      // once per run: every later frame on the same page pays the same stages,
      // and a transcript that repeats its diagnosis is noise. The remainder is
      // shown as well, because the stages do not sum to the total and pretending
      // they do would hide the arithmetic that is still unaccounted for.
      if (
        !announcedFrameCost &&
        processed.stages?.length &&
        processed.processingTimeMs > FRAME_AUDIT_WAIT_MS
      ) {
        announcedFrameCost = true;
        const marked = processed.stages.reduce((sum, s) => sum + s.ms, 0);
        const rest = Math.max(0, Math.round(processed.processingTimeMs) - marked);
        emit({
          kind: "entry",
          entry: {
            id: nextId(),
            role: "system",
            text:
              `Frame cost ${(processed.processingTimeMs / 1000).toFixed(1)}s, over the ` +
              `${Math.round(FRAME_AUDIT_WAIT_MS / 1000)}s wait budget. Measured in this browser — ` +
              processed.stages.map((s) => `${s.stage} ${(s.ms / 1000).toFixed(1)}s`).join(" · ") +
              ` · other ${(rest / 1000).toFixed(1)}s.`,
          },
        });
      }

      let summary = "";
      if (summaryLabel) {
        summary = `[${summaryLabel}: ${processed.redactedCount} PII redacted]`;
        if (verification && verification.regionsChecked > 0) {
          summary += verification.verified
            ? ` [Re-OCR VERIFIED: ${verification.regionsRedacted}/${verification.regionsChecked} regions confirmed redacted]`
            : ` [Re-OCR WARNING: ${verification.summary}]`;
        }
      }
      let observation = summary ? `${observationSoFar}\n\n${summary}` : observationSoFar;

      // Ledger: visual detections + redaction + re-OCR verification proof.
      if (visualDetections.length > 0) {
        recordDetections(visualDetections.map((d) => ({ ...d, method: "visual" }))).catch(() => {});
      }
      if (processed.redactedCount > 0) {
        ledgerRecordRedaction(processed.redactedCount, "visual").catch(() => {});
      }
      if (verification && verification.regionsChecked > 0) {
        ledgerRecordVerification(verification.verified, verification.regionsChecked, verification.leakedPatterns.length).catch(() => {});
      }

      // Track visual detections in experience memory too (faces, avatars).
      for (const det of visualDetections) {
        trackedPII.push({
          kind: det.kind,
          method: "visual",
          outcome: "true_positive",
          confidence: det.confidence,
        });
      }
      piiFrameRegions += processed.redactedCount;
      reportCurrentTally();

      // Optional VLM vision: only the redacted screenshot leaves. Run before
      // the audit record so the panel's caption reflects whether pixels
      // actually left the browser.
      let shippedToModel = false;
      let withheldReasons: string[] | undefined;
      if (visionEnabled && visionApiKey && !signal.aborted) {
        const described = await observeScreen(processed, observation);
        shippedToModel = described.shipped;
        withheldReasons = described.withheld;
        observation = described.text;
      }

      // Record for privacy audit — DOM detections + visuals.
      recordAudit?.({
        original: screenshotResult.original,
        redacted: processed.redactedDataUrl,
        detections: [...visualDetections, ...auditFromDetections(domDetections, settings.privacy)],
        tokens: tokensAtCapture,
        redactedCount: processed.redactedCount,
        shipped: shippedToModel,
        withheld: withheldReasons,
        verification,
      });

      return { summary, observation, shipped: shippedToModel };
    } catch {
      // Capture is optional — DOM perception still works without it.
      return null;
    }
  }

  /**
   * Start the frame pipeline and keep going (vision off).
   *
   * NEVER two captures at once. In the normal case that is free — the previous
   * frame is joined after the next planner turn, which is always before this is
   * called again — but a pipeline that outlived its join budget is still
   * running, so the new one chains behind it. The offscreen document's face
   * detectors are module singletons, and a second frame processed through a
   * detector the first is mid-way through using is exactly the kind of quiet
   * corruption this project treats as a privacy bug rather than a glitch.
   *
   * Queuing delays EVIDENCE only: this function is fire-and-forget, so no
   * planner turn ever waits on it.
   */
  function startFrameAudit(
    domDetections: Array<{ kind: string; confidence: number }>,
    /** `FRAME_LABEL_DEFERRED` after an action, `FRAME_LABEL_OPENING` at the start. */
    label: string,
  ): void {
    const previous = pendingFrameAudit;
    const settled = previous ? previous.then(() => undefined, () => undefined) : Promise.resolve();
    pendingFrameAudit = settled
      .then(() => runFrameAudit(domDetections, "", label))
      .then((outcome) => (outcome ? { summary: outcome.summary } : null))
      .catch(() => null);
    frameAuditDelivered = false;
  }

  /**
   * Wait for the in-flight evidence pipeline and return its line, or "".
   *
   * Called after a planner turn — the point at which the pipeline has had the
   * whole turn to finish in parallel with it, so the wait is normally free.
   * The line is delivered AT MOST ONCE (`frameAuditDelivered`, set before the
   * wait so a second join cannot re-deliver it, and so a wedged pipeline is not
   * re-awaited by every later turn).
   */
  async function joinFrameAudit(): Promise<string> {
    const pending = pendingFrameAudit;
    if (!pending || frameAuditDelivered) return "";
    frameAuditDelivered = true;
    const outcome = await joinEvidence(pending, FRAME_AUDIT_WAIT_MS);
    return outcome?.summary ?? "";
  }

  /**
   * Await a frame the planner actually reads, with a ceiling.
   *
   * Used by the two sites whose output goes INTO a planner turn (the opening
   * frame and, with vision on, the post-action frame). `joinEvidence` collapses
   * "the pipeline finished with nothing" and "the pipeline never finished" into
   * the same null, so the result is wrapped: the callers must be able to tell a
   * frame that had nothing to report from a capture that wedged, because only
   * the second one is worth telling the user about.
   */
  async function awaitFrame(
    run: Promise<{ observation: string } | null>,
  ): Promise<{ kind: "done"; value: { observation: string } | null } | { kind: "timeout" }> {
    const settled = await joinEvidence(run.then((value) => ({ value })), FRAME_AUDIT_WAIT_MS);
    return settled ? { kind: "done", value: settled.value } : { kind: "timeout" };
  }

  /** One honest line when a frame the planner needed did not arrive in time. */
  function noteFrameTimeout(where: string): void {
    frameWaitOverran = true;
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text:
          `Frame capture (${where}) did not finish within ${Math.round(FRAME_AUDIT_WAIT_MS / 1000)}s — ` +
          `continuing without a visual description of that frame. The redaction pipeline keeps ` +
          `running and still files its ledger entry and audit record.`,
      },
    });
  }

  /**
   * Report frame evidence that was joined but never handed to a planner turn.
   *
   * The line is joined AFTER a planner turn and delivered on that turn's first
   * tool result — so a turn that ends the run (a final answer, a refusal, Stop)
   * has nowhere to carry it. Dropping it silently would take the ONLY
   * planner-visible record of that frame out of the run with no trace, which is
   * exactly the class of quiet omission this codebase treats as a bug. The
   * ledger and the audit panel do not depend on this — the pipeline filed those
   * itself — so this is about the transcript telling the whole story.
   */
  function reportUndeliveredFrameNote(): void {
    if (!carriedFrameNote) return;
    const note = carriedFrameNote;
    carriedFrameNote = "";
    emit({
      kind: "entry",
      entry: { id: nextId(), role: "system", text: `Last frame audit: ${note}` },
    });
  }

  // ── Privacy Budget Ledger ──
  await initLedger();

  let controller = new TabController(startTabId);
  const tab = await chrome.tabs.get(startTabId);

  if (isRestricted(tab.url)) {
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "error",
        text: `I can't work on ${tab.url} — Chrome blocks extensions on its own pages. Open a normal website and try again.`,
      },
    });
    return;
  }

  const domain = extractDomain(tab.url ?? "");

  emit({
    kind: "entry",
    entry: {
      id: nextId(),
      role: "system",
      text: `Using ${planner.label}. Privacy pipeline: active.`,
    },
  });

  await controller.waitForLoad();
  let snapshot = await controller.snapshot();

  /** Elements of the snapshot the model most recently saw — used to resolve
   * stale element ids by role+name without burning a planner round trip. */
  let lastRenderedElements: Array<{ id: number; role: string; name: string }> = [];
  /**
   * The page read `lastRenderedElements` came from.
   *
   * Element ids are positional, so the ids in a tool call are only meaningful
   * against the read the model was shown. Carrying that read's generation lets
   * the page refuse an id from an earlier one (see act.ts resolve) and lets the
   * loop tell "this number still means the same control" apart from "this
   * number now means something else".
   */
  let lastRenderedGeneration: number | undefined;

  // Apply privacy pipeline to initial snapshot.
  const pageType = classifyPageType(tab.url ?? "", tab.title ?? "", snapshot?.text ?? "");

  // ── Load learned rules for this (domain, page type). This is where the
  //    self-improvement loop is closed: rules stored by previous runs change
  //    what this run detects, suppresses, and how it plans.
  // Load the stored self-improvement state for this (domain, page type) in
  // parallel: learned rules (FP suppression / planner routing), semantic
  // lessons (Reflexion-style), and successful trajectories (few-shot replay).
  const [applicableRules, storedLessons, storedTrajectories] = await Promise.all([
    getApplicableRules(domain, pageType),
    getLessons(),
    getTrajectories(),
  ]);
  const sanitizeCtx: SanitizeCtx = {
    fpKeys: buildSuppressionKeys(applicableRules),
    llmOnly: recommendsLLMOnly(applicableRules),
    ruleCount: applicableRules.length,
    tokenize: settings.privacy.tokenizePII !== false,
  };
  if (applicableRules.length > 0) {
    const fpRules = applicableRules.filter((r) => r.category === "pii_detection").length;
    const strategyRules = applicableRules.filter((r) => r.category === "strategy").length;
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text:
          `Learning: applying ${applicableRules.length} stored rule(s) for ${domain} ` +
          `(${fpRules} false-positive filter${fpRules === 1 ? "" : "s"}, ${strategyRules} strategy rule${strategyRules === 1 ? "" : "s"}${sanitizeCtx.llmOnly ? ", deterministic disabled by learning" : ""}).`,
      },
    });
  }

  // The run's redactions, counted by CHANNEL and never summed until reported.
  //
  // One variable held both halves, and the two processes tallied from different
  // sources: this loop counted DOM items + frame regions, while the audit chip
  // summed only frame regions, and only over the frames its entry buffer still
  // held (it evicts the middle of a long run). A single run therefore reported
  // 231 "items redacted", 227 "Redacted" and 2 "Vault Tokens" on three surfaces.
  // Keeping the parts apart makes `total === pageItems + frameRegions` true by
  // construction and lets every surface show the same decomposition.
  let piiPageItems = 0;
  let piiFrameRegions = 0;
  /** The tally as it stands now — reported live so the panel never has to guess. */
  const currentTally = () => redactionTally(piiPageItems, piiFrameRegions, tokenizer.size);
  const reportCurrentTally = (): void => {
    try {
      reportTally?.(currentTally());
    } catch {
      // Reporting totals is evidence, never a reason to fail a run.
    }
  };
  const mlFlags = {
    ner: settings.ml?.ner !== false,
    guard: settings.ml?.guard !== false,
  };

  // Honest ML status. The self-test LOADS each model and runs one real
  // inference; file presence alone is not evidence (a model can be present and
  // still fail to load, and the failure is swallowed by the degradation
  // contract). The file probe is only a fallback for when the offscreen
  // runtime cannot answer at all.
  void selfTestMl().then((selfTest) => {
    const parts: string[] = [];
    if (selfTest) {
      if (selfTest.ner.ready) {
        // Report what the DETECTOR kept, not what the model emitted. A model
        // that loads but yields no policy-passing span is a silent no-op, and
        // saying "loaded, found 4 entities" there is how that hid for so long.
        const found = selfTest.ner.sample?.length
          ? ` (${selfTest.ner.kept ?? selfTest.ner.sample.length} usable span(s): ${selfTest.ner.sample.join(", ")})`
          : " (loaded, but the probe produced NO usable span — name tokenization is inactive)";
        parts.push(`NER model loaded${found}`);
      } else if (mlFlags.ner) {
        parts.push(`NER model FAILED to load — regex + checksums active (${selfTest.ner.reason ?? "unknown"})`);
      }
      if (selfTest.guard.ready) {
        parts.push(`injection guard loaded (probe verdict: ${selfTest.guard.label ?? "n/a"})`);
      } else if (mlFlags.guard) {
        parts.push(`injection guard not bundled — regex heuristic active`);
      }
      parts.push(selfTest.face.ready ? "BlazeFace loaded" : "BlazeFace unavailable — skin-colour fallback active");
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "system",
          text: `On-device ML self-test: ${parts.join(" · ")}.`,
        },
      });
      return;
    }
    // Offscreen runtime did not answer — fall back to what is on disk, and say
    // that this is a weaker claim.
    return probeMlFiles().then((m) => {
      if (m.face) parts.push("faces: BlazeFace bundled");
      if (mlFlags.ner) parts.push(m.ner ? "NER model present on disk (unverified)" : "NER model not bundled (regex + checksums active)");
      if (mlFlags.guard) parts.push(m.guard ? "injection guard present on disk (unverified)" : "injection guard not bundled (regex heuristic active)");
      if (parts.length === 0) return;
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "system",
          text: `On-device ML: ${parts.join(" · ")}.`,
        },
      });
    });
  });
  // ── Tier-0 (on-device) refresh ────────────────────────────────────────────
  // The NER and injection models are per-PAGE, not per-run. They used to be
  // scored exactly once, against the snapshot the run started from — so every
  // later page was un-scored: a name in prose on page 3 was neither tokenized
  // for the planner nor black-boxed in the screenshot, and the wire log
  // honestly reported the resulting leak while the rest of the pipeline
  // believed it had covered it. The stale span list also kept the FIRST page's
  // names fused into the sanitizer context for the whole run.
  //
  // Re-scoring is gated on a cheap signature of the page text, so a page that
  // did not change (most turns) costs nothing.
  let lastTier0Signature = "";
  let lastNerNotice = "";
  const refreshTier0 = async (text: string): Promise<void> => {
    if (!mlFlags.ner && !mlFlags.guard) return;
    const signature = `${text.length}:${fnv1a(text)}`;
    if (signature === lastTier0Signature) return;
    lastTier0Signature = signature;

    // Tier-0 NER (Detection v2): fetch spans for THIS page's text before
    // sanitizing so the fusion layer sees them, and hand the span texts to the
    // screenshot path so the same names become black-box regions (the
    // NER-to-pixel bridge). Degrades to [] when the model is missing or slow;
    // the run never stalls on it.
    if (mlFlags.ner) {
      try {
        const spans: NerSpanInput[] = await requestMlNer(text, mlFlags, signal);
        setActiveNerSpans(spans.map((sp) => sp.text));
        // REPLACE, never merge — page 3's spans must not inherit page 1's.
        sanitizeCtx.mlDetections = spans.length > 0
          ? spans.map((s) => ({
              kind: "pii_text" as const,
              value: s.text,
              confidence: Math.min(0.95, Math.max(0.5, s.score)),
              label: `NER ${s.label}`,
            }))
          : undefined;
        const notice = spans.map((s) => s.text).sort().join("|");
        if (spans.length > 0 && notice !== lastNerNotice) {
          lastNerNotice = notice;
          emit({
            kind: "entry",
            entry: {
              id: nextId(),
              role: "system",
              text: `On-device NER: ${spans.length} name/location span(s) detected by the local model.`,
            },
          });
        }
      } catch {
        setActiveNerSpans([]);
        sanitizeCtx.mlDetections = undefined;
        // NER is additive — never block the run.
      }
    }

    // Tier-0 injection guard: the model's semantic verdict on this page's
    // text, announced alongside the regex detector's opinion.
    if (mlFlags.guard) {
      try {
        const verdict = await requestMlGuard(text, mlFlags, signal);
        if (verdict?.injection) {
          emit({
            kind: "entry",
            entry: {
              id: nextId(),
              role: "system",
              text: `Injection guard: page text scored ${verdict.score.toFixed(2)} (${verdict.label}) by the local classifier. Treated as data, not instructions.`,
            },
          });
        }
      } catch {
        // Same contract — additive, never blocking.
      }
    }
  };

  // Latest DOM (text) detections for the audit view — the screenshots only
  // carry visual detections, so without this the proof panel hides the emails,
  // phones and ID numbers the DOM sanitizer actually tokenized.
  let lastDomDetections: Array<{ kind: string; confidence: number }> = [];
  if (snapshot) {
    // Record snapshot in privacy ledger.
    // The ledger persists across sessions, so it follows the same rule as the
    // model context: titles and URLs are sanitized before they are written.
    recordSnapshot(sanitizeUrl(snapshot.url), sanitizeTextPII(snapshot.title), snapshot.elements.length).catch(() => {});

    // Tier-0 models score THIS page (see refreshTier0).
    await refreshTier0(snapshot.text);

    const { sanitized, piiCount, tokenCount, textRedactedCount, detections, suppressed, rejected, piiTargets } = sanitizeSnapshot(snapshot, sanitizeCtx);
    snapshot = sanitized;
    lastDomDetections = detections;
    // Hand the pixel channel the same items the text channel just found —
    // otherwise an email the detector read out of an aria-label is tokenized
    // for the model while staying readable in the screenshot.
    setActivePiiTargets(piiTargets);

    // Record detections in privacy ledger.
    if (detections.length > 0) {
      recordDetections(detections.map((d) => ({ ...d, label: d.kind }))).catch(() => {});
    }

    // Record tokenization in privacy ledger.
    const tokenSummary = tokenizer.getTokenSummary();
    if (tokenSummary.length > 0) {
      ledgerRecordTokenization(tokenSummary).catch(() => {});
    }
    if (piiCount > 0) {
      ledgerRecordRedaction(piiCount, "dom").catch(() => {});
    }

    piiPageItems += piiCount;
    reportCurrentTally();

    // Track PII detections for experience memory.
    for (const det of detections) {
      trackedPII.push({
        kind: det.kind,
        method: det.method,
        outcome: "true_positive",
        confidence: det.confidence,
      });
    }

    // False positives are measured, not hidden: rule-suppressed detections
    // and checksum-rejected lookalikes feed the FP signal back into memory.
    // A learned rule that suppresses a detection is a CONFIRMATION event —
    // the rule fired and (absent a user correction) did its job.
    for (const fp of suppressed) {
      firedRuleKeys.add(`${fp.kind}:${fp.method}`);
      noteFalsePositive(fp.kind, fp.method, fp.confidence, fp.value);
    }
    for (const rj of rejected) noteFalsePositive(rj.kind, rj.method, rj.confidence, rj.value);
    if (suppressed.length + rejected.length > 0) {
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "system",
          text:
            `Learned filters: rejected ${suppressed.length + rejected.length} false positive(s) ` +
            `(${suppressed.length} rule-based, ${rejected.length} checksum-verified as lookalikes).`,
        },
      });
    }

    if (piiCount > 0) {
      // Say which channel did what. This used to read "detected and redacted
      // N sensitive item(s)", which was true of the TEXT channel and was read
      // as a claim about the pixels — so a frame with 0 black boxes next to a
      // "redacted 2" line looked like the pipeline lying rather than like two
      // different channels. Pixel redaction is reported by the capture path.
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "system",
          text:
            `Privacy (text channel): ${piiCount} sensitive item(s) in page context — ` +
            `${tokenCount} tokenized for the planner, ${textRedactedCount} replaced with [REDACTED] in the text it reads.`,
        },
      });
    }
  }

  // Capture the opening frame through the privacy pipeline (if available).
  //
  // The SAME two waiting policies as the post-action site, for the same reason:
  //
  //   VISION ON — the frame's description is what the first planner turn
  //   reasons about, so it is awaited. Bounded (see FRAME_AUDIT_WAIT_MS):
  //   this site is the one place a wedged capture could hang a run before the
  //   model was ever asked anything, and it has no planner turn to hide behind.
  //
  //   VISION OFF — nothing about this frame reaches the planner either. It is
  //   started and joined after the first planner turn, like every post-action
  //   frame, so the first planner call of a run stops paying 1.2-6.5 s of local
  //   pixel work for evidence it never reads.
  //
  // No summary label in the awaited case: the opening frame is not part of an
  // action's observation, and its VLM description becomes `initialVisionNote`.
  if (
    frameNeedsPlannerWait({ visionEnabled, hasVisionKey: visionApiKey !== "", aborted: signal.aborted })
  ) {
    const opening = await awaitFrame(runFrameAudit(lastDomDetections, "", ""));
    if (opening.kind === "done" && opening.value) initialVisionNote = opening.value.observation;
    if (opening.kind === "timeout") noteFrameTimeout("opening frame");
  } else {
    startFrameAudit(lastDomDetections, FRAME_LABEL_OPENING);
  }

  // Tokenize PII in the user's task (same vault as page PII), so the planner
  // sees one token vocabulary across the task and the page.
  //
  // The REPORT of what was taken is not made here. By the time runTask is
  // called, the service worker has already tokenized the task and passed the
  // tokenized string in, so this pass finds nothing new — the line that used to
  // live here was guarded on a count that is structurally always 0, and never
  // rendered. It now lives where the substitution actually happens
  // (service-worker `start`), which is also the only pass that still has the
  // raw words to name in masked form.
  const { task: tokenizedTask } = tokenizer.tokenizeTask(task);

  // Previous-task memory: a compact, re-tokenized recap of the last few runs
  // so follow-ups ("continue", "also do X on that email") have context. It
  // runs through the same vault as the page/task, so no raw values reach the
  // model.
  let historyBlock = "";
  if (history && history.length > 0) {
    const raw = history
      .map((h) => `You asked: ${h.task}\nYou answered: ${h.answer}`)
      .join("\n\n");
    const { task: sanitizedHistory, tokenCount: historyTokenCount } = tokenizer.tokenizeTask(raw);
    if (historyTokenCount > 0) {
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "system",
          text: `Memory: tokenized ${historyTokenCount} PII item(s) from earlier tasks in context.`,
        },
      });
    }
    historyBlock = `--- Previous conversation (earlier tasks) ---\n${sanitizedHistory}\n--- End previous conversation ---`;
  }

  // Semantic memory: lessons and successful trajectories from past runs on
  // this site become few-shot context for the planner. Both were sanitized at
  // write time (tokenized tasks, redacted answers), so nothing raw reaches
  // the model here either.
  const lessonsBlock = (() => {
    const relevant = matchLessons(storedLessons, domain, pageType);
    if (relevant.length === 0) return "";
    return (
      `--- Lessons learned on this site (from past runs) ---\n` +
      relevant.map((l) => `- ${l.text}`).join("\n") +
      `\n--- End lessons ---`
    );
  })();
  // The wording here is behavior, so it lives in trajectories.ts as a pure,
  // tested function (see renderTrajectoryRoutes for why).
  const trajectoriesBlock = renderTrajectoryRoutes(
    matchTrajectories(storedTrajectories, domain, pageType),
  );

  // Truncate snapshot to avoid context overflow across all providers.
  if (snapshot && snapshot.elements.length > maxSnapshotElements) {
    // For free-tier: skip offscreen elements entirely for speed.
    if (isFreeTier) {
      snapshot = { ...snapshot, elements: snapshot.elements.filter((e) => !e.attrs?.offscreen) };
    }
    // Prefer visible elements over offscreen ones.
    const visible = snapshot.elements.filter((e) => !e.attrs?.offscreen);
    const offscreen = snapshot.elements.filter((e) => e.attrs?.offscreen);
    const kept = [...visible, ...offscreen].slice(0, maxSnapshotElements);
    snapshot = { ...snapshot, elements: kept, truncated: true };
  }

  // Everything in the opening message EXCEPT the page read, so that read can be
  // pruned in place once a fresher one exists (see the prune inside the loop).
  // It is the one block that otherwise re-renders in full on EVERY turn: a page
  // read is roughly 8-15 KB (up to 80 elements plus the snapshot text budget),
  // so a six-turn run pays ~50-90 KB of egress and the prefill latency that
  // comes with it for a page the planner has already moved past.
  const openingContext =
    (historyBlock ? `${historyBlock}\n\n` : "") +
    (lessonsBlock ? `${lessonsBlock}\n\n` : "") +
    (trajectoriesBlock ? `${trajectoriesBlock}\n\n` : "") +
    taskPrompt(
      tokenizedTask,
      sanitizeUrl(tab.url ?? ""),
      sanitizeTextPII(tab.title ?? ""),
      // Built from the live vault, filtered to the tokens that are actually
      // IN this task, so it always matches what the planner is looking at
      // and never contains a value — only the category. It used to be built
      // from the entries THIS pass created, which is structurally empty
      // (the worker already tokenized the task), so the legend the prompt
      // promised the planner was silently blank.
      buildTokenLegend(
        tokenizer.getEntries().filter((e) => tokenizedTask.includes(e.token)),
      ),
    );

  const OPENING_PAGE_OMITTED =
    "\n\n[Opening page snapshot omitted — the newest page read below supersedes it]";
  const openingVisionNote = initialVisionNote ? `\n\n${initialVisionNote}` : "";

  const messages: ConvMessage[] = [
    {
      role: "user",
      content:
        openingContext +
        (snapshot ? `\n\n--- Current page ---\n${renderSnapshot(snapshot)}` : "") +
        openingVisionNote,
    },
  ];
  lastRenderedElements = snapshot?.elements ?? [];

  if (snapshot) warnIfInjected(snapshot, emit);

  // ── Loop detection: track recent actions to break out of stuck states ──
  // The verdict itself is pure policy in tools.ts (actionLoopFinding), pinned
  // by the harness; this closure only records what happened.
  const recentActions: ActionStamp[] = [];
  /**
   * How many times the loop guard has already nudged this run.
   *
   * The first detection is a stuck PLANNER, not a stuck task: on a Gmail inbox
   * the planner could not find a clickable message row, re-read the page three
   * times looking for one, and the guard ended the whole run there — the task
   * was still solvable, the planner just did not know which handle to use. The
   * first detection therefore injects what it was missing and clears the
   * history so the planner can act; only a repeat after that advice stops the
   * run. maxSteps still bounds the worst case independently.
   */
  let loopNudges = 0;
  /** How many times this run has told the planner to stop deliberating. */
  let deliberationSteers = 0;
  /**
   * True once any turn of this run has produced output.
   *
   * The retry policy reads it to tell two silences apart that look identical in
   * the error message: an endpoint that has never answered (do not re-send — a
   * measured dead wait), and one that answered the previous turn and then went
   * silent on this request (re-send once, with the short budget). Set only where
   * a turn actually resolved, so it is evidence rather than an assumption.
   */
  let endpointServedThisRun = false;

  function recordAction(name: string, input: Record<string, unknown>): void {
    // Sign click/type actions by the target's role+name, not the raw id:
    // element ids are re-issued on every snapshot, so the same on-page target
    // arrives as a different id each turn — click #9 and click #11 on
    // "Google apps" looked like two distinct actions and the loop detector
    // went blind exactly on re-snapshot loops (click → find_text → click →
    // find_text ran forever without tripping the threshold). The semantic
    // signature is stable across snapshots, so both the consecutive and the
    // oscillation checks see the repetition.
    let signature = JSON.stringify(input);
    const elId = (input as { element_id?: unknown }).element_id;
    if (typeof elId === "number" && snapshot) {
      const el = snapshot.elements.find((e) => e.id === elId);
      if (el) signature = JSON.stringify({ target: `${el.role}:${el.name}` });
    }
    recentActions.push({ name, signature });
    if (recentActions.length > LOOP_WINDOW) recentActions.shift();
  }



  // ── Cleanup: emit experience and clear vault on ANY exit path ──
  let experienceEmitted = false;
  function finishTask(): void {
    if (experienceEmitted) return;
    experienceEmitted = true;

    const hasSuccessfulActions = trackedActions.some((a) => a.success);
    // Semantic-ish outcome: no errors, at least one real action (or none was
    // needed), AND the model actually delivered a final answer. A run that hit
    // maxSteps or aborted without ever concluding is not a success.
    taskSuccess =
      !transcriptHasErrors() &&
      (hasSuccessfulActions || trackedActions.length === 0) &&
      finalAnswerGiven;

    // Read the tally BEFORE the vault is cleared: the token population is part
    // of the run's evidence, and `tokenizer.clear()` at the end of this handler
    // would report zero tokens for a run that created two.
    const tally = currentTally();
    reportCurrentTally();

    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text:
          `Task ended. ${describeRedactionTally(tally)}. ` +
          (sanitizeCtx.ruleCount > 0 || falsePositiveCount > 0
            ? `Learning: ${sanitizeCtx.ruleCount} rule(s) consulted, ${falsePositiveCount} false positive(s) filtered. `
            : "") +
          (remotePlanner ? `Egress: ${formatEgress(sessionEgressBytes)}. ` : "Local planner: zero egress. ") +
          `Token vault cleared.`,
      },
    });

    const experience: RunExperience = {
      id: `exp-${runStartTime}`,
      timestamp: runStartTime,
      // Store the tokenized task (vault tokens, not raw values) — experiences
      // persist to chrome.storage and feed reflection/lessons, so raw PII
      // typed by the user must never land there.
      task: tokenizedTask,
      domain,
      pageType,
      piiDetections: trackedPII,
      actions: trackedActions,
      taskSuccess,
      durationMs: Date.now() - runStartTime,
      piiRedacted: tally.total,
      estimatedTokens,
      rulesApplied: sanitizeCtx.ruleCount,
      egressBytes: sessionEgressBytes,
      reocrVerified,
      reocrLeakedPII,
      rulesFired: [...firedRuleKeys],
      rulesGenerated: [],
      userCorrections: [],
    };

    emit({ kind: "experience", experience } as unknown as AgentEvent);
    emit({ kind: "egress", bytes: sessionEgressBytes });
    tokenizer.clear();
    // The run is over: the next task must not inherit this page's items to
    // locate, or its first capture could box a name from the previous site.
    setActivePiiTargets([]);
    setActiveNerSpans([]);
  }

  // A task that is nothing but a navigation, computed once from the task text.
  // See bareNavigationGoal for why the shape is kept this narrow.
  const bareGoal = bareNavigationGoal(task);

  for (let step = 0; step < settings.maxSteps; step++) {
    if (signal.aborted) { finishTask(); return; }

    // ─── A bare navigation goal that is already satisfied ends the run ──────
    //
    // Checked at the TOP of the loop, so it covers both routes that can move
    // the tab: the deterministic planner (which executes on step 0 and then
    // continues) and the model's own navigate. Either way the NEXT planner turn
    // is the one this prevents — and on a reasoning model that turn is a minute
    // of invented work: the reported "open yt" run answered a one-word
    // navigation with a paragraph about its own tooling, after clicking a video
    // the task never asked for.
    //
    // The answer states only what is checkable (the tab's URL) and says why the
    // run stopped, so a stop is never mistaken for the task being finished some
    // other way. The frame pipeline this step started keeps running and files
    // its own ledger entry and audit record, exactly as it does on Stop.
    if (bareGoal && snapshot?.url && hostSatisfiesBareGoal(bareGoal, snapshot.url)) {
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "assistant",
          text:
            `The tab is on ${sanitizeUrl(snapshot.url)} — that is everything ` +
            `"${task.trim()}" asked for, so the run stopped there instead of looking for ` +
            `a next step.`,
        },
      });
      finalAnswerGiven = true;
      reportUndeliveredFrameNote();
      finishTask();
      return;
    }

    // The model plans against the snapshot rendered in the previous turn, and
    // its ids are only meaningful against THAT read — so the read is recorded
    // with them.
    lastRenderedElements = snapshot?.elements ?? [];
    lastRenderedGeneration = snapshot?.generation;

    // Loop detection — a stuck planner gets one chance to act on advice before
    // the run is stopped, because "keep re-reading the page" is usually a
    // missing-handle problem rather than an impossible task.
    const loopFinding = actionLoopFinding(recentActions);
    if (loopFinding) {
      // How to act instead of looking again. Every shape ends in the same next
      // move, so the fix is stated once; only the diagnosis differs.
      const actAdvice =
        `Act on what you already have: if the thing you need to click has no element ` +
        `id (inbox rows, search results, list items and cards usually have none), use ` +
        `click_text with the exact visible text, e.g. {"text": "<sender and subject of ` +
        `the first row>"}. If the target is below the fold, scroll first — scrolling ` +
        `changes the page and is progress. If you already have everything the task ` +
        `asked for, answer instead of looking again.`;
      const diagnosis =
        loopFinding.kind === "repeat"
          ? `"${loopFinding.action}" repeated ${LOOP_THRESHOLD} times`
          : loopFinding.kind === "oscillation"
            ? `"${loopFinding.action}" and "${loopFinding.other}" are alternating without changing anything`
            : `${LOOP_WINDOW} turns in a row only LOOKED at the page ` +
              `(${loopFinding.actions.join("/")}) without changing it`;
      if (loopNudges === 0) {
        loopNudges++;
        recentActions.length = 0;
        emit({
          kind: "entry",
          entry: {
            id: nextId(),
            role: "system",
            text: `Loop detected: ${diagnosis}. ${actAdvice}`,
          },
        });
        continue;
      }
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: `Loop detected again: ${diagnosis} — after the retry advice. Stopping to prevent an infinite loop. The page may need manual interaction.`,
        },
      });
      finishTask();
      return;
    }

    // Deterministic planner: only on step 0 for simple one-shot tasks, and
    // only when a learned strategy rule has not flagged deterministic as a
    // failure mode for this page type.
    if (step === 0 && !sanitizeCtx.llmOnly) {
      // The user line in the transcript is already tokenized (start()
      // tokenized before runTask), and the deterministic planner only needs
      // the task text — so this is the same string, never a raw secret.
      const detResult = tryDeterministic(task, snapshot ?? null);
      if (detResult.resolved && detResult.action) {
        // Only use deterministic for non-navigate actions on step 0.
        // Navigate on step 0 is fine — the user explicitly said "go to X".
        // The deterministic action is raw task text — resolve any vault tokens
        // through the same last-moment path the LLM actions use, so a typed
        // value like an email is real by execution time, not "<CRED_1>".
        const detInput = resolveTokens(detResult.action.input);
        const detAction = {
          ...detResult.action,
          input: detInput,
          snapshotGeneration: snapshot?.generation,
        };
        const detId = nextId();
        emit({
          kind: "entry",
          entry: {
            id: detId,
            role: "step",
            action: detResult.action.name,
            text: detResult.explanation ?? "Deterministic resolution",
            pending: true,
          },
        });

        // Gate the RESOLVED action (same rule as the LLM path): the value
        // patterns must see the real secret, not a token. A missing `reason`
        // (deterministic only adds one for click/type) must not crash the run.
        const detDecision = gate(detAction, snapshot, settings.confirmRisky);
        if (detDecision.verdict === "allow") {
          recordAction(detResult.action.name, detResult.action.input);
          const detStart = performance.now();
          let detOutcome: Awaited<ReturnType<typeof execute>>;
          try {
            detOutcome = await execute(controller, detAction);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            trackedActions.push({
              tool: detAction.name,
              success: false,
              latencyMs: Math.round(performance.now() - detStart),
              strategy: "deterministic",
              error: detail,
              cause: classifyFailure(detail),
            });
            emit({ kind: "patch", id: detId, text: `Action failed (${detail.slice(0, 80)}) — escalating to the planner.`, pending: false });
            // Escalate: the LLM planner takes this turn instead (same pattern
            // as the confirm/refuse fall-through above). trackedActions
            // already recorded the failure for reflection.
            break;
          }
          const detLatency = performance.now() - detStart;
          controller = detOutcome.controller;

          // Re-tokenize the executed detail: the executor resolved tokens to
          // real values, and its echo must not carry them back to the model.
          const safeDetDetail = tokenizer.redactValues(detOutcome.result.detail);

          // Track deterministic action for experience memory.
          trackedActions.push({
            tool: detResult.action.name,
            success: detOutcome.result.ok,
            latencyMs: detLatency,
            strategy: "deterministic",
            error: detOutcome.result.ok ? undefined : safeDetDetail,
            cause: detOutcome.result.ok ? undefined : classifyFailure(detOutcome.result.detail),
          });

          emit({ kind: "patch", id: detId, text: safeDetDetail, pending: false });

          if (detOutcome.result.snapshot) {
            snapshot = detOutcome.result.snapshot;
            const { sanitized } = sanitizeSnapshot(snapshot, sanitizeCtx);
            snapshot = sanitized;
          }

          // Add observation to messages for next step.
          messages.push({
            role: "assistant",
            text: detResult.explanation ?? "",
            toolCalls: [{ id: `det-${detId}`, name: detResult.action.name, input: detResult.action.input }],
          });
          messages.push({
            role: "tool",
            results: [{ id: `det-${detId}`, content: safeDetDetail, isError: !detOutcome.result.ok }],
          });

          continue;
        }
        // If verdict is confirm/refuse, hand the turn to the LLM — the LLM-path
        // gate (same resolved-input rule) will re-decide with a proper
        // approval prompt. Without this patch the step card would spin forever.
        emit({
          kind: "patch", id: detId,
          text: "Needs approval — escalating to the planner.",
          pending: false,
        });
      }
    }

    // Stream so the user sees reasoning as it arrives rather than staring at a
    // spinner for the length of a long turn.
    const entryId = nextId();
    let opened = false;

    // Coalesce the provider's char-by-char deltas into chunkier screen updates.
    // Each patch makes the panel re-format the card's markdown, so a patch per
    // character is what turns streaming into a slow crawl. Buffering and
    // flushing on a short interval renders in readable bursts instead; the
    // remainder is always flushed before the turn ends, so nothing is lost.
    const FLUSH_INTERVAL_MS = 60;
    const FLUSH_CHUNK_CHARS = 200;
    // Live narration budget: ~2-3 lines. Reasoning models (esp. Llama/NIM)
    // dump chain-of-thought into delta.content, so uncapped streaming floods
    // the panel and slows rendering (a patch per chunk re-formats markdown).
    // The planner's full text is preserved in `turn.text`; only the DISPLAY
    // is capped. Final answers (no tool calls) get the remainder afterwards.
    const MAX_NARRATION_CHARS = 240;
    // The exact redacted text already shown. Tracking the string (not a
    // length) is what makes the final-answer remainder safe to compute: the
    // redacted form can differ in length from the raw form (a long email
    // collapses to <CRED_1>), so slicing the redacted string by a RAW length
    // duplicated or dropped characters at the seam.
    let emittedText = "";
    let pendingText = "";
    let flushTimer: ReturnType<typeof setInterval> | null = null;

    // ─── Reasoning stream (shown, in its own dimmed collapsible block) ───
    // Displaying the model's chain-of-thought is safe here: the model only
    // ever RECEIVED tokenized data, so its reasoning can only quote tokens —
    // and every flushed chunk still runs through the vault sweep like any
    // other displayed string. It is capped so a runaway monologue cannot
    // flood the transcript (the cap is announced, never silent), it is never
    // fed to the learning systems, and it collapses when the turn settles.
    const MAX_THOUGHT_CHARS = 6000;
    let thoughtEntryId: string | null = null;
    let thoughtEmitted = 0;
    let thoughtTruncated = false;
    let thoughtPending = "";
    let thoughtChars = 0;

    const flushThought = (): void => {
      if (thoughtPending.length === 0) return;
      const safe = tokenizer.redactValues(thoughtPending);
      thoughtPending = "";
      if (thoughtTruncated || safe.length === 0) return;
      const remaining = MAX_THOUGHT_CHARS - thoughtEmitted;
      const chunk = safe.slice(0, remaining);
      thoughtEmitted += chunk.length;
      if (!thoughtEntryId) {
        thoughtEntryId = nextId();
        emit({ kind: "entry", entry: { id: thoughtEntryId, role: "thought", text: chunk, pending: true } });
      } else {
        emit({ kind: "patch", id: thoughtEntryId, text: chunk });
      }
      if (thoughtEmitted >= MAX_THOUGHT_CHARS) {
        thoughtTruncated = true;
        emit({
          kind: "patch",
          id: thoughtEntryId,
          text: "\n\n… reasoning truncated for display — the full stream still drove the run.",
        });
      }
    };

    const flushPending = (): void => {
      flushThought();
      if (pendingText.length === 0) return;
      const remaining = MAX_NARRATION_CHARS - emittedText.length;
      if (remaining <= 0) {
        pendingText = "";
        return;
      }
      const safe = tokenizer.redactValues(pendingText).slice(0, remaining);
      pendingText = "";
      // Whitespace-only narration (several small models emit a bare space or
      // newline before a tool call) must not open an empty assistant card —
      // the panel rendered those as blank "PRY AGENT" bubbles with a Copy
      // button and no content. Skip them; the next real flush opens the card.
      if (!safe.trim()) return;
      emittedText += safe;
      if (!opened) {
        opened = true;
        emit({ kind: "entry", entry: { id: entryId, role: "assistant", text: safe } });
      } else {
        emit({ kind: "patch", id: entryId, text: safe });
      }
    };

    const ensureFlushTimer = (): void => {
      if (flushTimer !== null) return;
      flushTimer = setInterval(() => {
        flushPending();
        if (pendingText.length === 0 && thoughtPending.length === 0 && flushTimer !== null) {
          clearInterval(flushTimer);
          flushTimer = null;
        }
      }, FLUSH_INTERVAL_MS);
    };

    const onText = (delta: string): void => {
      // Belt-and-braces: never let a raw vault value render in the transcript
      // even if one somehow reached the model's context.
      pendingText += delta;
      if (pendingText.length >= FLUSH_CHUNK_CHARS) {
        flushPending();
        return;
      }
      ensureFlushTimer();
    };

    // Honest egress meter: remote planners (everything except local Ollama)
    // actually ship bytes to the cloud, so the badge shows a real count.
    if (remotePlanner) {
      try {
        const payload = JSON.stringify({ system: systemPrompt, messages, tools: TOOLS });
        const bytes = estimateUtf8Bytes(payload);
        sessionEgressBytes += bytes;
        estimatedTokens += Math.ceil(bytes / 4);
        emit({ kind: "egress", bytes: sessionEgressBytes });
      } catch {
        // Measurement is best-effort; the run continues regardless.
      }
    }

    // Wire log: record exactly what is about to be sent, and re-run the PII
    // matchers over the outgoing payload. Anything in `leaked` reached the
    // wire despite the pipeline — the log says so loudly instead of trusting
    // the CI fixtures. Local planners are recorded too: "what did the model
    // see" is the same question whether the model is local or remote.
    try {
      const rendered = messages.map((m) => {
        if (m.role === "user") return { role: "user", text: m.content };
        if (m.role === "assistant") {
          const calls = m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join("; ");
          return { role: "assistant", text: [m.text, calls].filter(Boolean).join(" ") };
        }
        return { role: "tool", text: m.results.map((r) => r.content).join("\n") };
      });
      const outgoing = rendered.map((r) => r.text).join("\n");
      recordWire({
        turn: step,
        destination: planner.label,
        systemChars: systemPrompt.length,
        messages: rendered,
        tokens: tokensIn(outgoing),
        leaked: scanForLeaks(outgoing),
        totalChars: systemPrompt.length + outgoing.length,
      });
    } catch {
      // The wire log must never break the run it is auditing.
    }

    // One turn = one bounded planner call, bounded by SILENCE rather than wall
    // clock (see the budget constants). The turn-local abort cancels the
    // request; the user's Stop always wins.
    /**
     * The first-output budget for a turn. Two numbers, not three.
     *
     * A retry does NOT get the full budget: its only job is to learn whether the
     * connection hiccuped, and a hiccup answers in seconds. Re-spending the full
     * 90 s is how a stalled endpoint cost the reported run 268 s — 148 s of
     * streaming, 30 s of silence, then 90 more seconds on a retry that produced
     * nothing before concluding "switch to a faster provider".
     *
     * Every other turn gets the same budget as the opening one. Step 0 is not
     * the slow one (see FIRST_OUTPUT_TIMEOUT_MS); a run that cut step 1 at 60 s
     * and called the provider dead had already watched that same provider answer
     * step 0.
     */
    const budgetFor = (retry: boolean): number =>
      retry ? RETRY_FIRST_OUTPUT_MS : FIRST_OUTPUT_TIMEOUT_MS;

    // ─── Live reasoning status ───
    // The reasoning block is display-capped (MAX_THOUGHT_CHARS), so past that
    // cap nothing on screen moves while the model keeps thinking — which is
    // indistinguishable from a freeze, and was reported as one. This line keeps
    // ticking for as long as reasoning streams: elapsed time, how much, and the
    // fact that no action has been taken yet.
    let reasoningStartedAt = 0;
    let reasoningStatusId: string | null = null;
    let statusStopped = false;
    const statusTicker = setInterval(() => {
      if (statusStopped || reasoningStartedAt === 0 || thoughtChars === 0) return;
      const seconds = Math.round((performance.now() - reasoningStartedAt) / 1000);
      const text = `Reasoning… ${seconds}s · ${thoughtChars.toLocaleString()} chars · no action yet`;
      if (!reasoningStatusId) {
        reasoningStatusId = nextId();
        emit({ kind: "entry", entry: { id: reasoningStatusId, role: "system", text } });
      } else {
        emit({ kind: "patch", id: reasoningStatusId, text });
      }
    }, 2000);

    // ─── Planner-wait ticker ───
    // A cold free-tier planner can legitimately take ~55-90s on its first turn
    // while it streams chain-of-thought, and even warm turns can take tens of
    // seconds. Silence for that long is indistinguishable from a frozen run,
    // so after a short grace window a live status line appears and ticks every
    // second. Once reasoning tokens actually arrive the live reasoning block
    // takes over as the liveness indicator and this line hands off to it. A
    // turn that starts producing output within the grace window never emits
    // the line at all.
    let waitStart = performance.now();
    let waitEntryId: string | null = null;
    let waitSettled = false;
    const waitTimer = setInterval(() => {
      if (waitSettled) return;
      const seconds = Math.round((performance.now() - waitStart) / 1000);
      if (opened) {
        // Narration is rendering — the panel is visibly alive. Finalize the
        // line (if it ever appeared) and stop ticking.
        if (waitEntryId) {
          waitSettled = true;
          emit({ kind: "patch", id: waitEntryId, text: `Planner started responding after ${seconds}s.` });
        }
        clearInterval(waitTimer);
        return;
      }
      if (seconds * 1000 < 5_000) return;
      // "no tokens yet" on its own reads as a frozen panel, and the reported
      // complaint about this line was exactly that: a status telling the user
      // nothing they can act on while a slow provider streams nothing. Past the
      // grace window it says who is late and what the way out is. A turn that
      // has produced NOTHING gets cut at the first-output budget regardless
      // (see withTurnBudget), so this is not a hang the user has to sit out.
      const thought = thoughtChars > 0
        ? ` · model is reasoning (${thoughtChars.toLocaleString()} chars so far)`
        : seconds >= 30
          ? ` · no tokens yet — the provider has not sent its first token (Stop cancels)`
          : " · no tokens yet";
      const text = `Waiting on the planner — ${seconds}s${thought}`;
      if (!waitEntryId) {
        waitEntryId = nextId();
        emit({ kind: "entry", entry: { id: waitEntryId, role: "system", text } });
      } else {
        emit({ kind: "patch", id: waitEntryId, text });
      }
    }, 1000);
    const settleWait = (outcome: "responded" | "failed" | "cancelled"): void => {
      waitSettled = true;
      clearInterval(waitTimer);
      // Finalize the reasoning status line: it must stop ticking when the turn
      // ends, and it must say how long the thinking actually took.
      statusStopped = true;
      clearInterval(statusTicker);
      if (reasoningStatusId && reasoningStartedAt > 0) {
        const seconds = Math.round((performance.now() - reasoningStartedAt) / 1000);
        emit({
          kind: "patch",
          id: reasoningStatusId,
          text: `Model reasoned for ${seconds}s (${thoughtChars.toLocaleString()} chars) before this turn ended.`,
        });
      }
      // Final flush, then collapse the reasoning block — the turn is over and
      // the transcript should hand attention back to actions and answers.
      flushPending();
      if (thoughtEntryId !== null) {
        emit({ kind: "patch", id: thoughtEntryId, text: "", pending: false });
      }
      if (!waitEntryId || outcome === "cancelled") return;
      const seconds = Math.max(1, Math.round((performance.now() - waitStart) / 1000));
      emit({
        kind: "patch",
        id: waitEntryId,
        text: outcome === "responded"
          ? `Planner responded in ${seconds}s.`
          : `Planner gave no usable response in ${seconds}s.`,
      });
    };

    const runPlannerTurn = async (turnAbort: AbortController, liveness: TurnLiveness, isRetry = false) =>
      withTurnBudget(
        planner.run({
          system: systemPrompt,
          messages,
          tools: TOOLS,
          signal: mergeAbort(signal, turnAbort.signal),
          onText: (delta) => {
            // Any streamed output proves the turn is alive and resets the
            // silence window — a slow reasoner must not be killed for being
            // thorough, only for being dead.
            liveness.lastEventAt = performance.now();
            liveness.events++;
            // …and it joins the degeneration tail. This channel is where the
            // reported runaway arrived: NIM/Llama models stream
            // chain-of-thought through delta.content, so a content-channel loop
            // scores zero on the reasoning signal.
            recordStreamedOutput(liveness, delta);
            onText(delta);
          },
          onThought: (delta) => {
            liveness.lastEventAt = performance.now();
            liveness.events++;
            recordStreamedOutput(liveness, delta);
            liveness.reasoningChars += delta.length;
            if (liveness.reasoningStartedAt === 0) {
              liveness.reasoningStartedAt = performance.now();
              reasoningStartedAt = liveness.reasoningStartedAt;
            }
            thoughtChars += delta.length;
            // The first reasoning token ends the wait ticker's job: the live
            // stream below is now the liveness indicator.
            if (waitEntryId !== null && !waitSettled) {
              waitSettled = true;
              clearInterval(waitTimer);
              emit({ kind: "patch", id: waitEntryId, text: "Planner is reasoning — streamed live below." });
            }
            if (!thoughtTruncated) {
              thoughtPending += delta;
              ensureFlushTimer();
            }
          },
        }),
        liveness,
        {
          firstOutputMs: budgetFor(isRetry),
          idleMs: STREAM_IDLE_TIMEOUT_MS,
          maxMs: MAX_TURN_MS,
          maxReasoningChars: MAX_REASONING_CHARS,
          maxReasoningMs: MAX_REASONING_MS,
          onTimeout: () => turnAbort.abort(),
          messageFor: (reason, liveness, waitedMs) =>
            turnCutShortMessageFor(planner.label, reason, liveness, waitedMs, budgetFor(isRetry)),
        },
      );

    // ─── AGENT EGRESS GUARD ───
    // Before any message payload leaves for an external LLM endpoint,
    // verify that zero raw secrets from the vault are escaping in the prompt.
    for (const msg of messages) {
      if (typeof (msg as any).content === "string") {
        (msg as any).content = tokenizer.redactValues((msg as any).content);
      }
      if (msg.role === "tool") {
        for (const res of msg.results) {
          if (typeof res.content === "string") {
            res.content = tokenizer.redactValues(res.content);
          }
        }
      }
    }

    let turn;
    let firstTurnLiveness: TurnLiveness = newTurnLiveness();
    try {
      turn = await runPlannerTurn(new AbortController(), firstTurnLiveness);
      endpointServedThisRun = true;
      settleWait("responded");
    } catch (firstError) {
      if (signal.aborted) { settleWait("cancelled"); finishTask(); return; }
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      // A ceiling cut is not a transient hiccup: the turn WAS streaming and we
      // stopped it for taking too long, so a retry re-sends the same prompt to
      // the same slow model and gets cut the same way. Retrying it is what
      // turned "this model reasons slowly" into an endless "retrying once…"
      // loop with the run never reaching a terminal state.
      // A salad cut joins the ceiling and loop cuts: the model was answering
      // and what it answered was unusable, so re-sending the same prompt buys
      // the same garbage. Only a genuine silence is worth one retry.
      const policy = retryPolicyFor(firstTurnLiveness, firstMessage, {
        endpointProvenThisRun: endpointServedThisRun,
      });
      const deliberated = firstTurnLiveness.ended === "deliberation";

      // A deliberation cut is steered, not failed: the model has everything it
      // needs and is stuck analysing instead of acting, so the next turn is the
      // same conversation plus an explicit "act now" directive. Only if it
      // deliberates AGAIN does the run stop (and then the message says why).
      let steered = false;
      if (deliberated && deliberationSteers === 0) {
        deliberationSteers++;
        steered = true;
        emit({
          kind: "entry",
          entry: {
            id: nextId(),
            role: "system",
            text:
              `The planner reasoned for a long time without acting (${firstTurnLiveness.reasoningChars.toLocaleString()} chars). ` +
              `Telling it to act on what it already has…`,
          },
        });
        messages.push({ role: "user", content: ACT_NOW_DIRECTIVE });
      } else if (!policy.retry) {
        settleWait("failed");
        errorCount++;
        // Say WHY the prompt was not re-sent. The failure text alone ("...the
        // network stalled or the connection dropped") invites exactly the wrong
        // conclusion on a stall that was really throughput, and the user's next
        // move depends on knowing which it was.
        const failureText = policy.because ? `${firstMessage} (${policy.because})` : firstMessage;
        // A collapse cut has the same display problem as the final-answer guard
        // further down: the deltas were already painted into the answer card, so
        // the transcript would show the glitch as PRY's answer directly above a
        // notice saying it is not an answer. Discard it first.
        if (
          opened &&
          (firstTurnLiveness.ended === "salad" || firstTurnLiveness.ended === "degenerate")
        ) {
          emit({ kind: "patch", id: entryId, replace: true, text: DISCARDED_STREAM_NOTE });
        }
        emit({
          kind: "entry",
          entry: { id: nextId(), role: "error", text: failureText },
        });
        finishTask();
        return;
      } else {
        // Transient stall (never produced a token, or the stream went quiet) —
        // one automatic retry before giving up. The wait ticker deliberately
        // keeps ticking across the retry: from the user's point of view this is
        // still one continuous planner wait.
        emit({
          kind: "entry",
          entry: {
            id: nextId(),
            role: "system",
            text: `Planner stalled (${firstMessage.slice(0, 120)}) — retrying once…`,
          },
        });
      }
      // Start a fresh wait line for the retry. Patching the first attempt's
      // line made the transcript read backwards: the collapsed line said "gave
      // no usable response in 180s" while sitting ABOVE the "retrying" notice
      // that came after it.
      waitEntryId = null;
      waitStart = performance.now();
      try {
        // The retry gets the short budget — see `runPlannerTurn`'s `isRetry`.
        turn = await runPlannerTurn(new AbortController(), newTurnLiveness(), true);
        endpointServedThisRun = true;
        settleWait("responded");
      } catch (secondError) {
        if (signal.aborted) { settleWait("cancelled"); finishTask(); return; }
        settleWait("failed");
        errorCount++;
        emit({
          kind: "entry",
          entry: {
            id: nextId(),
            role: "error",
            text:
              (secondError instanceof Error ? secondError.message : String(secondError)) +
              (steered
                ? " It was told to act on what it already had and still did not converge — make the step smaller, or switch to a faster model (Groq openai/gpt-oss-20b)."
                : " Retried once and failed again — switch to a faster provider/model (Groq openai/gpt-oss-20b) in the options and rerun."),
          },
        });
        finishTask();
        return;
      }
    } finally {
      // Flush any remaining buffered narration so the card always ends complete.
      flushPending();
      if (flushTimer !== null) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
    }

    // ─── Join the previous action's audit-only frame pipeline ───
    //
    // The wait is free HERE and only here: the pipeline was started right after
    // the previous action, and this line runs after the planner turn that
    // overlapped it. Joining it where it is started — which is what this code
    // used to do implicitly by awaiting the capture inline — is what serialised
    // local pixel work with every planner call.
    //
    // The flushed line describes the PREVIOUS step's frame, so it is labelled
    // as such when it is handed to the planner below.
    carriedFrameNote = await joinFrameAudit();

    // Replay is clamped: whatever the model wrote comes back to it on every
    // later turn, so an unbounded monologue is paid for repeatedly — and a
    // model that already rambled will happily continue its own ramble. Turns
    // that end the run (no tool calls) never reach this line, so a real answer
    // is never truncated.
    messages.push({
      role: "assistant",
      text: clampAssistantTextForHistory(turn.text),
      toolCalls: turn.toolCalls,
    });

    // Narration was display-capped above. Tool-call turns stay short (the
    // step card already says what happened); final answers deliver the rest
    // so nothing the user asked for is ever cut off. Only append when what was
    // shown is a true prefix of the full redacted answer — otherwise the seam
    // would duplicate text. When narration never opened the card (all
    // whitespace flushes), a patch would target a node the panel does not
    // have and the answer would be silently dropped — open the card instead.
    // A turn that produced glitch text instead of language must never be
    // presented as the answer. The watchdog above catches this while the turn is
    // still streaming; this catches a salad that finished before a tick, and it
    // is what keeps a run from reporting a task it never performed as finished
    // (the live shape: zero tool calls, a wall of punctuation, "Task ended.").
    if (turn.stopReason !== "refusal" && turn.toolCalls.length === 0 && isWordSalad(turn.text)) {
      errorCount++;
      // The stream reached the panel as it arrived, so a card may already be
      // showing the glitch as PRY's answer — with a Copy button. Replace it: the
      // run is about to say this text is not an answer, and leaving it on screen
      // would be the transcript contradicting itself.
      if (opened) {
        emit({ kind: "patch", id: entryId, replace: true, text: DISCARDED_STREAM_NOTE });
      }
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text:
            `The planner (${planner.label}) answered with text that is not language — ` +
            `${nonLatinLetterScripts(turn.text).length} scripts mixed into punctuation fragments — ` +
            `so it is not shown as the task's result. No action was taken on the page this turn. ` +
            `Rerun, or switch to a steadier model (Groq openai/gpt-oss-20b) in the options.`,
        },
      });
      reportUndeliveredFrameNote();
      finishTask();
      return;
    }

    // A FINAL ANSWER THAT NARRATES THE LOOP is refused for the same reason the
    // glitch text above is: it is not a result, and presenting it as one tells
    // the user the task ended when what actually happened was the model talking
    // to itself. See finalAnswerComplaint — the guard checks for the loop's own
    // vocabulary, not for writing quality.
    const loopNarration =
      turn.stopReason !== "refusal" && turn.toolCalls.length === 0
        ? finalAnswerComplaint(turn.text)
        : null;
    if (loopNarration) {
      errorCount++;
      if (opened) {
        emit({ kind: "patch", id: entryId, replace: true, text: DISCARDED_STREAM_NOTE });
      }
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text:
            `The planner (${planner.label}) answered with a note about its own loop ` +
            `("${loopNarration}") rather than a result, so it is not shown as this task's ` +
            `answer. The page is where the transcript says it is; rerun the step, or check ` +
            `the page and ask again.`,
        },
      });
      reportUndeliveredFrameNote();
      finishTask();
      return;
    }

    if (turn.stopReason !== "refusal" && turn.toolCalls.length === 0) {
      const full = tokenizer.redactValues(turn.text);
      if (full.trim()) {
        if (!opened) {
          opened = true;
          emittedText = full.slice(0, MAX_NARRATION_CHARS);
          emit({ kind: "entry", entry: { id: entryId, role: "assistant", text: emittedText } });
          const remainder = full.slice(emittedText.length);
          if (remainder) emit({ kind: "patch", id: entryId, text: remainder });
        } else if (full.length > emittedText.length && full.slice(0, emittedText.length) === emittedText) {
          const remainder = full.slice(emittedText.length);
          if (remainder) emit({ kind: "patch", id: entryId, text: remainder });
        }
      }
    }

    if (turn.stopReason === "refusal") {
      errorCount++;
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: `The model declined this request (${turn.refusal ?? "unspecified"}).`,
        },
      });
      reportUndeliveredFrameNote();
      finishTask();
      return;
    }

    // No tools left to call — the model has given its final answer. This turn
    // has no tool result to carry the joined frame evidence (see the join
    // above), so it is reported here instead of being dropped.
    if (turn.toolCalls.length === 0) {
      finalAnswerGiven = true;
      reportUndeliveredFrameNote();
      finishTask();
      return;
    }

    const results: ToolOutcome[] = [];

    for (const call of turn.toolCalls) {
      // Stop must unwind through finishTask (vault clear, running=false,
      // experience emit) — a bare return freezes the panel on RUNNING forever.
      // The joined frame evidence has not been handed to a planner turn yet at
      // this point, so it is reported rather than lost with the run.
      if (signal.aborted) { reportUndeliveredFrameNote(); finishTask(); return; }

      const stepId = nextId();

      emit({
        kind: "entry",
        entry: {
          id: stepId,
          role: "step",
          action: call.name as never,
          text: describeIntent(call.name, call.input),
          pending: true,
        },
      });

      // Gate runs AFTER token resolution (below) so the value-level secret
      // checks see the real resolved value, not the <CRED_1> token the model
      // was shown. Gating the tokenized input would let a secret ride through
      // the value patterns and be typed into the page. Element-credential
      // detection still works on the tokenized snapshot (name/role/attrs never
      // carry the value), so moving resolution first loses nothing.

      // VALIDATE: reject element IDs the client never sent, and ids whose read
      // is no longer the page's. When stale, auto-receive and inject a fresh
      // snapshot to save an LLM round trip.
      let idGeneration = lastRenderedGeneration;
      const elementId = call.input.element_id;
      if (typeof elementId === "number") {
        // The id refers to a read the model was shown. Existence is NOT enough
        // to trust it: ids are positional indices, so "element 3" can exist in
        // both the old and the new read while naming two different controls.
        // What makes the number safe is (a) that it came from the CURRENT read,
        // or (b) that the element at that index is still the same control.
        const intended = lastRenderedElements.find((e) => e.id === elementId);
        let current = snapshot?.elements.find((e) => e.id === elementId);
        const sameRead =
          snapshot?.generation === undefined || snapshot.generation === idGeneration;

        if (!current) {
          // Gone from the page entirely. Re-perceive so the answer carries
          // current ids, and so a remap has something to match against.
          const freshSnapshot = await controller.snapshot();
          if (freshSnapshot) {
            const { sanitized: freshSanitized } = sanitizeSnapshot(freshSnapshot, sanitizeCtx);
            snapshot = freshSanitized;
            // For free-tier: skip offscreen elements entirely for speed.
            if (isFreeTier) {
              snapshot = { ...snapshot, elements: snapshot.elements.filter((e) => !e.attrs?.offscreen) };
            }
            if (snapshot.elements.length > maxSnapshotElements) {
              const vis = snapshot.elements.filter((e) => !e.attrs?.offscreen);
              const off = snapshot.elements.filter((e) => e.attrs?.offscreen);
              snapshot = { ...snapshot, elements: [...vis, ...off].slice(0, maxSnapshotElements), truncated: true };
            }
          }

          current = snapshot?.elements.find((e) => e.id === elementId);
        }

        // Same number, DIFFERENT control. This is the silent mis-target: the
        // page re-rendered between the read and the action, the number now sits
        // on another element, and acting on it would report success for
        // something nobody asked for.
        const drifted =
          current !== undefined &&
          intended !== undefined &&
          !sameRead &&
          (current.role !== intended.role || current.name !== intended.name);

        if (!current || drifted) {
          // One-shot auto-retry: if exactly ONE element in the current read
          // matches what the model meant by role+name, remap and execute it
          // right away — this is the "model clicked the same video three times"
          // failure mode, and it should never cost an extra LLM round trip.
          // Ambiguous matches (0 or 2+) fall through to the refusal instead.
          const canRemap =
            call.name === "click" || call.name === "type" || call.name === "select";
          const matches = intended && snapshot && canRemap
            ? snapshot.elements.filter((e) => e.role === intended.role && e.name === intended.name)
            : [];
          const staleRemapped = matches.length === 1;
          if (staleRemapped) {
            call.input.element_id = matches[0].id;
            idGeneration = snapshot?.generation ?? idGeneration;
          }

          if (!staleRemapped) {
            const freshRendered = snapshot ? renderSnapshot(snapshot) : "(no snapshot available)";
            // The refusal names BOTH meanings of the number: "element 3 was not
            // found" would send the planner hunting for a missing element when
            // the real problem is that #3 is a different control now.
            const refusal = drifted
              ? `Element ${elementId} is a different control now: it was a ${intended!.role} named ` +
                `${JSON.stringify(intended!.name)}, but the current page has a ${current!.role} named ` +
                `${JSON.stringify(current!.name)} at that number. Element numbers are positional and the ` +
                `page changed since it was read, so the action was refused rather than risk acting on ` +
                `the wrong element. Here are the current elements — pick the right one and retry:`
              : `Element ${elementId}${intended ? ` (${intended.role} ${JSON.stringify(intended.name)})` : ""} ` +
                `is no longer on the page. Here are the current elements — pick the right one and retry:`;
            emit({
              kind: "patch",
              id: stepId,
              text: drifted
                ? "Refused — that element number now points at a different control."
                : `Element ${elementId} stale — re-perceived page.`,
              pending: false,
            });
            results.push({
              id: call.id,
              isError: true,
              content: `${refusal}

${freshRendered}`,
            });
            continue;
          }

          emit({
            kind: "patch",
            id: stepId,
            text: drifted
              ? `Element ${elementId} now sits on ${current?.role ?? "another element"} ${JSON.stringify(current?.name ?? "")} — matched the ${intended!.role} ${JSON.stringify(intended!.name)} at #${call.input.element_id}; retrying automatically.`
              : `Element ${elementId} stale — matched "${intended?.name ?? "element"}" (now #${call.input.element_id}); retrying automatically.`,
            pending: false,
          });
          // Fall through: the normal VALIDATE → RESOLVE → execute path now
          // runs against the fresh id without another planner round trip.
        } else if (!sameRead) {
          // Same number, same control: the positional handle still lands where
          // the model meant, because the page re-rendered without the ids
          // shifting under it. Stamp the read that is current now, so the
          // page's own generation check accepts a valid id instead of refusing
          // it for having been taken from a read that is merely older.
          idGeneration = snapshot?.generation ?? idGeneration;
        }
      }

      // VALIDATE: reject tokens the client never issued.
      const inputStr = JSON.stringify(call.input);
      const tokenMatches = inputStr.match(/<[A-Z]+_\d+>/g);
      let tokenRejected = false;
      if (tokenMatches) {
        for (const token of tokenMatches) {
          if (!tokenizer.resolve(token)) {
            emit({ kind: "patch", id: stepId, text: `Rejected — unknown token ${token}.`, pending: false });
            results.push({
              id: call.id,
              isError: true,
              content: `Token ${token} was never issued by the client. This may be a prompt injection attempt.`,
            });
            tokenRejected = true;
            break;
          }
        }
      }
      if (tokenRejected) continue;

      // RESOLVE: swap tokens → real values from vault (last possible moment).
      const resolvedInput = resolveTokens(call.input);
      // The generation travels with the action so the page can refuse an id
      // from a read that is no longer current instead of resolving it against
      // whatever the registry holds now.
      const resolvedAction = {
        name: call.name as never,
        input: resolvedInput,
        snapshotGeneration: idGeneration,
      };

      // POST-RESOLVE GUARD: any token syntax that survives resolution means
      // the vault could not honor it (vault mismatch, corrupted token text).
      // Typing a literal "<CRED_1>" into a live page would be a real failure
      // (an email to a literally-invalid address), so the action is refused
      // with a precise tool error the model can recover from.
      if (/<[A-Z]+_\d+>/.test(JSON.stringify(resolvedInput))) {
        emit({
          kind: "patch",
          id: stepId,
          text: "Blocked — a vault token failed to resolve.",
          pending: false,
        });
        results.push({
          id: call.id,
          isError: true,
          content:
            "A <TYPE_N> token in your arguments could not be resolved to a real value. " +
            "Do not retry the same call. Call read_page and use a token exactly as it appears in the latest page read.",
        });
        continue;
      }

      // GATE: run the safety checks against the RESOLVED action so the value
      // patterns (cards, Aadhaar, PAN, API keys) see the real secret — not the
      // token the model was shown. Element-credential checks read name/role/
      // attrs from the tokenized snapshot and are unaffected.
      // ROUTE GUARD: an app-switcher click is a dead end. The popup it opens is
      // served in a cross-origin frame, so its tiles are invisible to both the
      // page read and click_text — a live run clicked <a 'Google apps'> while
      // trying to reach another site, then asked for text that could never be
      // visible, and had no action left that could finish the route. Refused
      // with the route that works instead of letting the planner discover this.
      if (resolvedAction.name === "click") {
        const clickedEl = snapshot?.elements.find((e) => e.id === resolvedAction.input.element_id);
        const routeRefusal = appSwitcherRefusal(clickedEl?.name);
        if (routeRefusal) {
          emit({ kind: "patch", id: stepId, text: "Blocked — use a direct navigate instead.", pending: false });
          results.push({ id: call.id, content: routeRefusal, isError: true });
          continue;
        }
      }

      const decision = gate(resolvedAction, snapshot, settings.confirmRisky);

      if (decision.verdict === "refuse") {
        emit({ kind: "patch", id: stepId, text: `Blocked — ${decision.reason}`, pending: false });
        results.push({ id: call.id, content: decision.reason, isError: true });
        continue;
      }

      if (decision.verdict === "confirm") {
        const approved = await askConfirm(stepId, decision.summary);
        if (!approved) {
          emit({ kind: "patch", id: stepId, text: "Declined by user.", pending: false });
          results.push({
            id: call.id,
            isError: true,
            content:
              "The user declined this action. Do not retry it. Ask them what they want instead, or continue with the rest of the task.",
          });
          continue;
        }
      }

      recordAction(call.name, call.input);
      const actionStart = performance.now();
      let outcome: Awaited<ReturnType<typeof execute>>;
      try {
        outcome = await execute(controller, resolvedAction);
      } catch (err) {
        // An action-level failure (e.g. the page navigated mid-click and the
        // channel closed) must not kill the run: report it as a tool error
        // and let the planner re-read the page.
        const detail = err instanceof Error ? err.message : String(err);
        trackedActions.push({
          tool: call.name,
          success: false,
          latencyMs: Math.round(performance.now() - actionStart),
          strategy: "llm",
          error: detail,
          cause: classifyFailure(detail),
        });
        results.push({
          id: call.id,
          isError: true,
          content: `The action did not complete: ${detail}. Call read_page and continue from the page's current state.`,
        });
        errorCount++;
        emit({ kind: "patch", id: stepId, text: "Action failed — recovering.", pending: false });
        continue;
      }
      const actionLatency = performance.now() - actionStart;
      controller = outcome.controller;
      const { result } = outcome;

      // Re-tokenize the executed detail before it can reach the model, the
      // transcript, or stored memory — raw resolved values must not leak back.
      const safeDetail = tokenizer.redactValues(result.detail);

      // Track action for experience memory.
      trackedActions.push({
        tool: call.name,
        success: result.ok,
        latencyMs: actionLatency,
        strategy: "llm",
        error: result.ok ? undefined : safeDetail,
        cause: result.ok ? undefined : classifyFailure(result.detail),
      });

      // Record action in privacy ledger.
      ledgerRecordAction(call.name, result.ok, typeof call.input.element_id === "number" ? call.input.element_id : undefined).catch(() => {});

      emit({ kind: "patch", id: stepId, text: safeDetail, pending: false });

      // After a type+submit that triggers navigation, wait for the page to
      // finish loading before re-perceiving. Without this, the agent reads
      // stale DOM (e.g., YouTube homepage) instead of search results.
      const didNavigate = call.name === "type" && call.input.submit === true && result.ok;
      if (didNavigate) {
        await controller.waitForLoad();
      }

      // Verify: re-perceive after anything that could have changed the page,
      // then apply the privacy pipeline to the fresh snapshot.
      let observation = safeDetail;

      // Evidence from the PREVIOUS action's frame, joined after this turn's
      // planner call (see the join above). Handed over once, on the first tool
      // result of the turn, and labelled with the step it actually describes —
      // the snapshot below it is from THIS step, and a reader that mixed the
      // two would take the frame for the wrong moment.
      if (carriedFrameNote) {
        observation = `${carriedFrameNote}\n\n${observation}`;
        carriedFrameNote = "";
      }
      // Read-only actions cannot change pixels, and a re-capture is the most
      // expensive thing this loop does (see actionChangesFrame).
      const mayHaveChanged = actionChangesFrame(call.name);

      if (mayHaveChanged) {
        const fresh = result.snapshot ?? (await controller.snapshot());
        if (fresh) {
          const navigated = snapshot && fresh.url !== snapshot.url;
          snapshot = fresh;

          // Tier-0 models are per-page: re-score THIS page before it is
          // sanitized, or a name on the new page is neither tokenized for the
          // planner nor black-boxed in the screenshot that follows.
          await refreshTier0(fresh.text);

          // Apply privacy pipeline to fresh snapshot (checksum validation +
          // learned false-positive suppression included).
          const { sanitized, piiCount, detections: freshDetections, suppressed: freshSuppressed, rejected: freshRejected, piiTargets: freshPiiTargets } = sanitizeSnapshot(snapshot, sanitizeCtx);
          snapshot = sanitized;
          lastDomDetections = freshDetections;
          setActivePiiTargets(freshPiiTargets);

          // Truncate fresh snapshots to avoid context overflow.
          if (isFreeTier) {
            snapshot = { ...snapshot, elements: snapshot.elements.filter((e) => !e.attrs?.offscreen) };
          }
          if (snapshot.elements.length > maxSnapshotElements) {
            const vis = snapshot.elements.filter((e) => !e.attrs?.offscreen);
            const off = snapshot.elements.filter((e) => e.attrs?.offscreen);
            snapshot = { ...snapshot, elements: [...vis, ...off].slice(0, maxSnapshotElements), truncated: true };
          }
          piiPageItems += piiCount;
          reportCurrentTally();

          // Track PII detections from fresh snapshot.
          for (const det of freshDetections) {
            trackedPII.push({
              kind: det.kind,
              method: det.method,
              outcome: "true_positive",
              confidence: det.confidence,
            });
          }

          // Measured false positives from the fresh snapshot (rule + checksum).
          for (const fp of freshSuppressed) {
            firedRuleKeys.add(`${fp.kind}:${fp.method}`);
            noteFalsePositive(fp.kind, fp.method, fp.confidence, fp.value);
          }
          for (const rj of freshRejected) noteFalsePositive(rj.kind, rj.method, rj.confidence, rj.value);

          warnIfInjected(fresh, emit);

          // Capture screenshot after page change (if available).
          //
          // TWO WAITING POLICIES, and the difference is only who reads the
          // result:
          //
          //   VISION ON — the frame (or the VLM's description of it) is what
          //   the next turn reasons about, so the chain is awaited here.
          //
          //   VISION OFF (the default) — not one byte of this frame reaches
          //   the planner. The work is local evidence: the ledger, the audit
          //   panel, the run's PII totals and its re-OCR leak findings. It is
          //   STARTED and left to run in parallel with the planner turn that
          //   follows, then joined after that turn returns (see the join below
          //   the assistant push) — because awaiting it here is what put
          //   1.2-6.5 s of local pixel work in front of every page-changing
          //   step's planner call.
          const frameGoesToPlanner = frameNeedsPlannerWait({
            visionEnabled,
            hasVisionKey: visionApiKey !== "",
            aborted: signal.aborted,
            frameOverran: frameWaitOverran,
          });
          if (captureScreenshot) {
            if (frameGoesToPlanner) {
              const awaited = await awaitFrame(
                runFrameAudit(freshDetections, observation, FRAME_LABEL_AWAITED),
              );
              if (awaited.kind === "done" && awaited.value) observation = awaited.value.observation;
              if (awaited.kind === "timeout") noteFrameTimeout("after this action");
            } else {
              // Vision is on and there IS a key, so the only reason this frame
              // is not awaited is that the previous one blew the budget. Say so
              // once: the user asked for vision, and a run that quietly stopped
              // using it would be a feature switched off behind their back.
              if (visionEnabled && visionApiKey && !signal.aborted && !announcedFrameWaitAbandoned) {
                announcedFrameWaitAbandoned = true;
                emit({
                  kind: "entry",
                  entry: {
                    id: nextId(),
                    role: "system",
                    text:
                      `Frame capture is not keeping up with the planner on this page — it missed the ` +
                      `${Math.round(FRAME_AUDIT_WAIT_MS / 1000)}s budget, and waiting for it again would ` +
                      `stall every action. Continuing with page reads; each frame still arrives as ` +
                      `redaction evidence one step later, but without a visual description. ` +
                      `Turn visual perception off in Options if you do not want to pay for it.`,
                  },
                });
              }
              startFrameAudit(freshDetections, FRAME_LABEL_DEFERRED);
            }
          }

          if (piiCount > 0) {
            observation +=
              `\n\n--- Page after this action (redacted ${piiCount} PII) ---\n` +
              renderSnapshot(snapshot);
          } else {
            observation +=
              (navigated ? "\n\nThe page navigated." : "") +
              `\n\n--- Page after this action ---\n${renderSnapshot(snapshot)}`;
          }
        }
      }

      results.push({ id: call.id, content: observation, isError: !result.ok });
    }

    // Prune stale DOM snapshots from earlier tool results.
    // The planner only needs the *latest* page state; retaining multiple historical DOM dumps
    // causes massive egress bloat (>100KB), exhausting provider rate limits and stalling inference.
    //
    // An action that changed the page produced a fresher read than the one the
    // run opened with, which makes that opening read stale — and it lives in
    // messages[0], which the loop below never touches because it only walks
    // tool results. So a multi-turn run carried TWO full page renders on every
    // turn where one was current. Prune it only when a fresher read genuinely
    // exists: a read-only action (find_text, wait) renders nothing, so there the
    // opening read is still the planner's only view of the page.
    if (results.some((r) => r.content.includes("\n\n--- Page after this action"))) {
      const opening = messages[0];
      if (opening && opening.role === "user" && opening.content.includes("\n\n--- Current page ---")) {
        opening.content = openingContext + OPENING_PAGE_OMITTED + openingVisionNote;
      }
    }

    for (const msg of messages) {
      if (msg.role === "tool") {
        for (const res of msg.results) {
          if (res.content.includes("\n\n--- Page after this action")) {
            res.content = res.content.replace(
              /\n\n--- Page after this action[\s\S]*$/,
              "\n\n[Previous page snapshot omitted — see latest read]",
            );
          }
        }
      }
    }

    messages.push({ role: "tool", results });
  }

  // The step cap ended the run, which is the one exit that can arrive while an
  // audit-only frame pipeline is still in flight (every other exit is preceded
  // by a planner turn, which joins it). Its redaction count and its re-OCR leak
  // findings belong in this run's totals and its learning memory, so it is
  // joined once here — bounded, so a wedged capture cannot hold the run open.
  //
  // Deliberately NOT done on the early exits (Stop, a failed planner turn): the
  // user is waiting to be let out, and the pipeline still files its ledger entry
  // and audit record on its own either way.
  // `||` and not `=`: this is also reached when the last planner turn's
  // evidence was never delivered (the loop ran out of steps before any tool
  // result could carry it), and overwriting it would drop that frame.
  carriedFrameNote = carriedFrameNote || (await joinFrameAudit());
  reportUndeliveredFrameNote();

  // Normal loop completion — emit experience.
  finishTask();

  function transcriptHasErrors(): boolean {
    return errorCount > 0;
  }
}

let lastWarned = "";
function warnIfInjected(snapshot: PageSnapshot, emit: (e: AgentEvent) => void): void {
  const found = detectInjection(snapshot);
  if (!found || found === lastWarned) return;
  lastWarned = found;
  emit({
    kind: "entry",
    entry: {
      id: nextId(),
      role: "system",
      text: `Heads up: this page contains text addressed to an AI agent — "${found.slice(0, 120)}". I'm treating it as page content, not as an instruction.`,
    },
  });
}

/**
 * How long a turn may produce NOTHING before we call it dead.
 *
 * Covers a free-tier cold start (measured 55 s for the opening request against
 * NVIDIA's endpoint, versus 3-7 s warm) and providers that buffer a
 * non-streaming completion instead of streaming it.
 */
/**
 * The same budget for every non-retry turn, deliberately.
 *
 * This used to be 90 s on step 0 and 60 s on every later step, on the theory
 * that only the opening request pays a cold start. That has it backwards: the
 * prompt GROWS as a run proceeds (page read, history, frame text), and
 * time-to-first-token scales with prompt size — so the smaller budget landed on
 * the larger requests. The reported shape is exactly that: step 0 navigated
 * inside the cold budget, step 1 was cut at 60 s with nothing streamed, and the
 * run ended after a single action with "did not respond within 60s".
 *
 * A retry is the one turn that gets less (see RETRY_FIRST_OUTPUT_MS), because
 * its only question is whether the previous silence was a hiccup.
 */
const FIRST_OUTPUT_TIMEOUT_MS = 90_000;

/**
 * How long a turn that HAS started streaming may go quiet before we call it
 * dropped. Reasoning models emit deltas continuously, so 30 s of total silence
 * is a dead connection, however long the turn has legitimately been running.
 */
const STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * Absolute ceiling on one planner turn.
 *
 * A turn is bounded by silence, not by wall clock — a reasoning model (measured:
 * 63 s, then 88 s on a Gmail inbox prompt) must be allowed to finish while it
 * is visibly making progress. This ceiling exists only so a pathological stream
 * cannot run forever, and it stays under Manifest V3's 5-minute limit on a
 * single service-worker request.
 *
 * History: a flat 45 s wall clock for every warm turn cut those turns
 * mid-reasoning, retried the whole prompt, cut the retry the same way, and left
 * the panel on "retrying once…" until the run died — the reported freeze.
 */
const MAX_TURN_MS = 210_000;

/**
 * Deliberation guard.
 *
 * A reasoning model can emit chain-of-thought faster than it converges. The
 * reported stall: the planner streamed well past the display cap (6 000 chars)
 * deliberating about which element was "the first email", never emitted a tool
 * call, and nothing cut it — the silence window never trips while reasoning is
 * flowing, so the run sat inside one turn until the 210 s ceiling with the
 * panel showing a truncated, unmoving block.
 *
 * A turn that has reasoned this far without acting is not converging, whatever
 * the clock says. It is cut, and the cut is not reported as a failure: the next
 * turn carries a directive telling the model to act with what it already has.
 * The thresholds sit at 2× the display cap / 90 s so a genuinely deep but
 * productive turn is not interrupted.
 */
const MAX_REASONING_CHARS = 12_000;
const MAX_REASONING_MS = 90_000;
/** Below this, a long turn is slow rather than over-deliberating — let it run. */
const MIN_REASONING_CHARS_FOR_TIME_CUT = 1_000;

/**
 * What an answer card says once its stream has been ruled not-language.
 *
 * Streamed text is painted into the card as it arrives, so by the time either
 * guard (the watchdog's cut, or the final-answer check) can rule on it, the wall
 * of fragments is already on screen where the answer belongs — with a Copy
 * button. This replaces it, because a transcript that prints the glitch and then
 * explains it was not an answer is still showing it as one.
 */
const DISCARDED_STREAM_NOTE =
  "The model's output was discarded — it was punctuation and mixed-script fragments " +
  "rather than language, so it is not an answer to this task. See the notice below.";

/**
 * Degeneration guard.
 *
 * A small model on a long prompt does not fail loudly, it LOOPS. The reported
 * failure against `nvidia/nemotron-3.5-lightning-30b-a3b` on a Gmail tab: a
 * 100 s turn whose output collapsed into "can make it one big things. can make
 * it. 0 1 can make it one. And can one big things." for thousands of
 * characters. Nothing already in this budget could see it:
 *
 *   - deltas kept arriving, so the silence window never tripped;
 *   - the deliberation caps sit at 12 000 reasoning chars and only count the
 *     `onThought` channel — this model streams its chain-of-thought through
 *     `delta.content` as well (see the note on MAX_NARRATION_CHARS), so a
 *     content-channel ramble scored zero on the deliberation signal;
 *   - the run then presented the loop to the user as the answer, spoke it,
 *     and re-sent it in the next turn's history.
 *
 * Duration cannot distinguish a thorough model from a looping one, and neither
 * can plain repetition frequency: a legitimate table dump really does reuse the
 * same phrases, and a first attempt at this guard that counted every repeated
 * word 4-gram flagged a 250-word table of near-identical rows as a runaway.
 *
 * Two signals, because loops come in two shapes and neither alone is enough.
 * Both are measured in the harness against the verbatim reported output, PRY's
 * system prompt, long narration, and an adversarial table:
 *
 *   1. SHORT CYCLE — the same few words come back a handful of words later,
 *      over and over. A repeat only counts when the same 4-gram recurs within
 *      DEGENERATION_CYCLE_MAX_WORDS of its last occurrence. The real runaway
 *      repeats a ~6-word cycle and scores 0.65-0.9; the table dump, whose rows
 *      are ~22 words apart, scores 0, and the system prompt scores 0.
 *   2. REPEATED BLOCK — some LONG verbatim stretch appears three or more times
 *      in the window. This catches a loop with a long period, which signal 1
 *      deliberately ignores: with a 22-word cycle every 4-gram repeat sits
 *      outside the short-cycle window, so a model re-emitting the same
 *      paragraph word-for-word would slip through. Three copies of a 40-word
 *      block is 120 words of byte-identical text, which no legitimate answer
 *      produces — and a table, whose rows differ in at least their leading
 *      value, does not either.
 */
const DEGENERATION_WINDOW_CHARS = 4_000;
/** Shorter than this and the ratio is noise, not evidence. */
const DEGENERATION_MIN_WORDS = 120;
const DEGENERATION_REPEAT_RATIO = 0.5;
const DEGENERATION_GRAM = 4;
/** Longest gap, in words, at which a 4-gram repeat still reads as a cycle. */
const DEGENERATION_CYCLE_MAX_WORDS = 16;
/** Length of the long verbatim block signal 2 looks for. */
const DEGENERATION_BLOCK_WORDS = 40;
/** How many copies of that block mark the turn as looping. */
const DEGENERATION_BLOCK_OCCURRENCES = 3;
/** Punctuation share at or above which output is measured for word salad. */
const DEGENERATION_SALAD_PUNCT_DENSITY = 0.25;
/** Distinct non-Latin scripts that mark a sample as salad rather than prose. */
const DEGENERATION_SALAD_SCRIPTS = 3;
/**
 * Script changes per adjacent word pair at or above which output is churning.
 *
 * This is what catches the SECOND observed shape, which the punctuation rule
 * cannot see at all. Verbatim from the reported run: "… which after multiplier -
 * c s some ( campus. a Mari pluted assay d _, c focused through automatic ( used
 * at T [ on cumul WH Image phone behind one in mode …" — 110 words, only 0.081
 * punctuation (a legitimate code block scores 0.210, so that signal is not just
 * weak here, it is inverted), but CJK, Arabic and Greek letters alternating with
 * Latin WORD BY WORD.
 *
 * Measured on every sample available, including the legitimate ones this must not
 * fire on: the two glitches switch scripts on 13.1% and 9.2% of adjacent pairs, the
 * bilingual English/Hindi/Arabic answer on 4.8% (its switches land on sentence
 * boundaries), and every single-script sample — prose, a markdown table, minified
 * JSON, a code block, four Latin languages, PRY's own 1 853-word system prompt — on
 * 0.0%.
 *
 * The gap is real but not wide (9.2% against 4.8%), which is why this rule ALSO
 * requires three non-Latin scripts — see `isWordSalad`. A threshold doing all the
 * work on its own would be one glitch sample away from cutting a legitimate
 * multilingual answer.
 */
const SALAD_SCRIPT_SWITCH_RATE = 0.06;
/**
 * Word floor for the churn rule, well below the punctuation rule's 120.
 *
 * Switching scripts every other word is not something text does, so this needs
 * far less material to be sure of — but it must still clear the floor that keeps
 * a short fragment quoting two foreign names out of scope.
 */
const SALAD_CHURN_WORDS = 60;

/**
 * Longest assistant text replayed to the planner as history.
 *
 * The model's own words come back to it every turn, so an unbounded monologue
 * is paid for on EVERY subsequent turn — both in prompt tokens and in the
 * model's tendency to continue what it already wrote. A real answer never ends
 * up here (a turn with no tool calls ends the run); this bounds narration
 * before a tool call, which is meant to be one line.
 */
export const MAX_HISTORY_TEXT_CHARS = 1_200;

/** The recent tail of a stream, capped so the degeneration scan stays cheap. */
export function tailOf(text: string, windowChars: number = DEGENERATION_WINDOW_CHARS): string {
  return text.length <= windowChars ? text : text.slice(text.length - windowChars);
}

/**
 * Append a streamed delta to the liveness record's rolling tail.
 *
 * Exported so the window's behaviour is pinned by the harness rather than
 * inferred from the loop: the check must see the END of the stream, so the
 * oldest characters are the ones dropped.
 */
export function recordStreamedOutput(liveness: TurnLiveness, delta: string): void {
  liveness.outputTail = tailOf(liveness.outputTail + delta);
}

/**
 * The repeated fraction a loop produces: exits for the harness to report.
 *
 * Words are normalised to letters/digits so punctuation and casing cannot hide
 * a cycle, and the return value is the share of positions whose 4-gram came
 * back within the short-cycle window.
 */
export function degenerationRatio(text: string): number {
  const words = normaliseWords(text);
  if (words.length < DEGENERATION_GRAM) return 0;

  const lastSeen = new Map<string, number>();
  let repeats = 0;
  let total = 0;
  for (let i = 0; i + DEGENERATION_GRAM <= words.length; i++) {
    const gram = words.slice(i, i + DEGENERATION_GRAM).join(" ");
    total++;
    const previous = lastSeen.get(gram);
    if (previous !== undefined && i - previous <= DEGENERATION_CYCLE_MAX_WORDS) repeats++;
    lastSeen.set(gram, i);
  }
  return total === 0 ? 0 : repeats / total;
}

/**
 * True when the window contains the same long verbatim block several times.
 *
 * The long-period signal: a model re-emitting a paragraph word-for-word. It is
 * deliberately exact and long, so a table of similar rows — which differs in at
 * least one value per row — cannot trigger it.
 */
export function hasRepeatedBlock(text: string): boolean {
  const words = normaliseWords(text);
  if (words.length < DEGENERATION_BLOCK_WORDS * DEGENERATION_BLOCK_OCCURRENCES) return false;
  const counts = new Map<string, number>();
  for (let i = 0; i + DEGENERATION_BLOCK_WORDS <= words.length; i++) {
    const block = words.slice(i, i + DEGENERATION_BLOCK_WORDS).join(" ");
    const seen = (counts.get(block) ?? 0) + 1;
    if (seen >= DEGENERATION_BLOCK_OCCURRENCES) return true;
    counts.set(block, seen);
  }
  return false;
}

/** Lowercased letters/digits only — punctuation and casing cannot hide a loop. */
function normaliseWords(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True when streamed output has collapsed into a repetition loop.
 *
 * Pure, and deliberately conservative: it needs a long-enough sample (120
 * words) AND one of the two signals above, so a long final answer, a code
 * block, or a table of near-identical rows is not misread as a runaway — see
 * the adversarial cases in the harness.
 */
export function isDegenerateOutput(text: string): boolean {
  const words = normaliseWords(text);
  if (words.length < DEGENERATION_MIN_WORDS) return false;
  return degenerationRatio(text) >= DEGENERATION_REPEAT_RATIO || hasRepeatedBlock(text);
}

/**
 * Share of characters that are neither letters, digits nor whitespace.
 *
 * Prose runs a few percent, a dense code block about 0.17, a markdown table
 * about the same. Text that is mostly punctuation is not being written in any
 * language, which is the failure this measures.
 */
export function punctuationDensity(text: string): number {
  const s = String(text ?? "");
  if (s.length === 0) return 0;
  const punct = (s.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
  return punct / s.length;
}

/**
 * Which letter scripts a sample uses, ignoring Latin and its accented forms.
 *
 * Accented Latin (`é`, `ñ`, `ł`) is ordinary European prose and is deliberately
 * not counted — a French or Polish answer is one language, not several. The
 * buckets are the big non-Latin blocks: Devanagari, Arabic, CJK/kana/Hangul,
 * Greek, Cyrillic.
 */
export function nonLatinLetterScripts(text: string): string[] {
  const buckets = new Set<string>();
  for (const ch of String(text ?? "")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x7f || !/\p{L}/u.test(ch)) continue;
    if (cp >= 0x0900 && cp <= 0x097f) buckets.add("devanagari");
    else if (cp >= 0x0600 && cp <= 0x06ff) buckets.add("arabic");
    else if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    ) buckets.add("cjk");
    else if (cp >= 0x0370 && cp <= 0x03ff) buckets.add("greek");
    else if (cp >= 0x0400 && cp <= 0x04ff) buckets.add("cyrillic");
  }
  return [...buckets];
}

/**
 * True when output has broken down into glitch text rather than language.
 *
 * This is a DIFFERENT failure from the repetition loop above, and the guard that
 * catches loops cannot see it: a live run against
 * `nvidia/nemotron-3.5-lightning-30b-a3b` streamed 45 updates of "…people, ))
 * land, ), λ, łu, …", which has a repetition ratio of 0.000 — every 4-gram
 * unique — so `isDegenerateOutput` returned false, the turn was accepted as the
 * final answer, and the run reported the task ended. The task had not been
 * started (no tool call was ever made).
 *
 * Two independent conditions, both measured on the real sample and on the
 * legitimate outputs an agent actually produces (prose, a markdown table, a
 * code block, minified JSON, four Latin languages, a two-script translation
 * answer):
 *
 *   - punctuation density ≥ 0.25 — the sample is a quarter punctuation, versus
 *     0.16 for the worst legitimate sample measured;
 *   - letters from ≥ 3 non-Latin scripts — the sample is simultaneously
 *     Devanagari, Arabic, CJK and Greek, which no single answer written by
 *     anyone or any model is. Legitimate multilingual answers measured 0-2.
 *
 * Requiring BOTH is what keeps a table of pipes (0 scripts) and a minified JSON
 * blob (0.49 punctuation, 0 scripts) out of it, while the observed salad scores
 * 0.42 and 4. It needs the same 120-word floor, so a short fragment can never
 * trigger it.
 */
export function isWordSalad(text: string): boolean {
  const words = normaliseWords(text).length;
  const scripts = nonLatinLetterScripts(text).length;

  // Three non-Latin scripts is the load-bearing condition, and it is the one both
  // rules share: no answer written by a person or a model mixes three writing
  // systems in one response, and every legitimate sample in the battery reaches
  // two at most (the bilingual English/Hindi/Arabic paragraph reaches two, and
  // that is exactly the sample the alternative rules had to be measured against).
  // What the rules below add is WHICH way the mixture shows up.
  if (scripts < DEGENERATION_SALAD_SCRIPTS) return false;
  if (words < SALAD_CHURN_WORDS) return false;

  // 1. Script churn — the second observed shape. It is made of real-looking words
  //    with the writing system changing from word to word: 9.2% of adjacent pairs
  //    here against 4.8% for the bilingual sample, whose switches land on sentence
  //    boundaries because that is where a person changes language.
  if (scriptSwitchRate(text) >= SALAD_SCRIPT_SWITCH_RATE) return true;

  // 2. Punctuation soup — the first observed shape, kept exactly as measured: a
  //    quarter punctuation, three or more scripts, at least 120 words.
  if (words < DEGENERATION_MIN_WORDS) return false;
  if (punctuationDensity(text) < DEGENERATION_SALAD_PUNCT_DENSITY) return false;
  return true;
}

/**
 * Phrases in which an answer narrates the agent's OWN loop: a future or absent
 * tool call, a reply that has not arrived, the conversation ending.
 *
 * Deliberately narrow, and deliberately only about the loop. This guard cannot
 * judge coherence and does not try to — an under-constrained "does this read
 * well?" heuristic would refuse real answers, which is worse than shipping a
 * rambling one. What it can recognise with certainty is an answer written from
 * inside the loop: a reply to the user never discusses its own tool protocol.
 *
 * The shape is taken verbatim from the reported run, whose entire result was:
 *
 *   "The task was to \"open yt\", which I interpret as opening YouTube. I
 *    navigated to youtube.com and then clicked on the first video result. The
 *    user's task was simply \"open yt\", which I've got no response yet (this
 *    will be the last tool call for a while)"
 *
 * Past-tense talk about tools is NOT caught ("I used click_text to open it" is a
 * normal way to report a result); what is caught is the loop talking to itself.
 */
const LOOP_NARRATION_PATTERNS: RegExp[] = [
  // "(this will be the last tool call for a while)"
  /\b(?:last|next|final)\s+(?:tool|function)\s+call\b/i,
  // "which I've got no response yet", "no reply yet from the model"
  /\bno\s+(?:response|reply|answer)\s+yet\b/i,
  // "this will be the last turn", "I'll answer in the next turn"
  /\b(?:last|next)\s+turn\b/i,
];

/**
 * Why this text must not be shown as the task's result, or null when it may.
 *
 * Returns the offending phrase so the notice the user reads can quote what
 * tripped it instead of asserting a verdict they cannot check.
 */
export function finalAnswerComplaint(text: string): string | null {
  const value = String(text ?? "");
  if (value.trim().length === 0) return null;
  for (const pattern of LOOP_NARRATION_PATTERNS) {
    const match = pattern.exec(value);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

/**
 * Share of adjacent word pairs whose dominant script differs.
 *
 * Words with no letters at all are skipped rather than counted as a change, so a
 * table of pipes or a JSON blob (which is mostly punctuation between words) stays
 * at 0. Exported for the harness: the threshold above only means anything next to
 * the measurements it separates.
 */
export function scriptSwitchRate(text: string): number {
  const SCRIPT_RE =
    /([\u0900-\u097f])|([\u0600-\u06ff])|([\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af])|([\u0370-\u03ff])|([A-Za-z])/u;
  const SCRIPT_NAMES = ["devanagari", "arabic", "cjk", "greek", "latin"];
  const dominant = (word: string): string => {
    const m = SCRIPT_RE.exec(word);
    if (!m) return "";
    const index = m.findIndex((group, i) => i > 0 && group !== undefined);
    return SCRIPT_NAMES[index - 1] ?? "";
  };

  const scripts = String(text ?? "").split(/\s+/).filter(Boolean).map(dominant);
  let pairs = 0;
  let switches = 0;
  for (let i = 1; i < scripts.length; i++) {
    if (!scripts[i] || !scripts[i - 1]) continue;
    pairs++;
    if (scripts[i] !== scripts[i - 1]) switches++;
  }
  return pairs === 0 ? 0 : switches / pairs;
}

/**
 * Clamp assistant text before it is replayed as conversation history.
 *
 * Truncation happens on a word boundary and is announced, so the model is
 * never handed half a word and never mistakes a cut for things it did not
 * write. Whitespace-only text collapses to "" (nothing to replay).
 */
export function clampAssistantTextForHistory(
  text: string,
  maxChars: number = MAX_HISTORY_TEXT_CHARS,
): string {
  const raw = String(text ?? "").trim();
  if (raw.length <= maxChars) return raw;
  const cut = raw.slice(0, maxChars);
  const boundary = cut.lastIndexOf(" ");
  const kept = boundary > maxChars * 0.5 ? cut.slice(0, boundary) : cut;
  return `${kept.trimEnd()} …[truncated for length]`;
}

/**
 * What the steered turn is told. Short, imperative, and it names the two
 * handles this situation actually needs: act now, and use click_text when the
 * target has no element id (which is the usual reason for the deliberation in
 * the first place).
 */
export const ACT_NOW_DIRECTIVE =
  "You have spent too long reasoning without acting. Stop deliberating and act now: " +
  "respond with exactly ONE tool call, or with a short final answer if the task is already complete. " +
  "Use what you already have — do not re-read the page to look for something again. " +
  "If the thing you need to click has no element id (inbox rows, search results, list items, " +
  "cards, menu entries usually have none), call click_text with the exact visible text of the target.";

/**
 * Stall/transient failure classifiers — these warrant one automatic retry.
 * Everything else (bad model, rejected key, malformed request) is not retried.
 */
export function isRetryablePlannerError(message: string): boolean {
  // A provider that never produced a single token inside the full silence
  // budget is not a dropped connection — it is a provider that cannot serve
  // this request in time. Retrying re-sends the identical prompt and spends the
  // same window again: measured on NVIDIA NIM, two 90 s silent attempts in a
  // row produced nothing but a 180 s dead wait before the same error. Report it
  // once, with the actionable advice, and let the user switch models.
  // (Mid-stream silence is different — see the "stopped streaming" wording —
  // and transport/status failures below are still worth one retry.)
  //
  // That measurement was taken on an endpoint that had answered nothing yet.
  // The same silence AFTER a turn of this run succeeded is judged in
  // `retryPolicyFor`, which holds both facts; this string check remains for the
  // callers that see only the message, and for the genuinely unproven endpoint.
  if (/did not respond within/i.test(message)) return false;
  return /rate.?limit|timed? ?out|network|fetch failed|econn|overloaded|temporarily|503|429|502|504|timeout|stopped streaming/i.test(
    message,
  );
}

/**
 * Live evidence that a planner turn is making progress.
 *
 * Every streamed delta (narration or reasoning) records itself here. The budget
 * uses it to tell the two very different failures apart — a provider that never
 * answers, and a model that is answering slowly — which the old flat wall clock
 * could not, and which is why a healthy 88 s turn was killed at 45 s.
 */
interface TurnLiveness {
  /** Timestamp of the last streamed delta. */
  lastEventAt: number;
  /** Number of deltas this turn has produced. */
  events: number;
  /** Reasoning characters streamed this turn (the deliberation signal). */
  reasoningChars: number;
  /** When reasoning started; 0 while the turn has produced none. */
  reasoningStartedAt: number;
  /**
   * Rolling tail of everything this turn has streamed, whichever channel it
   * arrived on. The degeneration guard reads it: a content-channel ramble is
   * invisible to `reasoningChars`, and this is the only signal that catches one.
   */
  outputTail: string;
  /** How the turn ended; the retry policy reads this. */
  ended: "settled" | "silent" | "ceiling" | "deliberation" | "degenerate" | "salad";
  /**
   * How long the turn ran before it was cut, in ms (0 while it is still going).
   *
   * The retry policy needs this to tell the two silences apart: an endpoint that
   * answered and then stopped is a throughput problem, while one that never said
   * anything is a dropped connection. Both look identical in `events`.
   */
  endedAfterMs: number;
}

export function newTurnLiveness(): TurnLiveness {
  return {
    lastEventAt: performance.now(),
    events: 0,
    reasoningChars: 0,
    reasoningStartedAt: 0,
    outputTail: "",
    ended: "settled",
    endedAfterMs: 0,
  };
}

/**
 * How long a turn must have been running before a mid-stream silence stops
 * being a hiccup and starts being throughput.
 *
 * A dropped connection dies early — the socket is gone before much has crossed
 * it. An endpoint that delivered output for this long and then stalled is telling
 * you it cannot serve the request at this speed, and re-sending the same prompt
 * to it spends another full budget to be told the same thing. The reported run:
 * 148 s of streaming, a 30 s silence, then a retry that produced nothing for 90 s
 * — 268 s and zero actions for a task that could have failed at 178 s.
 */
const LONG_STALL_MS = 45_000;

/**
 * The first-output budget a RETRY gets, deliberately far shorter than a cold
 * start's.
 *
 * A retry exists to answer one question — was that a dropped connection or a
 * provider that cannot serve this request? — and a hiccup answers it in seconds.
 * Re-spending the cold 90 s budget does not gather evidence.
 */
export const RETRY_FIRST_OUTPUT_MS = 20_000;

/**
 * Whether a failed turn deserves the one automatic retry, and why not when it
 * does not.
 *
 * Pure and exported because this policy has been the source of two reported
 * failures already (an endless "retrying once…" on a slow model, and a stall
 * retried until the user gave up), and a decision stated only inside a `catch`
 * block cannot be pinned by a test.
 *
 * `deliberation` is absent on purpose: it is a STEER, not a failure, and the loop
 * handles it before reaching here.
 *
 * `endpointProvenThisRun` is the distinction a first-output timeout needs and
 * that the message alone cannot carry. "The provider never sent a token" is the
 * documented reason not to retry — that measurement was two 90 s silent attempts
 * in a row producing nothing — but it was taken on an endpoint that had not
 * answered anything at all. A turn that streams nothing right AFTER the same
 * endpoint answered a previous turn of this run is a different animal: the key,
 * model and network are known good seconds ago, so the silence is likelier to be
 * this request than the provider. Refusing to retry that case is what ended the
 * reported run after a single action — step 0 navigated, step 1 was silent, and
 * the task stopped with "switch to a faster provider" while holding the evidence
 * that the provider was fine.
 */
export function retryPolicyFor(
  liveness: TurnLiveness,
  message: string,
  opts: {
    /**
     * True when a previous turn of THIS run produced output. Evidence about the
     * endpoint, not about the turn being judged — which is why it is passed in
     * rather than derived from `liveness`.
     */
    endpointProvenThisRun?: boolean;
  } = {},
): { retry: boolean; because: string } {
  if (
    liveness.ended === "ceiling" ||
    liveness.ended === "degenerate" ||
    liveness.ended === "salad"
  ) {
    return {
      retry: false,
      because: "the turn was cut while it was still answering, so the prompt is not re-sent",
    };
  }
  if (liveness.ended === "silent" && liveness.events > 0 && liveness.endedAfterMs >= LONG_STALL_MS) {
    return {
      retry: false,
      because:
        `the endpoint streamed for ${Math.round(liveness.endedAfterMs / 1000)}s before going quiet — ` +
        `throughput rather than a dropped connection, so the prompt is not re-sent`,
    };
  }
  if (liveness.ended === "silent" && liveness.events === 0) {
    // Nothing streamed at all. Two cases, told apart by evidence the message
    // cannot hold: has this endpoint answered anything in this run?
    if (opts.endpointProvenThisRun) {
      return {
        retry: true,
        because: "",
      };
    }
    return {
      retry: false,
      because:
        "this endpoint had not answered anything in this run, and re-sending the same prompt to an " +
        "unresponsive one was measured to buy a second silence rather than a reply",
    };
  }
  if (!isRetryablePlannerError(message)) return { retry: false, because: "" };
  return { retry: true, because: "" };
}

/**
 * Failure text for a turn we cut short, chosen so the retry policy reads it
 * correctly. Exported (and pure) so the harness can pin the classification:
 *
 *   - `silent` keeps the "did not respond" / "network stalled" wording that
 *     `isRetryablePlannerError` treats as a transient hiccup worth one retry;
 *   - `ceiling` deliberately contains NO such keyword, because a turn stopped
 *     while it was still streaming is not a hiccup — the retry would re-send the
 *     same prompt to the same slow model and be stopped identically, which is
 *     exactly how a slow reasoning model produced an endless "retrying once…"
 *     loop instead of an actionable error;
 *   - `degenerate` is the same shape of failure reached faster: the model WAS
 *     answering, it just stopped saying anything new, so a retry re-sends the
 *     prompt that caused the loop. Its wording therefore avoids every retry
 *     keyword too, and names the model choice as the fix.
 */
export function turnCutShortMessageFor(
  plannerLabel: string,
  reason: "silent" | "ceiling" | "deliberation" | "degenerate" | "salad",
  liveness: TurnLiveness,
  waitedMs: number,
  firstOutputBudgetMs: number,
): string {
  const waited = Math.round(waitedMs / 1000);
  if (reason === "salad") {
    // Retry keywords are deliberately absent, for the same reason the loop cut
    // avoids them: the model WAS answering, and what it answered was unusable,
    // so re-sending the prompt buys the same text back.
    return (
      `The planner (${plannerLabel}) stopped writing language after ${waited}s — the output was ` +
      `punctuation and mixed-script fragments rather than sentences, so the turn was cut before the ` +
      `rest of the run inherited it. This is a model failure on a prompt this size, so the prompt is ` +
      `not re-sent and no action was taken. Rerun, or switch to a steadier model ` +
      `(Groq openai/gpt-oss-20b) in the options.`
    );
  }
  if (reason === "degenerate") {
    return (
      `The planner (${plannerLabel}) collapsed into a repetition loop after ${waited}s — it was ` +
      `producing text but nothing new, so the turn was stopped before the rest of the run ` +
      `inherited it. This is a model failure on a prompt this size, so the prompt is not ` +
      `re-sent and the loop is not carried into the next turn. Rerun, or switch to a ` +
      `steadier model (Groq openai/gpt-oss-20b) in the options.`
    );
  }
  if (reason === "deliberation") {
    // Deliberately free of the retry keywords: this is not a transient
    // hiccup, it is the model not converging. The caller steers instead of
    // treating it as a network event.
    return (
      `The planner (${plannerLabel}) reasoned for ${waited}s and wrote ` +
      `${liveness.reasoningChars.toLocaleString()} characters of analysis without taking a single action, ` +
      `so the turn was stopped. It is being told to act with what it already has. ` +
      `If it deliberates again, the honest read is that this prompt is too open for this model — ` +
      `switch to a faster provider (Groq openai/gpt-oss-20b) or make the step smaller.`
    );
  }
  if (reason === "ceiling") {
    return (
      `The planner (${plannerLabel}) was still streaming after ${waited}s and was stopped. ` +
      `This model reasons slowly for a prompt this size — switch to a faster provider ` +
      `(Groq openai/gpt-oss-20b) in the options, or break the task into smaller steps.`
    );
  }
  if (liveness.events > 0) {
    const silent = Math.round(Math.max(0, performance.now() - liveness.lastEventAt) / 1000);
    // Deliberately does NOT say "the network stalled or the connection dropped".
    // Which of the two this was is decided by the retry policy from evidence the
    // message builder does not have (how long the turn had been streaming), and it
    // is appended there. Guessing here produced a line that argued with itself:
    // "…went silent for 30s — the network stalled or the connection dropped.
    // (the endpoint streamed for 97s before going quiet — throughput rather than a
    // dropped connection, so the prompt is not re-sent)".
    return (
      `The planner (${plannerLabel}) stopped streaming after ${liveness.events} update(s) and ` +
      `went quiet for ${silent}s.`
    );
  }
  return (
    `The planner (${plannerLabel}) did not respond within ${Math.round(firstOutputBudgetMs / 1000)}s. ` +
    `The provider may be overloaded or the network stalled.`
  );
}

/**
 * Resolve a promise unless the turn goes dead first, in which case call
 * `onTimeout` (to cancel the underlying request) and reject.
 *
 * Two phases, because a cold provider and a slow reasoner look different:
 *   - before any output: `firstOutputMs` covers a cold start or a buffered
 *     completion;
 *   - after output started: only silence is a failure, `idleMs` of it.
 * `maxMs` bounds the whole turn. The original promise's later settle is
 * absorbed so nothing is unhandled.
 */
/**
 * Whether a frame captured after an action must be COMPLETE before the next
 * planner turn, or may run alongside it.
 *
 * The question is not "is the pipeline important" — it always is — but "who
 * reads its output next":
 *
 *   - VISION ON: the redacted frame, or the VLM's description of it, is what
 *     the next turn reasons about, so the pipeline is on the critical path and
 *     must finish first.
 *   - VISION OFF (the default): nothing about the frame reaches the planner.
 *     The output is local evidence — the ledger entry, the audit panel, the
 *     run's PII totals and its re-OCR leak findings — and it is joined after
 *     the planner turn instead of in front of it.
 *
 * Pure and exported so both halves are pinned by the harness. The "vision on"
 * direction is the load-bearing one: deferring an awaited frame would hand the
 * planner a description of a screen from before the action it just took.
 */
export function frameNeedsPlannerWait(input: {
  visionEnabled: boolean;
  hasVisionKey: boolean;
  aborted: boolean;
  /**
   * True once a frame this run waited on did NOT arrive inside the wait budget.
   *
   * The wait is a bet that local pixel work finishes before the planner needs
   * the next turn, and it is a good bet at the cost the pipeline was measured at
   * (1.2 s for a 1× viewport, up to 6.5 s at the triage cap). It is a bad bet
   * when the pipeline cannot make that: after the face pass gained its native-
   * resolution crops, its verification and its escalation, a heavy page can want
   * longer than the budget on EVERY action — and the bet then costs the user the
   * full 15 s in front of every planner call while delivering nothing, which is
   * exactly the "slow and stuck after every tool call" the run reported. So the
   * bet stops being placed after it has visibly lost: the frame is STARTED and
   * joined after the next turn instead, labelled as one step old, and the
   * transcript says so once. Nothing is dropped either way — the evidence line,
   * the ledger entry and the audit record are identical; only who waits changes.
   */
  frameOverran?: boolean;
}): boolean {
  return input.visionEnabled && input.hasVisionKey && !input.aborted && input.frameOverran !== true;
}

/**
 * Join deferred evidence that is not allowed to block if it misbehaves.
 *
 * Resolves with the work's value when it settles inside `timeoutMs`, and with
 * `null` when it does not — or when it fails, because a pipeline that throws
 * must never take the run down from a join site whose whole purpose is to fold
 * in a line of evidence. The caller keeps a handle to the work either way, so a
 * timeout only skips the LINE: the pipeline still finishes and still files its
 * own ledger entry and audit record.
 */
export async function joinEvidence<T>(pending: Promise<T | null>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      pending.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    // Never leave the safety-net timer behind: a live timer keeps a service
    // worker awake and, on the last join of a run, delays shutdown for nothing.
    if (timer !== null) clearTimeout(timer);
  }
}

export function withTurnBudget<T>(
  promise: Promise<T>,
  liveness: TurnLiveness,
  opts: {
    firstOutputMs: number;
    idleMs: number;
    maxMs: number;
    onTimeout: () => void;
    /** Cut a turn that reasons this much without acting (see the guard). */
    maxReasoningChars?: number;
    /** …or that reasons for this long, once it has said something substantial. */
    maxReasoningMs?: number;
    /** Set false to run a turn whose output is expected to repeat (tests). */
    detectDegeneration?: boolean;
    messageFor: (
      reason: "silent" | "ceiling" | "deliberation" | "degenerate" | "salad",
      liveness: TurnLiveness,
      waitedMs: number,
    ) => string;
  },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const startedAt = performance.now();
    let done = false;
    const finish = (
      reason: "silent" | "ceiling" | "deliberation" | "degenerate" | "salad",
      waitedMs: number,
    ): void => {
      done = true;
      clearInterval(ticker);
      liveness.ended = reason;
      liveness.endedAfterMs = waitedMs;
      opts.onTimeout();
      reject(new Error(opts.messageFor(reason, liveness, waitedMs)));
    };
    const ticker = setInterval(() => {
      const waited = performance.now() - startedAt;
      if (liveness.events === 0) {
        if (waited > opts.firstOutputMs) finish("silent", waited);
        return;
      }
      // A turn that has collapsed is not going to converge, and it is checked
      // FIRST so the user gets the junk stopped in seconds rather than sitting
      // through the 90 s deliberation cut or the 210 s ceiling — measured at
      // 100 s of rambling before this guard existed.
      //
      // It is also checked BEFORE the silence window, because the collapse is
      // the finding and any silence after it is a symptom. The reported shape:
      // 45 streamed updates of "…people, )) land, ), λ, łu, …" followed by 30 s
      // of quiet. The idle branch read the quiet first, called the turn a
      // stall, and — because mid-stream silence carries the retryable "stopped
      // streaming" wording — re-sent the prompt that had produced the glitch,
      // which produced it again. Reading the tail first turns that into one
      // salad cut with no retry.
      if (opts.detectDegeneration !== false) {
        // Word salad is checked before the loop because it is the failure the
        // loop guard cannot see at all: every 4-gram is unique, so a sample that
        // is pure glitch scores 0 on the repetition signal while it is
        // unmistakably not language. Telling the user "repetition loop" for that
        // would be a wrong explanation of a right cut.
        if (isWordSalad(liveness.outputTail)) {
          finish("salad", waited);
          return;
        }
        if (isDegenerateOutput(liveness.outputTail)) {
          finish("degenerate", waited);
          return;
        }
      }
      if (performance.now() - liveness.lastEventAt > opts.idleMs) {
        finish("silent", waited);
        return;
      }
      // A turn that keeps reasoning without acting is not converging. Checked
      // before the ceiling so the user gets the steer in ~90 s instead of
      // waiting out 210 s for the same outcome.
      const maxReasoningChars = opts.maxReasoningChars ?? MAX_REASONING_CHARS;
      const maxReasoningMs = opts.maxReasoningMs ?? MAX_REASONING_MS;
      if (liveness.reasoningChars >= maxReasoningChars) {
        finish("deliberation", waited);
        return;
      }
      const reasoningMs = liveness.reasoningStartedAt > 0
        ? performance.now() - liveness.reasoningStartedAt
        : 0;
      if (reasoningMs >= maxReasoningMs && liveness.reasoningChars >= MIN_REASONING_CHARS_FOR_TIME_CUT) {
        finish("deliberation", waited);
        return;
      }
      if (waited > opts.maxMs) finish("ceiling", waited);
    }, 500);
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearInterval(ticker);
        resolve(value);
      },
      (error) => {
        if (done) return;
        done = true;
        clearInterval(ticker);
        reject(error);
      },
    );
  });
}

/** Combine the user's Stop signal with a turn-local abort (falls back to the
 * user signal when AbortSignal.any is unavailable). */
function mergeAbort(userSignal: AbortSignal, turnSignal: AbortSignal): AbortSignal {
  return typeof AbortSignal.any === "function" ? AbortSignal.any([userSignal, turnSignal]) : userSignal;
}

/** UTF-8 byte length of a string (TextEncoder; falls back to char count). */
function estimateUtf8Bytes(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length;
  }
}

/** Human-readable byte count for the egress badge. */
function formatEgress(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

/**
 * RESOLVE: swap tokens → real values from vault.
 * Called at the last possible moment before action execution.
 * Recursively walks the input object to find and resolve any tokens.
 */
function resolveTokens(input: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      // Strip digit-concatenation corruption ("7<CRED_1>") BEFORE resolution
      // so the value typed into the page is exactly the vault value — a model
      // gluing a digit onto a token must not send "7shashank@gmail.com".
      resolved[key] = tokenizer.resolveAll(repairTokenConcatenation(value));
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      resolved[key] = resolveTokens(value as Record<string, unknown>);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function describeIntent(name: string, input: Record<string, unknown>): string {
  const reason = typeof input.reason === "string" ? input.reason : "";
  switch (name) {
    case "click":
      return reason || `Click element ${input.element_id}`;
    case "type":
      return reason || `Type into element ${input.element_id}`;
    case "navigate":
      return `Go to ${input.url}`;
    case "open_tab":
      return `Open ${input.url} in a new tab`;
    case "read_page":
      return "Read the page";
    case "click_text":
      return `Click "${String(input.text ?? "").slice(0, 60)}"`;
    case "type_text":
      return `Type into the field named "${String(input.field ?? "").slice(0, 60)}"`;
    case "scroll":
      return `Scroll ${input.direction}`;
    case "find_text":
      return `Look for "${input.query}"`;
    default:
      return reason || name.replace(/_/g, " ");
  }
}

export type { TranscriptEntry };
