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
import { SYSTEM_PROMPT, SYSTEM_PROMPT_LOCAL, taskPrompt } from "./prompt";
import { TOOLS, PAGE_ACTIONS } from "./tools";
import { TabController, execute, isRestricted } from "./executor";
import { detectInjection, gate } from "./safety";
import { detectAllPIIDetailed } from "./pii-detector";
import { redactSnapshot } from "./redaction";
import { tokenizer, repairTokenConcatenation } from "./tokenizer";
import { tryDeterministic } from "./deterministic";
import { createPlanner } from "./providers";
import type { ConvMessage, ToolOutcome } from "./providers/types";
import type { ActionExperience, PIIExperience, RunExperience } from "./experience-memory";
import { extractDomain, classifyPageType } from "./experience-memory";
import { detectContextualPII, contextualToDetectedPII } from "./contextual-pii";
import { getApplicableRules, buildSuppressionKeys, recommendsLLMOnly } from "./learned-rules";
import { piiKindFromOcrLabel } from "./reocr-verification";
import { observeWithVision, VISION_SUPPORTED, VISION_DEFAULT_MODELS } from "./vision";
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
    `Title: ${snapshot.title}`,
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
}

const EMPTY_SANITIZE_CTX: SanitizeCtx = { fpKeys: new Set(), llmOnly: false, ruleCount: 0 };

/** Readable audit label per PII kind (visual detections already carry theirs). */
const AUDIT_KIND_LABELS: Record<string, string> = {
  credential: "Credential (text)",
  id_number: "ID number (text)",
  api_key: "API key",
  pii_text: "PII text",
  face: "Face",
};

/** Map DOM sanitize detections into the audit shape so the proof view shows
 * what was actually tokenized/redacted from page text, not just visuals. */
