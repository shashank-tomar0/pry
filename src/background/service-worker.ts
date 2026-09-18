import type {
  AgentEvent,
  PanelCommand,
  PrivacyAuditPayload,
  ProcessedScreenshotResult,
  Settings,
  TranscriptEntry,
  TripwireAlertDetail,
  VerificationResult,
} from "../shared/types";
import { createTripwireAggregator } from "./tripwire-aggregator";
import { normaliseSettings } from "../shared/types";
import { redactionTally, rollupFrameVerification, type RedactionTally } from "../shared/metrics";
import { regionMappingFor } from "../shared/region-mapping";
import { VISION_SUPPORTED } from "./vision";
import { tokenizer, maskSample } from "./tokenizer";
import { clearWire, wireRecords } from "./wire-log";
import { getActiveNerSpans, getActivePiiTargets } from "./ml-bridge";
import { findUnlocatedValues } from "../shared/redaction-reconciliation";
import { ensureOffscreenDocument } from "./offscreen-doc";
import { runTask } from "./agent";
import { createPlanner } from "./providers";
import { generateLessons } from "./lesson-generator";
import { getLessons, recordLessons } from "./lessons";
import { getTrajectories, recordTrajectory } from "./trajectories";
import { saveSession, getSessions, deleteSession, clearHistory } from "./history";
import { recordExperience, getMemoryStats, getExperiencesForDomain } from "./experience-memory";
import { reflectOnRun } from "./reflection";
import { clearLedger, getLedgerSummary, recordRedaction } from "./privacy-ledger";
import { applyCaptureEvidence } from "../shared/screenshot-protection";
import { applyReflectionResults, getLearnedRules, getRulesSummary } from "./learned-rules";
import type { RunExperience } from "./experience-memory";

// The side panel can be closed and reopened mid-run, so the transcript lives
// here rather than in the panel's own memory.
let transcript: TranscriptEntry[] = [];
let running = false;
let abort: AbortController | null = null;
let lastExperience: RunExperience | null = null;

// Compact memory of finished exchanges so the next task can continue the
// chat. In-memory only (never chrome.storage), cleared on reset; the raw
// text is re-tokenized through the next run's vault before it reaches a model.
const conversationMemory: Array<{ task: string; answer: string; timestamp: number }> = [];
const CONVERSATION_MEMORY_MAX = 3;
const CONVERSATION_TASK_MAX = 400;
const CONVERSATION_ANSWER_MAX = 800;

// ─── Tripwire aggregation ─────────────────────────────────────────────────────
// One live transcript entry instead of one per observed request, plus a capped
// detail log for the radar drawer. The wording says "observed": these hooks
// call through unchanged and nothing here can stop a request.
const tripwireAggregator = createTripwireAggregator();
const tripwireLog: TripwireAlertDetail[] = [];
const TRIPWIRE_LOG_CAP = 60;
let tripwireEntryCreated = false;

function handleTripwireAlert(detail: TripwireAlertDetail): void {
  tripwireLog.unshift(detail);
  if (tripwireLog.length > TRIPWIRE_LOG_CAP) tripwireLog.length = TRIPWIRE_LOG_CAP;
  recordRedaction(1, `tripwire_${detail.piiType || "egress"}`).catch(() => {});

  const summary = tripwireAggregator.bump(detail);
  if (!tripwireEntryCreated) {
    tripwireEntryCreated = true;
    emit({
      kind: "entry",
      entry: { id: "egress-watch", role: "egress", text: summary },
    });
  } else {
    emit({ kind: "patch", id: "egress-watch", text: summary });
  }
  emit({ kind: "tripwire-update", alert: detail });
}

const pendingConfirms = new Map<string, (approved: boolean) => void>();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  return normaliseSettings(stored.settings);
}

const LAST_REFLECTION_KEY = "pry-last-reflection";

/** Emit the current learning stats to the panel (after runs and corrections). */
async function emitLearningStats(lastReflection: string = ""): Promise<void> {
  try {
    if (lastReflection) {
      await chrome.storage.local.set({ [LAST_REFLECTION_KEY]: lastReflection });
    }
    const stats = await getMemoryStats();
    const rulesSummary = await getRulesSummary();
    const [lessons, trajectories] = await Promise.all([getLessons(), getTrajectories()]);
    emit({
      kind: "learning-update",
      stats: {
        totalRuns: stats.totalRuns,
        successRate: Math.round(stats.averageSuccessRate * 100),
        piiDetected: stats.totalPIIDetected,
        piiRedacted: stats.totalPIIRedacted,
        falsePositives: stats.totalFalsePositives,
        missedPII: stats.totalMissedPII,
        sitesVisited: stats.sitesVisited,
        rulesLearned: stats.rulesLearned,
        improvementDelta: stats.improvementDelta,
        corrections: stats.totalUserCorrections,
        rulesSummary,
        lastReflection,
        lessons: {
          total: lessons.length,
          recent: lessons
            .slice(0, 5)
            .map((l) => ({
              domain: l.domain,
              pageType: l.pageType,
              text: l.text,
              createdAt: l.createdAt,
            })),
        },
        trajectories: {
          total: trajectories.length,
          recent: trajectories
            .slice(0, 5)
            .map((t) => ({
              domain: t.domain,
              pageType: t.pageType,
              task: t.task,
              steps: t.steps,
              createdAt: t.createdAt,
            })),
        },
      },
    } as AgentEvent);
  } catch (err) {
    console.warn("[PRY] Emitting learning stats failed:", err);
  }
}

/** Broadcasts to the panel; a closed panel simply has no receiver. */
function emit(event: AgentEvent): void {
  if (event.kind === "entry") {
    transcript.push(event.entry);
  } else if (event.kind === "patch") {
    const entry = transcript.find((e) => e.id === event.id);
    if (entry) {
      // Text deltas append; step updates replace. An assistant patch may opt out
      // of the append with `replace` — see the discarded-stream case in agent.ts.
      if (event.text !== undefined) {
        entry.text =
          entry.role === "assistant" && !event.replace ? entry.text + event.text : event.text;
      }
      if (event.pending !== undefined) entry.pending = event.pending;
    }
  } else if (event.kind === "experience") {
    // Capture the experience for reflection after the task ends.
    lastExperience = event.experience as unknown as RunExperience;
  }
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

/** How long an approval prompt waits before it auto-declines (prevents a
 * permanent hang when the side panel is closed or the user walks away). */
const APPROVAL_TIMEOUT_MS = 120_000;

function askConfirm(id: string, summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingConfirms.has(id)) return;
      pendingConfirms.delete(id);
      emit({
        kind: "entry",
        entry: {
          id: `confirm-timeout-${Date.now()}`,
          role: "system",
          text: "Approval request timed out after 120s and was treated as declined. Re-run and approve within the window if you want the action to proceed.",
        },
      });
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    pendingConfirms.set(id, (approved) => {
      clearTimeout(timer);
      resolve(approved);
    });
    emit({ kind: "confirm", id, summary });
  });
}

