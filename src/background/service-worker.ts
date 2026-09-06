import type {
  AgentEvent,
  PanelCommand,
  ProcessedScreenshotResult,
  Settings,
  TranscriptEntry,
  TripwireAlertDetail,
  VerificationResult,
} from "../shared/types";
import { createTripwireAggregator } from "./tripwire-aggregator";
import { normaliseSettings } from "../shared/types";
import { runTask } from "./agent";
import { createPlanner } from "./providers";
import { generateLessons } from "./lesson-generator";
import { getLessons, recordLessons } from "./lessons";
import { getTrajectories, recordTrajectory } from "./trajectories";
import { saveSession, getSessions, deleteSession, clearHistory } from "./history";
import { recordExperience, getMemoryStats, getExperiencesForDomain } from "./experience-memory";
import { reflectOnRun } from "./reflection";
import { getLedgerSummary, recordRedaction } from "./privacy-ledger";
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
// One live transcript entry instead of one per intercepted request, plus a
// capped detail log for the radar drawer.
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
      // Text deltas append; step updates replace.
      if (event.text !== undefined) {
        entry.text = entry.role === "assistant" ? entry.text + event.text : event.text;
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
 * Ensure the offscreen document exists. Only the service worker can
 * create offscreen documents via chrome.offscreen.createDocument.
 */
async function ensureOffscreenDocument(): Promise<void> {
  try {
    const existingContexts = await (chrome.runtime as any).getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existingContexts?.length > 0) return;
  } catch {
    // getContexts may not be available in older Chrome versions.
  }

  try {
    await (chrome.offscreen as any).createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS", "BLOBS"],
      justification: "Canvas screenshot redaction, Tesseract OCR verification, and face detection",
    });
  } catch {
    // May already exist.
  }
}

/**
 * Capture the visible tab area. This MUST run in the service worker
 * because chrome.tabs.captureVisibleTab is not available in content scripts.
 */
async function captureVisibleTab(): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: "png" });

    // Get image dimensions by loading into an offscreen canvas.
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();

    return { dataUrl, width, height };
  } catch {
    return null;
  }
}

/**
 * Process a screenshot through the offscreen document's privacy pipeline.
 * Returns the redacted image and detection results.
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

    // Send the screenshot + sensitive regions + DPR to the offscreen document.
    chrome.runtime.sendMessage({
      type: "process-screenshot",
      requestId,
      dataUrl,
      width,
      height,
      sensitiveRegions,
      dpr,
    });
  });
}

/**
 * Get sensitive element positions from the content script.
 * Returns bounding boxes of password fields, credit cards, ID numbers, etc.
 * Every round trip is bounded — a hung content script degrades to "no
 * regions" (capture still proceeds) instead of hanging the run forever.
 */
async function getSensitiveRegions(tabId: number): Promise<{
  regions: Array<{ x: number; y: number; width: number; height: number; kind: string; label: string }>;
  dpr: number;
} | null> {
  // Distinguish "no receiver" (content script not injected — reinject) from
  // "receiver busy" (script exists but hung — reinjecting would only create a
  // duplicate listener, so we skip and let the region call time out gracefully).
  const callContent = (message: unknown, timeoutMs = 15000): Promise<
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
    const ping = await callContent({ kind: "ping" });
    if (!ping.ok && ping.reason === "error") {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      // Wait for content script to initialize.
      await new Promise((r) => setTimeout(r, 100));
    }

    const result = (await callContent({ kind: "get-sensitive-regions" })) as
      | { ok: true; value: { sensitiveRegions?: unknown[]; dpr?: number } }
      | { ok: false; reason: "timeout" | "error" };
    if (!result.ok || !result.value.sensitiveRegions) {
      console.log("[PRY] No sensitive regions returned from content script");
      return null;
    }
    console.log(`[PRY] Content script found ${(result.value.sensitiveRegions as unknown[]).length} sensitive regions, DPR=${result.value.dpr}`);
    return { regions: result.value.sensitiveRegions as never, dpr: result.value.dpr ?? 1 };
  } catch (err) {
    console.warn("[PRY] getSensitiveRegions failed:", err);
    return null;
  }
}

/**
 * Capture and process a screenshot in one call.
 * Returns both original (for audit comparison) and processed (redacted).
 */