function auditFromDetections(
  detections: Array<{ kind: string; confidence: number }>,
): Array<{ kind: string; label: string; confidence: number }> {
  return detections.map((d) => ({
    kind: d.kind,
    label: AUDIT_KIND_LABELS[d.kind] ?? d.kind,
    confidence: d.confidence,
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
  detections: Array<{ kind: string; method: string; confidence: number }>;
  suppressed: Array<{ kind: string; method: string; confidence: number; value?: string }>;
  rejected: Array<{ kind: string; method: string; confidence: number; value?: string }>;
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

  // 3. Tokenize the values the detectors actually flagged (names, emails,
  //    phones, ID numbers) so they become vault tokens the LLM can reference
  //    instead of raw values.
  const tokenized = tokenizer.tokenizeDetections(snapshot, allDetections);

  // 3b. Vault sweep: replace ANY remaining vault value in element values,
  //     names, or page text with its token — even on elements no detector
  //     flagged. Without this, a value the agent just typed into a field
  //     (e.g. an email in Gmail's compose To box, which sits outside the
  //     container pageText() reads) would ride raw into the next planner turn.
  const swept = tokenizer.redactVaultValuesInSnapshot({
    elements: tokenized.elements,
    text: tokenized.text,
  });

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
      elements,
      text,
    },
    piiCount: tokenized.tokenCount + redactedCount,
    detections: [
      ...keptRegex.map((d) => ({ kind: d.kind, method: "regex", confidence: d.confidence })),
      ...keptContextual.map((d) => ({ kind: d.kind, method: "contextual", confidence: d.confidence })),
    ],
    suppressed,
    rejected: detailed.rejected.map((r) => ({
      kind: r.kind,
      method: "checksum",
      confidence: r.confidence,
      value: r.value,
    })),
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
  captureScreenshot?: () => Promise<{
    original: string;
    processed: import("../shared/types").ProcessedScreenshotResult;
  } | null>;
  /** Record a privacy audit entry for the judges. */
  recordAudit?: (entry: {
    original?: string;
    redacted?: string;
    detections: Array<{ kind: string; label: string; confidence: number }>;
    tokens: Array<{ token: string; kind: string; sample?: string }>;
    redactedCount: number;
    verification?: VerificationResult;
  }) => void;
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
  const { settings, emit, askConfirm, signal, captureScreenshot, recordAudit } = deps;

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
  async function observeScreen(redactedDataUrl: string, fallback: string): Promise<string> {
    if (!visionEnabled || !visionApiKey) return fallback;
    const context = snapshot ? renderSnapshot(snapshot) : `URL: ${sanitizeUrl(tab.url ?? "")}`;
    try {
      const vision = await observeWithVision(
        settings.provider, visionModel, visionApiKey, redactedDataUrl, context, signal,
      );
      sessionEgressBytes += vision.bytes;
      estimatedTokens += Math.ceil(vision.bytes / 4);
      emit({ kind: "egress", bytes: sessionEgressBytes });
      return `${fallback}\n\n[VLM observation (${vision.model}): ${vision.text}]`;
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 140) : "vision unavailable";
      return `${fallback}\n\n[VLM observation unavailable: ${reason}]`;
    }
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

  // Apply privacy pipeline to initial snapshot.
  const pageType = classifyPageType(tab.url ?? "", tab.title ?? "", snapshot?.text ?? "");

  // ── Load learned rules for this (domain, page type). This is where the
  //    self-improvement loop is closed: rules stored by previous runs change
  //    what this run detects, suppresses, and how it plans.
  const applicableRules = await getApplicableRules(domain, pageType);
  const sanitizeCtx: SanitizeCtx = {
    fpKeys: buildSuppressionKeys(applicableRules),
    llmOnly: recommendsLLMOnly(applicableRules),
    ruleCount: applicableRules.length,
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

  let piiTotal = 0;
  // Latest DOM (text) detections for the audit view — the screenshots only
  // carry visual detections, so without this the proof panel hides the emails,
  // phones and ID numbers the DOM sanitizer actually tokenized.
  let lastDomDetections: Array<{ kind: string; confidence: number }> = [];
  if (snapshot) {
    // Record snapshot in privacy ledger.
    recordSnapshot(snapshot.url, snapshot.title, snapshot.elements.length).catch(() => {});

    const { sanitized, piiCount, detections, suppressed, rejected } = sanitizeSnapshot(snapshot, sanitizeCtx);
    snapshot = sanitized;
    lastDomDetections = detections;

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

    piiTotal += piiCount;

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
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "system",
          text: `Privacy: detected and redacted ${piiCount} sensitive item(s) from page context.`,
        },
      });
    }
  }

  // Capture initial screenshot through privacy pipeline (if available).
  if (captureScreenshot) {
    try {
      const screenshotResult = await captureScreenshot();
      if (screenshotResult) {
        const processed = screenshotResult.processed;
        const visualDetections = processed.detections.map((d) => ({
          kind: d.kind,
          label: d.label,
          confidence: d.confidence,
        }));
        const verification = processed.verification;
        noteVerification(verification);

        emit({
          kind: "entry",
          entry: {
            id: nextId(),
            role: "system",
            text:
              `Screenshot captured: ${processed.redactedCount} PII items redacted in ${processed.processingTimeMs.toFixed(0)}ms.` +
              (verification && verification.regionsChecked > 0 ? ` ${verification.summary}` : ""),
          },
        });

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
        piiTotal += processed.redactedCount;
        // Record for privacy audit — DOM textual detections AND visual ones,
        // so the panel shows every PII item this snapshot handled.
        recordAudit?.({
          original: screenshotResult.original,
          redacted: processed.redactedDataUrl,
          detections: [...visualDetections, ...auditFromDetections(lastDomDetections)],
          tokens: tokenizer.getTokenSummary(),
          redactedCount: processed.redactedCount,
          verification,
        });

        // Optional VLM vision: only the redacted screenshot leaves. Its
        // description rides in the first planner turn so the agent genuinely
        // sees the screen before planning a single action.
        if (visionEnabled && visionApiKey && !signal.aborted) {
          initialVisionNote = await observeScreen(processed.redactedDataUrl, "");
        }
      }
    } catch {
      // Screenshot capture is optional — DOM perception still works.
    }
  }

  // Tokenize PII in the user's task (same vault as page PII).
  // This ensures the LLM sees <ORG_3> in both the task and the page.
  const { task: tokenizedTask, tokenCount: taskTokenCount } = tokenizer.tokenizeTask(task);
  if (taskTokenCount > 0) {
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text: `Task privacy: tokenized ${taskTokenCount} PII item(s) in your request.`,
      },
    });
  }

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

  const messages: ConvMessage[] = [
    {
      role: "user",
      content:
        taskPrompt(tokenizedTask, sanitizeUrl(tab.url ?? ""), tab.title ?? "") +
        (snapshot ? `\n\n--- Current page ---\n${renderSnapshot(snapshot)}` : "") +
        (initialVisionNote ? `\n\n${initialVisionNote}` : ""),
    },
  ];
  lastRenderedElements = snapshot?.elements ?? [];

  if (snapshot) warnIfInjected(snapshot, emit);

  // ── Loop detection: track recent actions to break out of stuck states ──
  const recentActions: Array<{ name: string; input: string }> = [];
  const LOOP_THRESHOLD = 3;
  const LOOP_WINDOW = 5;

  function recordAction(name: string, input: Record<string, unknown>): void {
    recentActions.push({ name, input: JSON.stringify(input) });
    if (recentActions.length > LOOP_WINDOW) recentActions.shift();
  }

  function isLooping(): boolean {
    if (recentActions.length < LOOP_THRESHOLD) return false;
    // 1. Consecutive identical action
    const last = recentActions[recentActions.length - 1];
    let count = 0;
    for (let i = recentActions.length - 1; i >= 0; i--) {
      if (recentActions[i].name === last.name && recentActions[i].input === last.input) {
        count++;
      } else break;
    }
    if (count >= LOOP_THRESHOLD) return true;

    // 2. Oscillation detection (A -> B -> A -> B)
    if (recentActions.length >= 4) {
      const a1 = recentActions[recentActions.length - 1];
      const b1 = recentActions[recentActions.length - 2];
      const a2 = recentActions[recentActions.length - 3];
      const b2 = recentActions[recentActions.length - 4];
      if (
        a1.name === a2.name && a1.input === a2.input &&
        b1.name === b2.name && b1.input === b2.input
      ) {
        return true;
      }
    }
    return false;
  }

  // ── Cleanup: emit experience and clear vault on ANY exit path ──
  let experienceEmitted = false;
  function finishTask(): void {
    if (experienceEmitted) return;
    experienceEmitted = true;

    const hasSuccessfulActions = trackedActions.some((a) => a.success);
    taskSuccess = !transcriptHasErrors() && (hasSuccessfulActions || trackedActions.length === 0);

    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text:
          `Task ended. Total PII items redacted: ${piiTotal}. ` +
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
      task,
      domain,
      pageType,
      piiDetections: trackedPII,
      actions: trackedActions,
      taskSuccess,
      durationMs: Date.now() - runStartTime,
      piiRedacted: piiTotal,
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
  }

  for (let step = 0; step < settings.maxSteps; step++) {
    if (signal.aborted) { finishTask(); return; }

    // The model plans against the snapshot rendered in the previous turn.
    lastRenderedElements = snapshot?.elements ?? [];

    // Loop detection — if the agent is stuck repeating the same action, break.
    if (isLooping()) {
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: `Loop detected: repeated "${recentActions[recentActions.length - 1].name}" ${LOOP_THRESHOLD} times. Stopping to prevent infinite loop. The page may need manual interaction.`,
        },
      });
      finishTask();
      return;
    }

    // Deterministic planner: only on step 0 for simple one-shot tasks, and
    // only when a learned strategy rule has not flagged deterministic as a
    // failure mode for this page type.
    if (step === 0 && !sanitizeCtx.llmOnly) {
      const detResult = tryDeterministic(task, snapshot ?? null);
      if (detResult.resolved && detResult.action) {
        // Only use deterministic for non-navigate actions on step 0.
        // Navigate on step 0 is fine — the user explicitly said "go to X".
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

        const detDecision = gate(detResult.action, snapshot, settings.confirmRisky);
        if (detDecision.verdict === "allow") {
          recordAction(detResult.action.name, detResult.action.input);
          const detStart = performance.now();
          const detOutcome = await execute(controller, detResult.action);
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
        // If verdict is confirm/refuse, fall through to LLM.
      }
    }

    // Stream so the user sees reasoning as it arrives rather than staring at a
    // spinner for the length of a long turn.
    const entryId = nextId();
    let opened = false;

    const onText = (delta: string): void => {
      // Belt-and-braces: never let a raw vault value render in the transcript
      // even if one somehow reached the model's context.
      const safe = tokenizer.redactValues(delta);
      if (!opened) {
        opened = true;
        emit({ kind: "entry", entry: { id: entryId, role: "assistant", text: safe } });
      } else {
        emit({ kind: "patch", id: entryId, text: safe });
      }
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

    // Show that a planner call is in flight — a slow first token otherwise
    // looks like a freeze between the last log line and the first streamed text.
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text: `Consulting ${planner.label}…`,
      },
    });

    // One turn = one bounded planner call. Stalls (slow first token, dropped
    // stream, hung connection, rate limit) abort after TURN_TIMEOUT_MS and are
    // retried ONCE automatically — transient provider hiccups must not kill a
    // demo run. The turn-local abort cancels the request; the user's Stop wins.
    const plannerTimeoutMessage = `The planner (${planner.label}) did not respond within ${Math.round(TURN_TIMEOUT_MS / 1000)}s. The provider may be overloaded or the network stalled.`;
    const runPlannerTurn = async (turnAbort: AbortController) =>
      withTurnTimeout(
        planner.run({
          system: systemPrompt,
          messages,
          tools: TOOLS,
          signal: mergeAbort(signal, turnAbort.signal),
          onText,
        }),
        TURN_TIMEOUT_MS,
        plannerTimeoutMessage,
        () => turnAbort.abort(),
      );

    let turn;
    try {
      turn = await runPlannerTurn(new AbortController());
    } catch (firstError) {
      if (signal.aborted) { finishTask(); return; }
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      if (!isRetryablePlannerError(firstMessage)) {
        errorCount++;
        emit({
          kind: "entry",
          entry: { id: nextId(), role: "error", text: firstMessage },
        });
        finishTask();
        return;
      }
      // Transient stall — one automatic retry before giving up.
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "system",
          text: `Planner stalled (${firstMessage.slice(0, 120)}) — retrying once…`,
        },
      });
      try {
        turn = await runPlannerTurn(new AbortController());
      } catch (secondError) {
        if (signal.aborted) { finishTask(); return; }
        errorCount++;
        emit({
          kind: "entry",
          entry: {
            id: nextId(),
            role: "error",
            text:
              (secondError instanceof Error ? secondError.message : String(secondError)) +
              " Retried once and failed again — switch to a faster provider/model (Groq openai/gpt-oss-20b) in the options and rerun.",
          },
        });
        finishTask();
        return;
      }
    }

    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

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
      finishTask();
      return;
    }

    // No tools left to call — the model has given its final answer.
    if (turn.toolCalls.length === 0) { finishTask(); return; }

    const results: ToolOutcome[] = [];

    for (const call of turn.toolCalls) {
      if (signal.aborted) return;

      const action = { name: call.name as never, input: call.input };
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

      const decision = gate(action, snapshot, settings.confirmRisky);

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

      // VALIDATE: reject element IDs the client never sent.
      // When stale, auto-receive and inject fresh snapshot to save an LLM round trip.
      const elementId = call.input.element_id;
      if (typeof elementId === "number") {
        // The id refers to a snapshot the model saw earlier — the current
        // snapshot no longer contains it, so look it up in what was last shown.
        const staleTarget = lastRenderedElements.find((e) => e.id === elementId);
        const elExists = snapshot?.elements.some((e) => e.id === elementId);
        if (!elExists) {
          // Auto-receive: get fresh snapshot so the LLM immediately has new IDs.
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

          // One-shot auto-retry: if exactly ONE fresh element matches the
          // stale one by role+name, remap and execute it right away — this is
          // the "model clicked the same video three times" failure mode, and
          // it should never cost an extra LLM round trip. Ambiguous matches
          // (0 or 2+) fall through to the re-perceived error instead.
          let staleRemapped = false;
          if (staleTarget && (call.name === "click" || call.name === "type") && snapshot) {
            const target = staleTarget;
            const matches = snapshot.elements.filter(
              (e) => e.role === target.role && e.name === target.name,
            );
            if (matches.length === 1) {
              call.input.element_id = matches[0].id;
              staleRemapped = true;
            }
          }

          if (!staleRemapped) {
            const freshRendered = snapshot ? renderSnapshot(snapshot) : "(no snapshot available)";
            emit({ kind: "patch", id: stepId, text: `Element ${elementId} stale — re-perceived page.`, pending: false });
            results.push({
              id: call.id,
              isError: true,
              content: `Element ${elementId} not found. The page changed. Here are the current elements — pick the right one and retry:

${freshRendered}`,
            });
            continue;
          }

          emit({
            kind: "patch",
            id: stepId,
            text: `Element ${elementId} stale — matched "${staleTarget?.name ?? "element"}" (now #${call.input.element_id}); retrying automatically.`,
            pending: false,
          });
          // Fall through: the normal VALIDATE → RESOLVE → execute path now
          // runs against the fresh id without another planner round trip.
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
      const resolvedAction = { name: call.name as never, input: resolvedInput };

      recordAction(call.name, call.input);
      const actionStart = performance.now();
      const outcome = await execute(controller, resolvedAction);
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
      const mayHaveChanged = PAGE_ACTIONS.has(call.name)
        ? call.name !== "find_text" && call.name !== "wait"
        : true;

      if (mayHaveChanged) {
        const fresh = result.snapshot ?? (await controller.snapshot());
        if (fresh) {
          const navigated = snapshot && fresh.url !== snapshot.url;
          snapshot = fresh;

          // Apply privacy pipeline to fresh snapshot (checksum validation +
          // learned false-positive suppression included).
          const { sanitized, piiCount, detections: freshDetections, suppressed: freshSuppressed, rejected: freshRejected } = sanitizeSnapshot(snapshot, sanitizeCtx);
          snapshot = sanitized;
          lastDomDetections = freshDetections;

          // Truncate fresh snapshots to avoid context overflow.
          if (isFreeTier) {
            snapshot = { ...snapshot, elements: snapshot.elements.filter((e) => !e.attrs?.offscreen) };
          }
          if (snapshot.elements.length > maxSnapshotElements) {
            const vis = snapshot.elements.filter((e) => !e.attrs?.offscreen);
            const off = snapshot.elements.filter((e) => e.attrs?.offscreen);
            snapshot = { ...snapshot, elements: [...vis, ...off].slice(0, maxSnapshotElements), truncated: true };
          }
          piiTotal += piiCount;

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
          if (captureScreenshot) {
            try {
              const screenshotResult = await captureScreenshot();
              if (screenshotResult) {
                const processed = screenshotResult.processed;
                const visualDetections = processed.detections.map((d) => ({
                  kind: d.kind,
                  label: d.label,
                  confidence: d.confidence,
                }));
                const verification = processed.verification;
                noteVerification(verification);

                observation += `\n\n[Screenshot: ${processed.redactedCount} PII redacted]`;
                if (verification && verification.regionsChecked > 0) {
                  observation += verification.verified
                    ? ` [Re-OCR VERIFIED: ${verification.regionsRedacted}/${verification.regionsChecked} regions confirmed redacted]`
                    : ` [Re-OCR WARNING: ${verification.summary}]`;
                }

                // Ledger: visual detections + redaction + verification proof.
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
                piiTotal += processed.redactedCount;
                // Record for privacy audit — fresh DOM detections + visuals.
                recordAudit?.({
                  original: screenshotResult.original,
                  redacted: processed.redactedDataUrl,
                  detections: [...visualDetections, ...auditFromDetections(freshDetections)],
                  tokens: tokenizer.getTokenSummary(),
                  redactedCount: processed.redactedCount,
                  verification,
                });

                // Optional VLM vision: describe the redacted screen for the
                // planner. Request bytes count toward the honest egress badge.
                if (visionEnabled && visionApiKey && !signal.aborted) {
                  observation = await observeScreen(processed.redactedDataUrl, observation);
                }
              }
            } catch {
              // Screenshot is optional.
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

/** Max wall-clock time per planner turn before it is aborted as stalled. */
const TURN_TIMEOUT_MS = 35_000;

/**
 * Stall/transient failure classifiers — these warrant one automatic retry.
 * Everything else (bad model, rejected key, malformed request) is not retried.
 */
function isRetryablePlannerError(message: string): boolean {
  return /did not respond within|rate.?limit|timed? ?out|network|fetch failed|econn|overloaded|temporarily|503|429|502|504|timeout/i.test(
    message,
  );
}

/**
 * Resolve a promise unless it takes longer than `ms`, in which case call
 * `onTimeout` (to cancel the underlying request) and reject with `message`.
 * The original promise's later settle is absorbed so nothing is unhandled.
 */
function withTurnTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
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
    case "scroll":
      return `Scroll ${input.direction}`;
    case "find_text":
      return `Look for "${input.query}"`;
    default:
      return reason || name.replace(/_/g, " ");
  }
}

export type { TranscriptEntry };