// ─── Screenshot Capture (Service Worker Only) ───────────────────────────────

/**
 * Bring up the offscreen document early, at the start of a run, so the first
 * ML call and the first screenshot do not pay a cold-start race. Failures are
 * non-fatal — every ML consumer degrades on its own.
 */
async function warmOffscreen(): Promise<void> {
  await ensureOffscreenDocument();
  // The document existing is not the same as the work being warm. Tesseract is
  // built lazily on first use, and that first use is the user's first capture —
  // measured at ~10.5 s of cold start before any page work happens. Starting it
  // here overlaps it with the opening perception and the first planner turn,
  // which the run is paying for anyway. Fire-and-forget: OCR is best-effort
  // everywhere, and a failed warm-up must not fail a run.
  chrome.runtime.sendMessage({ type: "warm-ocr" }).catch(() => undefined);
}

/**
 * Capture the visible tab area for a specific tab. This MUST run in the
 * service worker because chrome.tabs.captureVisibleTab is not available in
 * content scripts. Takes the agent's tabId so it captures the page the agent
 * is driving — not whatever tab happens to be focused (which would redact and
 * egress the wrong page's pixels if the user switches tabs mid-run).
 */
type CaptureGeometry = {
  url: string; scrollX: number; scrollY: number;
  viewportWidth: number; viewportHeight: number; dpr: number;
};

async function captureGeometry(tabId: number): Promise<CaptureGeometry | null> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href, scrollX: window.scrollX, scrollY: Math.round(window.scrollY),
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
      }),
    });
    return result?.result ?? null;
  } catch {
    return null;
  }
}

// The capture-protection assembly (formerly `downgradeCaptureProtection`) is
// `applyCaptureEvidence` in shared/screenshot-protection.ts. It moved because
// the old helper could only ever WEAKEN evidence: it ran only when there were
// reasons, and hardcoded every flag false including `mappingValid`, so a
// verified mapping was reported invalid and the object could never satisfy the
// egress guard. Assembly now composes the offscreen half with the two facts
// only this process holds, and geometry validity comes from the caller.

async function captureVisibleTab(tabId: number): Promise<{
  dataUrl: string; width: number; height: number;
  geometry: CaptureGeometry | null; captureVerified: boolean;
} | null> {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id || !tab.windowId) return null;

    // chrome.tabs.captureVisibleTab ignores the tab id entirely — it captures
    // whatever is VISIBLE in the window. For the agent run that is always the
    // driving tab, but a caller like the privacy inspector passes a tab that
    // is NOT focused, and the capture silently photographed the wrong page
    // (the inspector itself). When the target is not the visible tab, bring it
    // to the front just long enough to capture, then restore the user's tab.
    let previousActiveId: number | null = null;
    if (!tab.active) {
      const [current] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      previousActiveId = current?.id ?? null;
      await chrome.tabs.update(tabId, { active: true });
      // Let the tab actually paint: a capture that races the activation
      // returns the previous frame.
      await new Promise((r) => setTimeout(r, 400));
    }

    try {
      const before = await captureGeometry(tabId);
      const [activeBefore] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (activeBefore?.id !== tabId) return null;
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const [activeAfter] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (activeAfter?.id !== tabId) return null;
      const after = await captureGeometry(tabId);

      // Get image dimensions by loading into an offscreen canvas.
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();

      const captureVerified = Boolean(before && after &&
        JSON.stringify(before) === JSON.stringify(after) &&
        Number.isFinite(after.scrollX) && Number.isFinite(after.scrollY) &&
        after.scrollY >= 0 && Number.isFinite(after.dpr) && after.dpr > 0 &&
        after.viewportWidth > 0 && after.viewportHeight > 0 &&
        Math.abs(width - after.viewportWidth * after.dpr) <= 1 &&
        Math.abs(height - after.viewportHeight * after.dpr) <= 1);
      return { dataUrl, width, height, geometry: after, captureVerified };
    } finally {
      if (previousActiveId !== null) {
        await chrome.tabs.update(previousActiveId, { active: true }).catch(() => undefined);
      }
    }
  } catch {
    return null;
  }
}

/**
 * Process a screenshot through the offscreen document's privacy pipeline.
 * Returns the redacted image and detection results.
 * `privacy` carries the user's toggles (face destruction, credential masking,
 * redaction labels) so the offscreen pipeline honors them.
 */
async function processScreenshot(
  dataUrl: string,
  width: number,
  height: number,
  sensitiveRegions: Array<{
    x: number; y: number; width: number; height: number;
    kind: string; label: string;
  }> = [],
  dpr: number = 1,
  privacy?: {
    destroyFaces: boolean;
    maskCredentials: boolean;
    showRedactionLabels: boolean;
    scanFrameText?: boolean;
  },
  /**
   * Maps region coordinates onto THIS image. Viewport captures use the DPR
   * alone; a stitched full-page image additionally scales tiles onto the
   * page canvas and offsets every region by the scroll position it was
   * measured at (both precomputed by the caller).
   */
  regionScale: number = dpr,
  regionOffsetY: number = 0,
): Promise<ProcessedScreenshotResult> {
  await ensureOffscreenDocument();

  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve, reject) => {
    // First-run OCR loads the Tesseract wasm core + traineddata from vendor,
    // which can exceed 10s on a cold disk — give it room. The timer is cleared
    // the instant the reply arrives, so a longer bound costs nothing when the
    // pipeline is healthy.
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error("Offscreen processing timed out after 45s"));
    }, 45000);

    // Listen for the response from the offscreen document.
    const listener = (
      message: { type: string; requestId?: string; result?: ProcessedScreenshotResult; error?: string },
      _sender: chrome.runtime.MessageSender,
    ) => {
      if (message.type === "screenshot-processed" && message.requestId === requestId) {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message.result!);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // Send the screenshot + sensitive regions + DPR + privacy toggles to the
    // offscreen document.
    chrome.runtime.sendMessage({
      type: "process-screenshot",
      requestId,
      dataUrl,
      width,
      height,
      sensitiveRegions,
      dpr,
      regionScale,
      regionOffsetY,
      privacy,
      // Names the model already found on this page travel with the frame so
      // in-image text triage can recognise them: a bare name in a photo has no
      // pattern to match, but it does have this.
      knownSpans: getActiveNerSpans(),
    });
  });
}