export async function captureAndProcessScreenshot(): Promise<{
  original: string;
  processed: ProcessedScreenshotResult;
} | null> {
  const captured = await captureVisibleTab();
  if (!captured) return null;

  // Get sensitive regions + DPR from the content script.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sensitiveData = tab?.id ? await getSensitiveRegions(tab.id) : null;
  const dpr = sensitiveData?.dpr ?? 1;
  const sensitiveRegions = sensitiveData?.regions ?? [];

  console.log(`[PRY] Screenshot: ${captured.width}x${captured.height} @ ${dpr}x DPR, ${sensitiveRegions.length} sensitive regions found`);

  const processed = await processScreenshot(
    captured.dataUrl, captured.width, captured.height, sensitiveRegions, dpr,
  );
  return { original: captured.dataUrl, processed };
}

// ─── Privacy Audit Collector ────────────────────────────────────────────────

interface AuditEntry {
  original?: string;
  redacted?: string;
  detections: Array<{ kind: string; label: string; confidence: number }>;
  tokens: Array<{ token: string; kind: string; sample?: string }>;
  redactedCount: number;
  verification?: VerificationResult;
  timestamp: number;
}

let auditEntries: AuditEntry[] = [];
let taskStartTime = 0;

const MAX_AUDIT_ENTRIES = 10;

function recordAuditEntry(data: {
  original?: string;
  redacted?: string;
  detections: Array<{ kind: string; label: string; confidence: number }>;
  tokens: Array<{ token: string; kind: string; sample?: string }>;
  redactedCount: number;
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

function emitPrivacyAudit(): void {
  const allDetections: Array<{ kind: string; label: string; confidence: number }> = [];
  const allTokens: Array<{ token: string; kind: string; sample?: string }> = [];
  let totalRedacted = 0;

  for (const entry of auditEntries) {
    allDetections.push(...entry.detections);
    allTokens.push(...entry.tokens);
    totalRedacted += entry.redactedCount;
  }

  // Take at most 5 screenshots for the audit (to keep the UI manageable).
  const screenshots = auditEntries
    .filter((e) => e.original || e.redacted)
    .slice(-5)
    .map((e) => ({
      original: e.original,
      redacted: e.redacted,
      timestamp: e.timestamp,
    }));

  // Latest re-OCR verification result, shown as a proof badge in the audit.
  const lastVerification = [...auditEntries].reverse().find((e) => e.verification)?.verification;

  emit({
    kind: "privacy-audit",
    audit: {
      screenshots,
      allDetections,
      allTokens,
      totalRedacted,
      totalScreenshots: auditEntries.length,
      totalPIIDetections: allDetections.length,
      durationMs: Date.now() - taskStartTime,
      verification: lastVerification,
    },
  });
}

// ─── Agent Loop ──────────────────────────────────────────────────────────────

async function start(task: string, tabId: number): Promise<void> {
  if (running) return;

  const settings = await loadSettings();

  running = true;
  abort = new AbortController();
  taskStartTime = Date.now();
  auditEntries = [];
  emit({ kind: "status", running: true });
  emit({ kind: "entry", entry: { id: `u-${Date.now()}`, role: "user", text: task } });

  try {
    await runTask(task, tabId, {
      settings,
      emit,
      askConfirm,
      signal: abort.signal,
      captureScreenshot: captureAndProcessScreenshot,
      recordAudit: recordAuditEntry,
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
      task,
      startedAt: taskStartTime,
      completedAt: Date.now(),
      status: hasError ? "failed" : wasAborted ? "stopped" : "completed",
      transcript: [...transcript],
      summary: lastEntry?.text?.slice(0, 200) ?? "Task completed",
      piiRedacted: auditEntries.reduce((sum, e) => sum + e.redactedCount, 0),
      durationMs: Date.now() - taskStartTime,
    });

    // Conversation memory: remember this exchange so a follow-up task can
    // continue the chat. Compact summaries only, capped to the last 3.
    const lastAssistant = [...transcript].reverse().find((e) => e.role === "assistant");
    if (lastAssistant?.text) {
      conversationMemory.push({
        task: task.slice(0, CONVERSATION_TASK_MAX),
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

      case "get-state":
        sendResponse({ transcript, running });
        return false;

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
          sendResponse({ ok: true });
        })();
        return true;

      case "get-ledger":
        void (async () => {
          const ledgerSummary = await getLedgerSummary();
          sendResponse({ ledgerSummary });
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

      default:
        return false;
    }
  },
);