/**
 * Get sensitive element positions from the content script.
 * Returns bounding boxes of password fields, credit cards, ID numbers, etc.
 * Every round trip is bounded. Missing regions remain available as a local
 * preview failure, but must downgrade capture protection before egress.
 */
async function getSensitiveRegions(tabId: number): Promise<{
  regions: Array<{ x: number; y: number; width: number; height: number; kind: string; label: string; value?: string }>;
  dpr: number;
  /** Viewport scroll (CSS px) when the regions were measured — full-page mapping. */
  scrollY: number;
  /** Viewport CSS width when the regions were measured — full-page mapping. */
  viewportWidth: number;
  /** Set when region collection did not complete — text PII is NOT redacted. */
  failure: string | null;
} | null> {
  // Distinguish "no receiver" (content script not injected — reinject) from
  // "receiver busy" (script exists but hung — reinjecting would only create a
  // duplicate listener, so we skip and let the region call time out gracefully).
  const callContent = (message: unknown, timeoutMs = 20000): Promise<
    { ok: true; value: unknown } | { ok: false; reason: "timeout" | "error" }
  > =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, reason: "timeout" });
        }
      }, timeoutMs);
      chrome.tabs.sendMessage(tabId, message as never).then(
        (value) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: true, value });
          }
        },
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, reason: "error" });
          }
        },
      );
    });

  try {
    // Ensure content script is injected (may not be if tab predates extension).
    const ping = await callContent({ kind: "ping" }, 4000);
    if (!ping.ok && ping.reason === "error") {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      // Wait for content script to initialize.
      await new Promise((r) => setTimeout(r, 100));
    }

    // Fire the region sources in parallel: the DOM/regex channel, the
    // NER→pixel bridge (model-found spans located in painted text), and the
    // detector→pixel bridge (the text channels' own findings, located as text
    // OR by element, since accessible names and attributes have no text node).
    // locateSpans/locateElements only return rects where that exact item is
    // present now, so a value left over from a previous page can never
    // over-redact the current one.
    const activeNerSpans = getActiveNerSpans();
    const piiTargets = getActivePiiTargets();
    // One call carries both: NER spans and the detectors' literal values.
    const locateValues = [...new Set([
      ...activeNerSpans,
      ...piiTargets.map((t) => t.value).filter((v): v is string => Boolean(v)),
    ])];
    const elementTargets = piiTargets.filter((t) => t.selector) as Array<{ selector: string; value?: string }>;
    let [result, nerResult, elementResult] = await Promise.all([
      callContent({ kind: "get-sensitive-regions" }),
      locateValues.length > 0
        ? callContent({ kind: "locate-spans", spans: locateValues })
        : Promise.resolve(null),
      elementTargets.length > 0
        ? callContent({ kind: "locate-elements", targets: elementTargets })
        : Promise.resolve(null),
    ]);

    // A single error (the page navigated, or the script was replaced by a
    // reload mid-call) is recoverable: reinject and ask once more. A timeout
    // is not retried — the page's main thread is busy and a second call would
    // block it for another full window.
    if (!result.ok && result.reason === "error") {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      result = await callContent({ kind: "get-sensitive-regions" });
    }

    const nerValue = nerResult?.ok
      ? (nerResult.value as { sensitiveRegions?: unknown[] } | null)
      : null;
    if (!result.ok) {
      const why = result.reason === "timeout"
        ? "the page's main thread did not answer in time (heavy script, or a frozen tab)"
        : "the content script is not reachable on this page";
      console.log(`[PRY] Sensitive-region collection failed: ${result.reason}`);
      return { regions: [], dpr: 1, scrollY: 0, viewportWidth: 0, failure: why };
    }
    const value = result.value as { sensitiveRegions?: unknown[]; dpr?: number; scrollY?: number; viewportWidth?: number };
    if (!Array.isArray(value?.sensitiveRegions)) {
      console.log("[PRY] No sensitive regions returned from content script");
      return {
        regions: [],
        dpr: value?.dpr ?? 1,
        scrollY: value?.scrollY ?? 0,
        viewportWidth: value?.viewportWidth ?? 0,
        failure: "the content script returned no region list",
      };
    }
    const failures: string[] = [];
    // The current wire format cannot attribute results to selectors. A value
    // found elsewhere (or several boxes for one target) cannot prove coverage.
    if (elementTargets.length > 0) {
      failures.push("dom-selector-coverage-unverified");
    }
    const checkLocator = (reply: typeof nerResult, required: boolean, name: string) => {
      if (!required) return;
      const data = reply?.ok ? reply.value as typeof value | null : null;
      if (!Array.isArray(data?.sensitiveRegions)) failures.push(`${name}-unavailable`);
      if (!data || data.dpr !== value.dpr || data.scrollY !== value.scrollY ||
          data.viewportWidth !== value.viewportWidth) failures.push(`${name}-geometry-mismatch`);
    };
    checkLocator(nerResult, locateValues.length > 0, "dom-span-locator");
    checkLocator(elementResult, elementTargets.length > 0, "dom-element-locator");
    const regions = [...value.sensitiveRegions] as Array<{
      x: number; y: number; width: number; height: number; kind: string; label: string; value?: string;
    }>;
    let nerFound = 0;
    if (Array.isArray(nerValue?.sensitiveRegions)) {
      nerFound = nerValue.sensitiveRegions.length;
      regions.push(...(nerValue.sensitiveRegions as typeof regions));
    }
    let elementFound = 0;
    if (elementResult?.ok) {
      const elValue = elementResult.value as { sensitiveRegions?: unknown[] } | null;
      if (Array.isArray(elValue?.sensitiveRegions)) {
        elementFound = elValue.sensitiveRegions.length;
        regions.push(...(elValue.sensitiveRegions as typeof regions));
      }
    }
    console.log(`[PRY] Content script found ${regions.length} sensitive regions ` +
      `(${nerFound} from on-device NER, ${elementFound} located by detector element), DPR=${value.dpr}`);
    const validRegions = regions.filter((region) => region &&
      [region.x, region.y, region.width, region.height].every(Number.isFinite) &&
      region.width > 0 && region.height > 0);
    if (validRegions.length !== regions.length) failures.push("dom-region-geometry-invalid");
    if (findUnlocatedValues(locateValues.map((value) => ({ value })), validRegions).length > 0) {
      failures.push("dom-targets-unresolved");
    }
    if (!Number.isFinite(value.dpr) || (value.dpr ?? 0) <= 0 ||
        !Number.isFinite(value.viewportWidth) || (value.viewportWidth ?? 0) <= 0 ||
        !Number.isFinite(value.scrollY) || (value.scrollY ?? -1) < 0) {
      failures.push("dom-capture-geometry-missing");
    }
    return {
      regions: validRegions,
      dpr: value.dpr ?? Number.NaN,
      scrollY: value.scrollY ?? Number.NaN,
      viewportWidth: value.viewportWidth ?? Number.NaN,
      failure: failures.length ? failures.join(", ") : null,
    };
  } catch (err) {
    console.warn("[PRY] getSensitiveRegions failed:", err);
    return {
      regions: [],
      dpr: 1,
      scrollY: 0,
      viewportWidth: 0,
      failure: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Capture and process a screenshot in one call.
 * Returns both original (for audit comparison) and processed (redacted).
 * `tabId` is the agent's driving tab — captures and regions come from THAT
 * tab, never the currently-focused one, so switching tabs mid-run can't make
 * the pipeline redact and egress the wrong page.
 */
export async function captureAndProcessScreenshot(
  tabId: number,
  privacy: Settings["privacy"],
  fullPage?: boolean,
): Promise<{
  original: string;
  processed: ProcessedScreenshotResult;
} | null> {
  let rawDataUrl: string | null = null;
  let width = 0;
  let height = 0;
  let capturedFullPage = false;
  let captureVerified = false;
  let geometry: CaptureGeometry | null = null;

  if (fullPage) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.windowId) {
      const { captureAndStitchFullPage } = await import("./stitch");
      const stitchRes = await captureAndStitchFullPage(tabId, tab.windowId).catch(() => null);
      if (stitchRes) {
        rawDataUrl = stitchRes.dataUrl;
        width = stitchRes.width;
        height = stitchRes.height;
        capturedFullPage = true;
        captureVerified = stitchRes.captureVerified === true;
      }
    }
  }

  if (!rawDataUrl) {
    const captured = await captureVisibleTab(tabId);
    if (!captured) return null;
    rawDataUrl = captured.dataUrl;
    width = captured.width;
    height = captured.height;
    geometry = captured.geometry;
    captureVerified = captured.captureVerified;
  }

  // Sensitive regions + DPR come from the SAME tab we captured.
  const sensitiveData = await getSensitiveRegions(tabId);
  if (sensitiveData?.failure) {
    // Text-region collection could not complete, so this frame's text PII is
    // NOT redacted (faces still are — that channel is pure pixel work). This
    // used to be silent, which is exactly how "faces blurred but the email is
    // still readable" looked like a mystery. Say it, once, with the reason.
    emit({
      kind: "entry",
      entry: {
        id: `regions-fail-${Date.now()}`,
        role: "system",
        text: `Privacy warning: text-region detection did not complete (${sensitiveData.failure}). Text PII in this screenshot may stay visible; faces are still destroyed on-device (that channel is pure pixel work). If this repeats on one site, retry on a lighter page.`,
      },
    });
  }
  const dpr = sensitiveData?.dpr ?? 1;
  const sensitiveRegions = sensitiveData?.regions ?? [];

  // ─── Detected vs actually boxed ───
  // The text channels read MORE than rendered text: accessible names, element
  // values, attributes. A value the pixel channel could not place anywhere is
  // the exact failure this check exists for — it was tokenized for the planner
  // but stays readable in the frame. Silence about it is how a Gmail inbox
  // shipped "2 detected / 0 redacted" with the address plainly visible.
  // Reported, not hidden: an item we cannot locate is a real, residual leak.
  // A failed region collection is reported separately (see above) — here it
  // would just produce noise for every detected value.
  const unlocated = sensitiveData?.failure
    ? []
    : findUnlocatedValues(getActivePiiTargets(), sensitiveRegions);
  // Once per distinct set of leftovers: the same unlocatable name on every
  // frame of one page is one honest warning, not a wall of them.
  const unlocatedSignature = unlocated.join("\u0000");
  if (unlocated.length > 0 && unlocatedSignature !== lastUnlocatedSignature) {
    lastUnlocatedSignature = unlocatedSignature;
    // Mask the sample — a warning about leaked PII must not leak it again.
    const samples = unlocated.slice(0, 3).map(maskSample);
    console.log(`[PRY] ${unlocated.length} detected item(s) could not be located on screen:`, unlocated);
    emit({
      kind: "entry",
      entry: {
        id: `unlocated-${Date.now()}`,
        role: "system",
        text:
          `Privacy warning: ${unlocated.length} detected item(s) (${samples.join(", ")}) were found in the page but could not be located on screen, ` +
          `so they stay readable in this frame even though the planner only saw a token. ` +
          `Items inside images, canvas or an off-screen element land here.`,
      },
    });
  } else if (unlocated.length === 0) {
    lastUnlocatedSignature = "";
  }

  // Region→image mapping. Regions are measured in VIEWPORT CSS pixels; a
  // viewport capture is viewport×DPR, so scale = DPR. A stitched full-page
  // capture is the whole PAGE drawn at (canvasWidth / tileWidth) of each
  // viewport tile, and the regions were measured after the scroll was
  // restored — so every region needs that tile scale AND the restored scroll
  // offset. Getting this wrong put every text-PII black box at the wrong y in
  // full-page mode (the "faces blurred but text PII elsewhere" ledger view).
  // Shared with the inspector's capture path so the two can never disagree.
  const mapping = regionMappingFor({
    imageWidth: width,
    imageHeight: height,
    dpr: sensitiveData?.dpr ?? Number.NaN,
    viewportWidth: sensitiveData?.viewportWidth ?? Number.NaN,
    scrollY: sensitiveData?.scrollY ?? Number.NaN,
    fullPage: capturedFullPage,
  });
  const { scale: regionScale, offsetY: regionOffsetY, mapped: fullPageImage } = mapping;
  const captureReasons = [...mapping.reasons];
  // Geometry is verified only when the mapping resolved AND the capture was
  // confirmed against the page state it was measured from. Tracked as its own
  // fact rather than inferred from "no reasons were added", because the reason
  // list also carries coverage problems that are not geometry problems.
  let geometryConfirmed = mapping.valid && captureVerified;
  if (!captureVerified) captureReasons.push("capture-verification-missing");
  const textComplete = Boolean(sensitiveData) && !sensitiveData!.failure;
  if (!textComplete) {
    captureReasons.push(`dom-coverage-incomplete: ${sensitiveData?.failure ?? "no response"}`);
  }
  if (unlocated.length > 0) captureReasons.push("dom-targets-unresolved");
  if (capturedFullPage) {
    // Restored-viewport boxes do not establish coverage of every captured tile.
    captureReasons.push("fullpage-dom-coverage-unverified");
  } else {
    const measuredGeometry = await captureGeometry(tabId);
    if (!geometry || !measuredGeometry ||
        JSON.stringify(geometry) !== JSON.stringify(measuredGeometry) ||
        geometry.dpr !== sensitiveData?.dpr ||
        geometry.viewportWidth !== sensitiveData?.viewportWidth ||
        geometry.scrollY !== sensitiveData?.scrollY) {
      captureReasons.push("capture-dom-geometry-unverified");
      geometryConfirmed = false;
    }
  }

  console.log(`[PRY] Screenshot (tab ${tabId}): ${width}x${height} @ ${dpr}x DPR, ${sensitiveRegions.length} sensitive regions found` +
    (fullPageImage ? `, region scale ${regionScale.toFixed(3)}, offset y ${Math.round(regionOffsetY)}px` : ""));

  const processed = await processScreenshot(
    rawDataUrl, width, height, sensitiveRegions, dpr,
    {
      destroyFaces: privacy.destroyFaces,
      maskCredentials: privacy.maskCredentials,
      showRedactionLabels: privacy.showRedactionLabels,
      scanFrameText: privacy.scanFrameText,
    },
    regionScale,
    regionOffsetY,
  );
  // Assemble the egress evidence: the offscreen half (its own scan results)
  // plus the two facts only this process holds — whether the DOM text channel
  // completed and whether the region→image geometry was verified. Without this
  // the object stayed `undefined`, screenshotSendDecision returned
  // "Protection evidence missing" for every frame, and vision could never ship.
  processed.protection = applyCaptureEvidence(processed.protection, {
    textComplete,
    mappingValid: geometryConfirmed,
    reasons: captureReasons,
  });
  return { original: rawDataUrl, processed };
}

// ─── Privacy Audit Collector ────────────────────────────────────────────────

/** Signature of the last "could not locate this" warning, so it fires once. */
let lastUnlocatedSignature = "";


interface AuditEntry {
  original?: string;
  redacted?: string;
  detections: Array<{ kind: string; label: string; confidence: number; tier?: string }>;
  tokens: Array<{ token: string; kind: string; sample?: string }>;
  redactedCount: number;
  /** True when this frame's redacted image was actually sent to a VLM. */
  shipped?: boolean;
  /** Why the protection gate refused this frame's pixels, when it did. */
  withheld?: string[];
  verification?: VerificationResult;
  timestamp: number;
}

let auditEntries: AuditEntry[] = [];
let taskStartTime = 0;

/**
 * The run's redaction tally, as reported by the agent that counted it.
 *
 * The agent sees both channels (DOM/text items per perception, painted regions
 * per frame); this worker sees only the frames, and only those still inside the
 * entry buffer. Deriving the run's total here is what made the chip disagree
 * with the transcript, so the agent's number is kept and the local sum is used
 * only when no run has reported one.
 */
let runTally: RedactionTally | null = null;

/**
 * The tally the agent last reported, read through a call.
 *
 * Deliberately not a bare variable read at the use sites: the agent reports
 * from inside a callback, which is not part of the linear flow TS analyses, so
 * a direct read after `runTally = null` narrows to `null` and the report is
 * erased from the type.
 */
function reportedTally(): RedactionTally | null {
  return runTally;
}

const MAX_AUDIT_ENTRIES = 10;

function recordAuditEntry(data: {
  original?: string;
  redacted?: string;
  detections: Array<{ kind: string; label: string; confidence: number; box?: { x: number; y: number; width: number; height: number }; tier?: string }>;
  tokens: Array<{ token: string; kind: string; sample?: string }>;
  redactedCount: number;
  shipped?: boolean;
  withheld?: string[];
  verification?: VerificationResult;
}): void {
  // Limit stored entries to prevent memory bloat (each base64 screenshot ~1-5MB).
  if (auditEntries.length >= MAX_AUDIT_ENTRIES) {
    // Keep the first entry (initial page) and drop older middle entries.
    const first = auditEntries[0];
    auditEntries = [first, ...auditEntries.slice(auditEntries.length - MAX_AUDIT_ENTRIES + 2)];
  }

  auditEntries.push({
    ...data,
    timestamp: Date.now(),
  });
}

/**
 * Build the privacy-audit payload from the entries recorded so far.
 *
 * Split out of `emitPrivacyAudit` so the panel can ASK for it (get-audit)
 * instead of only receiving it as a live event. The audit used to exist only as
 * a broadcast: if the side panel was not listening at that instant — reloaded,
 * or the service worker had been evicted and restarted, which MV3 does on a
 * timer — the Privacy Audit panel rendered empty and the run's evidence looked
 * like it had never happened.
 */
function buildPrivacyAudit(): PrivacyAuditPayload | null {
  if (auditEntries.length === 0) return null;
  const allDetections: Array<{ kind: string; label: string; confidence: number; box?: { x: number; y: number; width: number; height: number }; tier?: string }> = [];
  const allTokens: Array<{ token: string; kind: string; sample?: string }> = [];
  let totalRedacted = 0;

  for (const entry of auditEntries) {
    allDetections.push(...entry.detections);
    allTokens.push(...entry.tokens);
    totalRedacted += entry.redactedCount;
  }

  // Take at most 5 screenshots for the audit (to keep the UI manageable).
  // Each carries its OWN detections so the panel's proof overlays are drawn
  // only on the frame they belong to — never bleeding boxes across frames.
  const screenshots = auditEntries
    .filter((e) => e.original || e.redacted)
    .slice(-5)
    .map((e) => ({
      original: e.original,
      redacted: e.redacted,
      timestamp: e.timestamp,
      detections: e.detections,
    }));

  // Latest re-OCR verification result, shown as a proof badge in the audit.
  const lastVerification = [...auditEntries].reverse().find((e) => e.verification)?.verification;
  const rollup = rollupFrameVerification(auditEntries);

  // The run's tally: the agent's own count when it has reported one, else what
  // this worker can honestly derive from the frames it holds (page items are
  // the channel it cannot see, so it reports none rather than inventing any).
  const tally =
    reportedTally() ??
    redactionTally(0, auditEntries.reduce((sum, e) => sum + e.redactedCount, 0), new Set(allTokens.map((t) => t.token)).size);

  return {
    screenshots,
    allDetections,
    allTokens,
    // Frame regions only. The chip must label it that way and read the run
    // total from `tally` — this number is never the whole run's redactions.
    totalRedacted,
    totalScreenshots: auditEntries.length,
    totalPIIDetections: allDetections.length,
    durationMs: Date.now() - taskStartTime,
    // Did ANY frame in this run reach a vision model? Only then is the
    // redacted pane "what shipped to the model".
    shipped: rollup.framesShipped > 0,
    verification: lastVerification,
    verificationRollup: rollup,
    tally,
  };
}

function emitPrivacyAudit(): void {
  const audit = buildPrivacyAudit();
  if (audit) emit({ kind: "privacy-audit", audit });
}

// ─── Agent Loop ──────────────────────────────────────────────────────────────

async function start(task: string, tabId: number): Promise<void> {
  if (running) return;

  const settings = await loadSettings();

  // Tokenize the user's task once, up-front, so:
  //   1. the model only ever sees <CRED_1> / <ORG_3> (never raw secrets typed
  //      into the prompt), and
  //   2. the session stored to chrome.storage holds the tokenized task, not a
  //      raw password/card/name the user happened to type into the request.
  // The shared tokenizer de-dupes, so runTask's own pass adds no new tokens.
  const { task: tokenizedTask, newEntries: taskTokens } = tokenizer.tokenizeTask(task);

  running = true;
  abort = new AbortController();
  taskStartTime = Date.now();
  auditEntries = [];
  // A new run must not inherit the previous run's totals: the panel renders
  // this payload live, and stale counts under a fresh task are a false claim.
  runTally = null;
  emit({ kind: "status", running: true });

  // Create the offscreen runtime BEFORE runTask's first NER/guard call. It is
  // fire-and-forget: the model load itself is warmed by the self-test inside
  // runTask, and a failure here only means ML degrades as before.
  void warmOffscreen();
  emit({ kind: "entry", entry: { id: `u-${Date.now()}`, role: "user", text: tokenizedTask } });

  // Name what was taken out of the user's OWN sentence, in masked form, right
  // after the task they typed so the transcript reads task → what changed.
  //
  // This is the only place that can report it: runTask receives the
  // already-tokenized task, so its own pass finds nothing new and a line
  // guarded there never renders. Without this, the user sees a `<PII_1>` they
  // never typed and no statement of what it stood for — and a redaction
  // invisible in your own request is indistinguishable from the agent
  // misreading you.
  if (taskTokens.length > 0) {
    const shown = taskTokens
      .slice(0, 4)
      .map((e) => `"${maskSample(e.original)}" → ${e.token}`)
      .join(", ");
    const more = taskTokens.length > 4 ? ` (+${taskTokens.length - 4} more)` : "";
    emit({
      kind: "entry",
      entry: {
        id: `p-${Date.now()}`,
        role: "system",
        text:
          `Task privacy: ${taskTokens.length} value(s) replaced before the model saw your request — ` +
          `${shown}${more}. The token is swapped back automatically when an action types it, ` +
          `so the task still uses your real value.`,
      },
    });
  }

  try {
    await runTask(tokenizedTask, tabId, {
      settings,
      emit,
      askConfirm,
      signal: abort.signal,
      // Bind the privacy toggles at run start so offscreen redaction honors
      // the user's settings rather than always running with defaults.
      captureScreenshot: (id) =>
        captureAndProcessScreenshot(id, settings.privacy, settings.fullPageCapture),
      recordAudit: recordAuditEntry,
      reportTally: (tally) => {
        runTally = tally;
      },
      history: conversationMemory,
    });
  } catch (error) {
    emit({
      kind: "entry",
      entry: {
        id: `err-${Date.now()}`,
        role: "error",
        text: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    running = false;
    const wasAborted = abort?.signal.aborted === true;
    abort = null;

    // Save session to history.
    const lastEntry = transcript.filter((e) => e.role === "assistant").pop();
    const hasError = transcript.some((e) => e.role === "error");
    await saveSession({
      id: `session-${taskStartTime}`,
      // Store the tokenized task so raw PII the user typed into the prompt
      // never meets chrome.storage. The transcript + summary are already
      // tokenized (the model replies and the user line both carry tokens).
      task: tokenizedTask,
      startedAt: taskStartTime,
      completedAt: Date.now(),
      status: hasError ? "failed" : wasAborted ? "stopped" : "completed",
      transcript: [...transcript],
      summary: lastEntry?.text?.slice(0, 200) ?? "Task completed",
      // The agent's tally is authoritative; the frame sum is the fallback for a
      // run that died before reporting (and undercounts once entries evict).
      piiRedacted:
        reportedTally()?.total ?? auditEntries.reduce((sum, e) => sum + e.redactedCount, 0),
      durationMs: Date.now() - taskStartTime,
    });

    // Conversation memory: remember this exchange so a follow-up task can
    // continue the chat. Compact summaries only, capped to the last 3.
    const lastAssistant = [...transcript].reverse().find((e) => e.role === "assistant");
    if (lastAssistant?.text) {
      conversationMemory.push({
        task: tokenizedTask.slice(0, CONVERSATION_TASK_MAX),
        answer: lastAssistant.text.slice(0, CONVERSATION_ANSWER_MAX),
        timestamp: Date.now(),
      });
      if (conversationMemory.length > CONVERSATION_MEMORY_MAX) conversationMemory.shift();
    }

    // Emit the privacy audit before status so the panel can render it.
    if (auditEntries.length > 0) emitPrivacyAudit();

    // ── Self-Improvement: Record experience and run reflection ──
    if (lastExperience) {
      try {
        // Store the experience in memory.
        await recordExperience(lastExperience);

        // Count prior visits (this run is already stored, so subtract one) —
        // site-pattern rules require evidence across visits.
        const domainExperiences = await getExperiencesForDomain(lastExperience.domain);
        const priorVisitCount = Math.max(0, domainExperiences.length - 1);

        // Run reflection to generate new rules. Prior experiences (excluding
        // this run) give repeated-failure rules their cross-visit evidence.
        const existingRules = await getLearnedRules();
        const thisExperience = lastExperience;
        const priorExperiences = domainExperiences.filter((e) => e.id !== thisExperience.id);
        const reflectionResult = reflectOnRun(
          thisExperience,
          existingRules,
          priorVisitCount,
          priorExperiences,
        );

        // Apply new rules to the rules store.
        if (reflectionResult.newRules.length > 0) {
          await applyReflectionResults(reflectionResult);
          console.log(`[PRY] Reflection: ${reflectionResult.newRules.length} new rules generated.`);
        }

        // Emit learning stats to the panel.
        await emitLearningStats(reflectionResult.summary);

        // ── Semantic learning (Reflexion-style) ──
        // Failed runs get a one-shot LLM lesson pass (the planner explains
        // what the next run should do differently); successful runs deposit a
        // compact sanitized trajectory for few-shot replay. Both are rare,
        // capped, and egress-metered.
        try {
          if (!lastExperience.taskSuccess) {
            const planner = createPlanner(settings);
            const lessons = await generateLessons(planner, lastExperience);
            if (lessons.length > 0) {
              await recordLessons(lastExperience.domain, lastExperience.pageType, lessons);
              // Honest egress: the lesson prompt/response crossed the wire.
              const lessonBytes = new Blob([
                JSON.stringify(lessons),
              ]).size;
              emit({ kind: "egress", bytes: (lastExperience.egressBytes ?? 0) + lessonBytes });
              console.log(`[PRY] Reflection: ${lessons.length} lesson(s) generated.`);
            }
          } else {
            const steps = lastExperience.actions
              .map((a) => `${a.tool}${a.success ? "" : "✗"}`)
              .slice(0, 8)
              .join(" → ");
            const answer =
              [...transcript].reverse().find((e) => e.role === "assistant")?.text ?? "";
            if (steps) {
              await recordTrajectory({
                domain: lastExperience.domain,
                pageType: lastExperience.pageType,
                task: lastExperience.task.slice(0, 200),
                steps,
                answer,
              });
            }
          }
        } catch (err) {
          console.warn("[PRY] Semantic learning failed:", err);
        }
      } catch (err) {
        console.warn("[PRY] Reflection failed:", err);
      }
      lastExperience = null;
    }

    // Nothing is waiting on an answer once the run is over.
    for (const resolve of pendingConfirms.values()) resolve(false);
    pendingConfirms.clear();
    emit({ kind: "status", running: false });
  }
}

chrome.runtime.onMessage.addListener(
  (command: PanelCommand, _sender, sendResponse: (r: unknown) => void) => {
    // ─── Active Tripwire Egress Alert from MAIN world ───
    if ((command as any).type === "TRIPWIRE_ALERT") {
      const detail = (command as any).detail;
      if (detail) {
        handleTripwireAlert({
          url: String(detail.url ?? ""),
          method: String(detail.method ?? "REQUEST"),
          piiType: String(detail.piiType ?? "pii"),
          sample: String(detail.sample ?? ""),
          timestamp: Number(detail.timestamp) || Date.now(),
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    switch (command.kind) {
      case "run":
        void start(command.task, command.tabId);
        sendResponse({ ok: true });
        return false;

      case "stop":
        abort?.abort();
        for (const resolve of pendingConfirms.values()) resolve(false);
        pendingConfirms.clear();
        running = false;
        emit({ kind: "status", running: false });
        emit({
          kind: "entry",
          entry: { id: `s-${Date.now()}`, role: "system", text: "Stopped." },
        });
        sendResponse({ ok: true });
        return false;

      case "reset":
        abort?.abort();
        transcript = [];
        conversationMemory.length = 0;
        running = false;
        tripwireAggregator.reset();
        tripwireLog.length = 0;
        tripwireEntryCreated = false;
        sendResponse({ ok: true });
        return false;

      case "confirm-reply": {
        const resolve = pendingConfirms.get(command.id);
        pendingConfirms.delete(command.id);
        resolve?.(command.approved);
        sendResponse({ ok: true });
        return false;
      }

      case "get-state": {
        // Settings ride along: the side panel's voice bootstrap reads them
        // from here (they were missing once — the mic button could never
        // appear because elevenlabs settings were always undefined).
        void loadSettings().then((settings) => {
          sendResponse({ transcript, running, settings });
        }).catch(() => {
          sendResponse({ transcript, running });
        });
        return true; // async response
      }

      case "get-history":
        void getSessions().then((sessions) => sendResponse({ sessions }));
        return true;

      case "delete-history": {
        const histCmd = command as { kind: string; sessionId?: string; clearAll?: boolean };
        if (histCmd.clearAll) {
          void clearHistory().then(() => sendResponse({ ok: true }));
        } else if (histCmd.sessionId) {
          void deleteSession(histCmd.sessionId).then(() => sendResponse({ ok: true }));
        }
        return true;
      }

      case "get-learning-stats":
        void (async () => {
          const stats = await getMemoryStats();
          const rulesSummary = await getRulesSummary();
          const [lessons, trajectories] = await Promise.all([getLessons(), getTrajectories()]);
          const { [LAST_REFLECTION_KEY]: lastReflection } = await chrome.storage.local.get(LAST_REFLECTION_KEY);
          sendResponse({
            stats,
            rulesSummary,
            lastReflection: lastReflection ?? "",
            lessons: {
              total: lessons.length,
              recent: lessons.slice(0, 5).map((l) => ({
                domain: l.domain,
                pageType: l.pageType,
                text: l.text,
                createdAt: l.createdAt,
              })),
            },
            trajectories: {
              total: trajectories.length,
              recent: trajectories.slice(0, 5).map((t) => ({
                domain: t.domain,
                pageType: t.pageType,
                task: t.task,
                steps: t.steps,
                createdAt: t.createdAt,
              })),
            },
          });
        })();
        return true;

      case "record-correction":
        void (async () => {
          const { recordUserCorrection } = await import("./experience-memory");
          const updated = await recordUserCorrection({
            experienceId: command.experienceId,
            kind: command.piiKind,
            label: command.label,
            correction: command.correction,
          });
          if (!updated) {
            sendResponse({ ok: false, reason: "No matching run found to correct." });
            return;
          }
          // Reflect over the corrected view so a false-positive rule lands now
          // and later runs suppress this detection on the same page type.
          const existingRules = await getLearnedRules();
          const reflectionResult = reflectOnRun(updated, existingRules);
          if (reflectionResult.newRules.length > 0) {
            await applyReflectionResults(reflectionResult);
          }
          await emitLearningStats(reflectionResult.summary);
          sendResponse({
            ok: true,
            experienceId: updated.id,
            rulesGenerated: reflectionResult.newRules.length,
          });
        })();
        return true;

      case "clear-learning":
        void (async () => {
          const { clearExperienceMemory } = await import("./experience-memory");
          const { clearLearnedRules } = await import("./learned-rules");
          await clearExperienceMemory();
          await clearLearnedRules();
          await chrome.storage.local.remove(LAST_REFLECTION_KEY);
          // The panel's button says "Reset learning memory (experiences + rules
          // + ledger)" and this handler did not clear the ledger, so the audit
          // trail was the one thing a reset could never reset: it grew to its
          // 500-entry cap forever and every exported proof carried runs the
          // user believed they had wiped.
          await clearLedger();
          sendResponse({ ok: true });
        })();
        return true;

      case "get-ledger":
        void (async () => {
          const ledgerSummary = await getLedgerSummary();
          sendResponse({ ledgerSummary });
        })();
        return true;

      case "export-ledger":
        void (async () => {
          const { exportLedger } = await import("./privacy-ledger");
          const json = await exportLedger();
          sendResponse({ ok: true, json });
        })();
        return true;

      case "record-outcome": {
        void (async () => {
          const { updateExperienceOutcome } = await import("./experience-memory");
          const updated = await updateExperienceOutcome(
            command.experienceId,
            command.helpful,
          );
          if (updated && lastExperience?.id === command.experienceId && !command.helpful) {
            lastExperience.taskSuccess = false;
          }
          if (updated && !command.helpful) {
            emit({
              kind: "entry",
              entry: {
                id: `fb-${Date.now()}`,
                role: "system",
                text: "Feedback noted: this run did not satisfy you — recorded as a failure so the learning loop won't trust its rules.",
              },
            });
          }
          sendResponse({ ok: updated });
        })();
        return true;
      }

      case "get-tripwire-log":
        sendResponse({
          alerts: tripwireLog,
          summary: tripwireAggregator.summary(),
        });
        return false;

      case "get-audit":
        // Re-serve the current run's audit on demand. The panel asks for this
        // when the user opens Privacy Audit, so the evidence is still there
        // after a panel reload (it used to be a broadcast-only payload, and a
        // panel that missed the event showed an empty audit).
        sendResponse({ audit: buildPrivacyAudit() });
        return false;

      case "get-wire-log":
        void wireRecords().then((records) => sendResponse({ records }));
        return true;

      case "clear-wire-log":
        clearWire();
        sendResponse({ ok: true });
        return false;

      case "capture-fullpage":
        void (async () => {
          const tabId = command.tabId;
          const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
          if (!tab || !tab.windowId) {
            sendResponse({ ok: false, error: "Tab not found" });
            return;
          }
          const { captureAndStitchFullPage } = await import("./stitch");
          const result = await captureAndStitchFullPage(tab.id!, tab.windowId);
          sendResponse({ ok: Boolean(result), result });
        })();
        return true;

      case "inspect-tab":
        void (async () => {
          const tabId = command.tabId;
          const fullPage = Boolean(command.fullPage);
          const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
          if (!tab || !tab.windowId) {
            sendResponse({ ok: false, error: "Tab not found" });
            return;
          }

          try {
            // Capture the tab the user is looking at (the inspector) so we can
            // hand focus back after full-page capture — the stitcher leaves
            // the scanned tab in the foreground, which read as "the inspector
            // navigated me away".
            let focusReturnTabId: number | null = null;
            if (fullPage) {
              const [focused] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
              focusReturnTabId = focused?.id ?? null;
            }

            // 1. Capture snapshot via content script
            const snapshotRes = await chrome.tabs.sendMessage(tabId, { kind: "snapshot" }).catch(() => null);
            const snapshot = snapshotRes && typeof snapshotRes === "object" && "snapshot" in snapshotRes
              ? (snapshotRes as any).snapshot
              : snapshotRes;

            // 2. Capture screenshot (fullpage or viewport)
            let rawDataUrl: string | null = null;
            let width = 0;
            let height = 0;
            let tilesCount = 1;
            let capturedFullPage = false;

            if (fullPage) {
              const { captureAndStitchFullPage } = await import("./stitch");
              const stitchRes = await captureAndStitchFullPage(tabId, tab.windowId).catch(() => null);
              if (stitchRes) {
                rawDataUrl = stitchRes.dataUrl;
                width = stitchRes.width;
                height = stitchRes.height;
                tilesCount = stitchRes.tiles;
                capturedFullPage = true;
              }
            }

            if (!rawDataUrl) {
              const cap = await captureVisibleTab(tabId);
              if (cap) {
                rawDataUrl = cap.dataUrl;
                width = cap.width;
                height = cap.height;
              }
            }

            if (!rawDataUrl) {
              sendResponse({ ok: false, error: "Failed to capture tab screenshot." });
              return;
            }

            // Full-page capture scrolled the target tab into the foreground;
            // give the inspector its focus back before the heavy work below.
            if (focusReturnTabId !== null) {
              await chrome.tabs.update(focusReturnTabId, { active: true }).catch(() => undefined);
            }

            // 3. Sensitive regions & DPR
            const sensitiveData = await getSensitiveRegions(tabId);
            const dpr = sensitiveData?.dpr ?? 1;
            const sensitiveRegions = sensitiveData?.regions ?? [];

            // 4. Run through privacy pipeline. The inspector can capture a
            // stitched full-page image too, so it needs the SAME region→image
            // mapping the agent's capture path uses: without it, a full-page
            // inspect painted every text-PII box at a viewport-relative y on a
            // page-tall canvas (the misaligned redaction seen in the ledger).
            const settings = await loadSettings();
            const inspectorMapping = regionMappingFor({
              imageWidth: width,
              dpr,
              viewportWidth: sensitiveData?.viewportWidth ?? 0,
              scrollY: sensitiveData?.scrollY ?? Number.NaN,
              fullPage: capturedFullPage,
              imageHeight: height,
            });
            if (!inspectorMapping.valid || !sensitiveData || sensitiveData.failure) {
              throw new Error("Screenshot mapping unavailable: " +
                (sensitiveData?.failure ?? inspectorMapping.reasons.join(", ")));
            }
            const processed = await processScreenshot(
              rawDataUrl,
              width,
              height,
              sensitiveRegions,
              dpr,
              {
                destroyFaces: settings.privacy.destroyFaces,
                maskCredentials: settings.privacy.maskCredentials,
                showRedactionLabels: settings.privacy.showRedactionLabels,
              },
              inspectorMapping.scale,
              inspectorMapping.offsetY,
            );

            // 5. Run tokenization pass so vault and tokens are populated
            let tokenizedSnapshot = snapshot;
            if (snapshot && processed.detections.length > 0) {
              const tokenized = tokenizer.tokenizeDetections(snapshot, processed.detections);
              tokenizedSnapshot = tokenizer.redactVaultValuesInSnapshot({
                ...snapshot,
                text: tokenized.text,
                elements: tokenized.elements,
              });
            }
            const vaultEntries = tokenizer.getEntries();

            sendResponse({
              ok: true,
              result: {
                tab: { id: tab.id, title: tab.title, url: tab.url },
                original: rawDataUrl,
                redacted: processed.redactedDataUrl,
                // Lets the inspector state whether this frame can leave at all
                // instead of labelling every redaction "Shipped to planner".
                visionEnabled: settings.vision.enabled && VISION_SUPPORTED[settings.provider],
                width,
                height,
                tiles: tilesCount,
                detections: processed.detections,
                redactedCount: processed.redactedCount,
                processingTimeMs: processed.processingTimeMs,
                verification: processed.verification,
                vault: vaultEntries,
                snapshot: tokenizedSnapshot,
                // The RAW page text as perceived, pre-tokenization — the
                // inspector's Before view. The tokenized form above is the
                // After view. Without the raw half the Before/After switch
                // had nothing to switch to.
                snapshotBefore: snapshot
                  ? { url: snapshot.url, title: snapshot.title, text: snapshot.text, elements: snapshot.elements }
                  : undefined,
              },
            });
          } catch (err) {
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        return true;

      default:
        return false;
    }
  },
);
