import type { AgentEvent, PanelCommand, TranscriptEntry, TripwireAlertDetail } from "../shared/types";
import { accuracyMetrics } from "../shared/metrics";

// ─── DOM References ────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const transcriptEl = $("transcript");
const emptyEl = $("empty");
const taskInput = $<HTMLTextAreaElement>("task-input");
const runBtn = $("run-btn");
const stopBtn = $("stop-btn");

// ─── Voice (ElevenLabs, hack branch) ───────────────────────────────────────
// The whole voice stack is feature-flagged on settings.elevenlabs.sttEnabled /
// .ttsEnabled. Until those are on, no Scribe WS, no Flash TTS, no mic usage.
import type { VoiceController } from "./voice-controller";
let voice: VoiceController | null = null;
let voiceTtsCtx: AudioContext | null = null;
let voiceTtsGain: GainNode | null = null;

async function bootstrapVoice(): Promise<void> {
  const settings = (await send({ kind: "get-state" })) as { settings?: import("../shared/types").Settings } | undefined;
  const el = settings?.settings?.elevenlabs;
  if (!el?.apiKey || !el.voiceId || (!el.sttEnabled && !el.ttsEnabled)) return;

  const { VoiceController } = await import("./voice-controller");
  const micBtn = $<HTMLButtonElement>("mic-btn");

  voice = new VoiceController({
    apiKey: el.apiKey,
    voiceId: el.voiceId,
    submitTask: (task) => void submit(task),
    setUserEntryText: (text) => {
      if (taskInput) taskInput.value = text;
    },
    speakAssistantText: (text) => {
      // TTS playback pipe: each chunk is scheduled on a single shared
      // AudioContext so playback is continuous across chunks (no gap
      // between the first frame and the rest).
      if (!voiceTtsCtx) {
        const Ctor = (window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
        if (!Ctor) return;
        voiceTtsCtx = new Ctor({ sampleRate: 16000 });
        voiceTtsGain = voiceTtsCtx.createGain();
        voiceTtsGain.gain.value = 1;
        voiceTtsGain.connect(voiceTtsCtx.destination);
      }
    },
    callbacks: {
      onStateChange: (state) => {
        if (micBtn) {
          micBtn.dataset.state = state;
          micBtn.classList.toggle("listening", state === "listening" || state === "connecting");
        }
      },
      onError: (msg) => emitLocalStatus(msg),
    },
  });

  // Mic button: hold-to-talk. Press to start, release to commit.
  if (micBtn) {
    const press = async (ev: PointerEvent) => {
      ev.preventDefault();
      micBtn.setPointerCapture(ev.pointerId);
      try {
        await voice!.startListening();
      } catch (err) {
        emitLocalStatus(err instanceof Error ? err.message : String(err));
      }
    };
    const release = async () => {
      try {
        await voice!.stopListening();
      } catch {
        voice!.cancel();
      }
    };
    micBtn.addEventListener("pointerdown", (e) => void press(e));
    micBtn.addEventListener("pointerup", () => void release());
    micBtn.addEventListener("pointercancel", () => voice?.cancel());
    micBtn.hidden = false;
  }
}

/** Local status line for voice events. Surfaces in the chat transcript as a
 *  system entry so mic-permission denials and TTS errors are visible
 *  (console.warn alone is invisible mid-demo). */
function emitLocalStatus(text: string): void {
  console.warn("[PRY voice]", text);
  emit({
    kind: "entry",
    entry: {
      id: `voice-${Date.now()}`,
      role: "system",
      text: `Voice: ${text}`,
    },
  });
}

/** Speak assistant text once a final answer arrives, gated on settings. */
async function maybeSpeak(text: string): Promise<void> {
  if (!voice) return;
  const settings = (await send({ kind: "get-state" })) as { settings?: import("../shared/types").Settings } | undefined;
  if (!settings?.settings?.elevenlabs?.ttsEnabled) return;
  await voice.speak(text);
}
const statusDot = $("status-dot");
const statusText = $("status-text");
const confirmEl = $("confirm");
const confirmText = $("confirm-text");
const privacyAuditEl = $("privacy-audit");
const historyPanel = $("history-panel");
const learningDashboardEl = $("learning-dashboard");
const tripwirePanel = $("tripwire-panel");
const egressBadge = $("egress-badge");
const perceptionCounter = $("perception-counter");

/** Rendered entries, so patches can find their node without a re-render. */
const nodes = new Map<string, HTMLElement>();
const rawTexts = new Map<string, string>();
let pendingConfirmId: string | null = null;
let perceptionCount = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────

function send(command: PanelCommand): Promise<unknown> {
  return chrome.runtime.sendMessage(command).catch(() => undefined);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatMarkdown(text: string): string {
  if (!text) return "";

  // 1. Extract and stash fenced code blocks
  const codeBlocks: string[] = [];
  let processed = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const placeholder = `@@CODE_BLOCK_${codeBlocks.length}@@`;
    const escapedCode = escapeHtml(code.trim());
    const langLabel = lang ? `<div class="code-header"><span class="code-lang">${escapeHtml(lang.toUpperCase())}</span></div>` : "";
    codeBlocks.push(`
      <div class="chat-code-block">
        ${langLabel}
        <pre><code>${escapedCode}</code></pre>
      </div>
    `);
    return placeholder;
  });

  // 2. Escape regular HTML characters
  processed = escapeHtml(processed);

  // 3. Highlight PRY Vault Tokens (e.g. <CRED_1>, <ID_2>, <EMAIL_1>)
  processed = processed.replace(/&lt;([A-Z]+_\d+)&gt;/g, '<span class="vault-token-badge">&lt;$1&gt;</span>');

  // 4. Inline code: `code`
  processed = processed.replace(/`([^`\n]+)`/g, '<code class="chat-inline-code">$1</code>');

  // 5. Bold: **text** or __text__
  processed = processed.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  processed = processed.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // 6. Italic: *text* or _text_
  processed = processed.replace(/(^|[^*])\*([^*]+)\*(?=[^*]|$)/g, "$1<em>$2</em>");

  // 7. Headers: ###, ##, #
  processed = processed.replace(/^### (.*$)/gim, '<h5 class="chat-h3">$1</h5>');
  processed = processed.replace(/^## (.*$)/gim, '<h4 class="chat-h2">$1</h4>');
  processed = processed.replace(/^# (.*$)/gim, '<h3 class="chat-h1">$1</h3>');

  // 8. Bullet items: - item or * item
  processed = processed.replace(/^[*-]\s+(.*$)/gim, '<li class="chat-li">$1</li>');

  // 9. Numbered items: 1. item
  processed = processed.replace(/^\d+\.\s+(.*$)/gim, '<li class="chat-oli">$1</li>');

  // 10. Wrap lists
  processed = processed.replace(/((?:<li class="chat-li">.*?<\/li>\s*)+)/g, '<ul class="chat-ul">$1</ul>');
  processed = processed.replace(/((?:<li class="chat-oli">.*?<\/li>\s*)+)/g, '<ol class="chat-ol">$1</ol>');

  // 11. Paragraph breaks
  const parts = processed.split(/\n{2,}/);
  processed = parts
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return "";
      if (
        trimmed.startsWith("<div") ||
        trimmed.startsWith("<ul") ||
        trimmed.startsWith("<ol") ||
        trimmed.startsWith("<h3") ||
        trimmed.startsWith("<h4") ||
        trimmed.startsWith("<h5") ||
        trimmed.startsWith("@@CODE_BLOCK_")
      ) {
        return trimmed;
      }
      return `<p class="chat-p">${trimmed.replace(/\n/g, "<br/>")}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  // 12. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`@@CODE_BLOCK_${i}@@`, codeBlocks[i]);
  }

  return processed;
}

type PanelId = "privacy-audit" | "learning-dashboard" | "tripwire-panel" | "history-panel";

function setActivePanel(panelId: PanelId | null): void {
  const isCurrentlyOpen = (id: PanelId): boolean => {
    switch (id) {
      case "privacy-audit": return !privacyAuditEl.classList.contains("hidden");
      case "learning-dashboard": return !learningDashboardEl.classList.contains("hidden");
      case "tripwire-panel": return !tripwirePanel?.classList.contains("hidden");
      case "history-panel": return !historyPanel.classList.contains("hidden");
    }
  };

  const target = panelId && isCurrentlyOpen(panelId) ? null : panelId;

  privacyAuditEl.classList.add("hidden");
  learningDashboardEl.classList.add("hidden");
  tripwirePanel?.classList.add("hidden");
  historyPanel.classList.add("hidden");

  $("btn-perception")?.classList.toggle("active", target === "privacy-audit");
  $("btn-learning")?.classList.toggle("active", target === "learning-dashboard");
  $("btn-radar")?.classList.toggle("active", target === "tripwire-panel");
  $("btn-history")?.classList.toggle("active", target === "history-panel");

  if (!target) return;

  switch (target) {
    case "privacy-audit":
      privacyAuditEl.classList.remove("hidden");
      break;
    case "learning-dashboard":
      learningDashboardEl.classList.remove("hidden");
      void refreshLearningDashboard();
      break;
    case "tripwire-panel":
      tripwirePanel?.classList.remove("hidden");
      void refreshTripwireLog();
      break;
    case "history-panel":
      historyPanel.classList.remove("hidden");
      void loadHistory();
      break;
  }
}

function formatEgress(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

function atBottom(): boolean {
  return (
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60
  );
}

function updatePerceptionCount() {
  perceptionCount++;
  if (perceptionCounter) perceptionCounter.textContent = `PERCEPTION N° ${String(perceptionCount).padStart(2, "0")}`;
}

// ─── Transcript Rendering ──────────────────────────────────────────────────

const GLYPHS: Record<string, string> = {
  click: "→",
  type: "⌨",
  select: "▾",
  scroll: "↕",
  key: "⏎",
  find_text: "⌕",
  wait: "◷",
  read_page: "◉",
  navigate: "⇢",
  go_back: "⇠",
  open_tab: "＋",
  switch_tab: "⇄",
  close_tab: "×",
  list_tabs: "☰",
};

function render(entry: TranscriptEntry): void {
  emptyEl.classList.add("hidden");
  const stick = atBottom();

  let node = nodes.get(entry.id);
  if (!node) {
    node = document.createElement("div");
    node.className = `entry ${entry.role}`;
    if (entry.role === "step") {
      node.innerHTML = `<span class="glyph"></span><span class="detail"></span>`;
    } else if (entry.role === "assistant") {
      node.innerHTML = `
        <div class="assistant-header">
          <div class="assistant-tag">
            <span class="assistant-dot"></span>
            <span class="assistant-name">PRY AGENT</span>
          </div>
          <button class="btn-copy-chat" type="button" title="Copy response">
            <span class="copy-icon">📋</span>
            <span class="copy-label">Copy</span>
          </button>
        </div>
        <div class="assistant-body"></div>
      `;
      const copyBtn = node.querySelector<HTMLButtonElement>(".btn-copy-chat");
      copyBtn?.addEventListener("click", () => {
        const textToCopy = rawTexts.get(entry.id) ?? "";
        if (navigator.clipboard) {
          void navigator.clipboard.writeText(textToCopy);
          const label = copyBtn.querySelector(".copy-label");
          if (label) {
            label.textContent = "✓ Copied";
            setTimeout(() => { label.textContent = "Copy"; }, 1600);
          }
        }
      });
    } else if (entry.role === "user") {
      node.innerHTML = `
        <div class="user-bubble">
          <div class="user-tag">YOU</div>
          <div class="user-text"></div>
        </div>
      `;
    } else if (entry.role === "egress") {
      node.innerHTML = `
        <div class="egress-row">
          <span class="egress-glyph">🛡️</span>
          <div class="egress-body"></div>
          <button class="egress-inspect" type="button" title="Open the live egress radar">RADAR →</button>
        </div>
      `;
      node.querySelector(".egress-inspect")?.addEventListener("click", () => {
        setActivePanel("tripwire-panel");
      });
    }
    nodes.set(entry.id, node);
    transcriptEl.appendChild(node);
  }

  rawTexts.set(entry.id, entry.text);

  // Voice-out: speak a final assistant answer once it arrives. We gate on
  // entry.role === "assistant" (not "step") so step-card narration lines
  // stay silent unless we later want to read them out too.
  if (entry.role === "assistant") {
    void maybeSpeak(entry.text);
  }

  if (entry.role === "step") {
    const glyph = node.querySelector(".glyph");
    if (glyph) glyph.textContent = GLYPHS[entry.action ?? ""] ?? "•";
    const detail = node.querySelector(".detail");
    if (detail) detail.textContent = entry.text;
    node.classList.toggle("pending", entry.pending === true);
  } else if (entry.role === "assistant") {
    const body = node.querySelector(".assistant-body");
    if (body) body.innerHTML = formatMarkdown(entry.text);
  } else if (entry.role === "user") {
    const userTextEl = node.querySelector(".user-text");
    if (userTextEl) userTextEl.textContent = entry.text;
  } else if (entry.role === "egress") {
    const body = node.querySelector(".egress-body");
    if (body) body.textContent = entry.text;
  } else {
    node.textContent = entry.text;
  }

  if (stick) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function setRunning(running: boolean): void {
  statusDot?.classList.toggle("running", running);
  if (statusText) statusText.textContent = running ? "RUNNING" : "IDLE";
  runBtn?.classList.toggle("hidden", running);
  stopBtn?.classList.toggle("hidden", !running);
  if (taskInput) taskInput.disabled = running;
}

// ─── Privacy Audit Rendering ───────────────────────────────────────────────

const KIND_EMOJI: Record<string, string> = {
  face: "👤",
  credential: "🔑",
  id_number: "🪪",
  api_key: "🗝️",
  pii_text: "📝",
  input_field: "⌨",
};

function renderPrivacyAudit(audit: {
  screenshots: Array<{ original?: string; redacted?: string; timestamp: number }>;
  allDetections: Array<{ kind: string; label: string; confidence: number }>;
  allTokens: Array<{ token: string; kind: string }>;
  totalRedacted: number;
  totalScreenshots: number;
  totalPIIDetections: number;
  durationMs: number;
  verification?: {
    verified: boolean;
    regionsChecked: number;
    regionsRedacted: number;
    leakedPatterns: string[];
    confidence: number;
    summary: string;
    timestamp: number;
  };
}): void {
  // Summary stats.
  const summaryEl = $("audit-summary");
  const uniqueTokenCount = new Set(audit.allTokens.map((t) => t.token)).size;
  summaryEl.innerHTML = `
    <div class="audit-stat">
      <span class="number">${audit.totalPIIDetections}</span>
      <span class="label">PII Detected</span>
    </div>
    <div class="audit-stat">
      <span class="number">${audit.totalRedacted}</span>
      <span class="label">Items Redacted</span>
    </div>
    <div class="audit-stat">
      <span class="number">${uniqueTokenCount}</span>
      <span class="label">Tokens Created</span>
    </div>
  `;

  // Screenshots before/after.
  const screenshotsEl = $("audit-screenshots");
  if (audit.screenshots.length > 0) {
    screenshotsEl.innerHTML = `<h4>Before / After Redaction</h4>`;
    for (const shot of audit.screenshots) {
      const pair = document.createElement("div");
      pair.className = "screenshot-pair";
      if (shot.original) {
        pair.innerHTML += `
          <div class="shot">
            <img src="${shot.original}" alt="Original" />
            <div class="shot-label">Original</div>
          </div>`;
      }
      if (shot.redacted) {
        pair.innerHTML += `
          <div class="shot">
            <img src="${shot.redacted}" alt="Redacted (Shipped to Model)" />
            <div class="shot-label">Redacted</div>
          </div>`;
      }
      screenshotsEl.appendChild(pair);
    }
  } else {
    screenshotsEl.innerHTML = `<h4>Screenshots</h4><p class="empty-sub">No screenshots were sent during this task.</p>`;
  }

  // Detections list.
  const detectionsEl = $("audit-detections");
  if (audit.allDetections.length > 0) {
    detectionsEl.innerHTML = `<h4>Detected Regions</h4><div class="detection-list"></div>`;
    const list = detectionsEl.querySelector(".detection-list")!;
    for (const d of audit.allDetections) {
      const chip = document.createElement("div");
      chip.className = "detection-chip";
      const emoji = KIND_EMOJI[d.kind] ?? "📌";
      const label = d.label || d.kind;
      chip.innerHTML = `
        <span class="kind">${emoji} ${label}</span>
        <span class="conf">${Math.round(d.confidence * 100)}%</span>
      `;
      const fpBtn = document.createElement("button");
      fpBtn.type = "button";
      fpBtn.className = "fp-btn";
      fpBtn.textContent = "✕ not PII";
      fpBtn.dataset.kind = d.kind;
      fpBtn.dataset.label = label;
      fpBtn.addEventListener("click", () => void reportFalsePositive(fpBtn));
      chip.appendChild(fpBtn);
      list.appendChild(chip);
    }
  } else {
    detectionsEl.innerHTML = `<h4>Detected Regions</h4><p class="empty-sub">No sensitive regions detected.</p>`;
  }

  // Tokens list.
  const tokensEl = $("audit-tokens");
  if (audit.allTokens.length > 0) {
    tokensEl.innerHTML = `<h4>Token Vault</h4><div class="token-list"></div>`;
    const list = tokensEl.querySelector(".token-list")!;
    for (const tok of audit.allTokens as Array<{ token: string; kind: string; sample?: string }>) {
      const chip = document.createElement("div");
      chip.className = "token-chip";
      const kind = tok.kind === "pii_text" ? "PII text" : tok.kind === "id_number" ? "ID number" : tok.kind === "api_key" ? "API key" : tok.kind;
      chip.textContent = tok.sample
        ? `${tok.token} → ${tok.sample} (${kind})`
        : `${tok.token} (${kind})`;
      chip.title = "Raw value replaced by this token — never stored or sent";
      list.appendChild(chip);
    }
  } else {
    tokensEl.innerHTML = `<h4>Token Vault</h4><p class="empty-sub">No values needed tokenizing on this page.</p>`;
  }

  // Render non-intrusive interactive verification chip in transcript
  appendAuditVerificationChip(audit);
}

function appendAuditVerificationChip(audit: {
  totalRedacted: number;
  totalScreenshots: number;
  totalPIIDetections: number;
  allTokens: Array<{ token: string; kind: string }>;
  verification?: { verified: boolean; summary: string };
}): void {
  const chip = document.createElement("div");
  chip.className = "entry audit-chip";
  const verifiedBadge = audit.verification?.verified
    ? `<span class="chip-status ok">✓ ZERO-LEAK VERIFIED</span>`
    : `<span class="chip-status warn">🔒 PRIVACY AUDIT</span>`;
  const tokenCount = new Set(audit.allTokens.map((t) => t.token)).size;

  chip.innerHTML = `
    <div class="audit-chip-left">
      <div class="audit-chip-badge">${verifiedBadge}</div>
      <div class="audit-chip-stats">
        <span>🛡️ <strong>${audit.totalRedacted}</strong> Redacted</span>
        <span>🔑 <strong>${tokenCount}</strong> Vault Tokens</span>
        <span>📸 <strong>${audit.totalScreenshots}</strong> Frames</span>
      </div>
    </div>
    <button class="audit-chip-inspect-btn" type="button">INSPECT PROOF →</button>
  `;

  chip.querySelector(".audit-chip-inspect-btn")?.addEventListener("click", () => {
    setActivePanel("privacy-audit");
  });

  transcriptEl.appendChild(chip);
  if (atBottom()) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ─── Event Listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((event: AgentEvent) => {
  switch (event.kind) {
    case "entry":
      render(event.entry);
      break;

    case "patch": {
      const node = nodes.get(event.id);
      if (!node) break;
      if (event.text !== undefined) {
        if (node.classList.contains("assistant")) {
          const current = (rawTexts.get(event.id) ?? "") + event.text;
          rawTexts.set(event.id, current);
          const body = node.querySelector(".assistant-body");
          if (body) body.innerHTML = formatMarkdown(current);
        } else if (node.classList.contains("step")) {
          const current = (rawTexts.get(event.id) ?? "") + event.text;
          rawTexts.set(event.id, current);
          const detail = node.querySelector(".detail");
          if (detail) detail.textContent = current;
        } else if (node.classList.contains("egress")) {
          rawTexts.set(event.id, event.text ?? "");
          const body = node.querySelector(".egress-body");
          if (body) body.textContent = event.text ?? "";
        } else {
          node.textContent = event.text;
        }
      }
      if (event.pending !== undefined) node.classList.toggle("pending", event.pending);
      if (atBottom()) transcriptEl.scrollTop = transcriptEl.scrollHeight;
      break;
    }

    case "status":
      setRunning(event.running);
      break;

    case "egress":
      if (egressBadge) egressBadge.textContent = `${formatEgress(event.bytes)} EGRESS`;
      break;

    case "confirm":
      pendingConfirmId = event.id;
      if (confirmText) confirmText.textContent = event.summary;
      confirmEl.classList.remove("hidden");
      break;

    case "privacy-audit":
      renderPrivacyAudit(event.audit);
      break;

    case "learning-update":
      renderLearningDashboard(event.stats);
      break;

    case "tripwire-update":
      // Keep the radar drawer live when it is open; otherwise the next open
      // re-fetches the full log anyway.
      if (!tripwirePanel?.classList.contains("hidden")) {
        void refreshTripwireLog();
      }
      break;

    case "experience":
      renderOutcomeFeedback(event.experience as unknown as { id: string });
      break;
  }
});

// ─── Outcome Feedback (learns from the user, not just structure) ───────────

/**
 * After a run finishes, offer a quick "was this helpful?" row. The answer
 * overrides the structural success label in experience memory, so the learning
 * loop gets a real outcome signal and stops trusting rules from bad runs.
 */
function renderOutcomeFeedback(experience: { id?: string }): void {
  if (!experience?.id) return;
  document.getElementById("outcome-feedback")?.remove();

  const row = document.createElement("div");
  row.id = "outcome-feedback";
  row.className = "outcome-feedback";
  row.innerHTML = `
    <span class="outcome-label">Was this helpful?</span>
    <button type="button" class="outcome-btn" data-helpful="true">👍 Yes</button>
    <button type="button" class="outcome-btn" data-helpful="false">👎 No</button>
  `;

  const finish = (helpful: boolean): void => {
    void send({ kind: "record-outcome", experienceId: experience.id!, helpful });
    row.classList.add("done");
    const label = row.querySelector(".outcome-label");
    if (label) label.textContent = helpful ? "👍 Noted — thanks!" : "👎 Noted — recorded as a failure.";
    row.querySelectorAll(".outcome-btn").forEach((b) => b.remove());
  };

  row.querySelector<HTMLButtonElement>(".outcome-btn[data-helpful='true']")?.addEventListener("click", () => finish(true));
  row.querySelector<HTMLButtonElement>(".outcome-btn[data-helpful='false']")?.addEventListener("click", () => finish(false));

  transcriptEl.appendChild(row);
  if (atBottom()) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ─── Learning Dashboard ───────────────────────────────────────────────────

function renderLearningDashboard(stats: {
  totalRuns: number;
  successRate: number;
  piiDetected: number;
  piiRedacted: number;
  falsePositives: number;
  missedPII: number;
  sitesVisited: number;
  rulesLearned: number;
  improvementDelta: number;
  corrections?: number;
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
  lessons?: {
    total: number;
    recent: Array<{ domain: string; pageType: string; text: string; createdAt: number }>;
  };
  trajectories?: {
    total: number;
    recent: Array<{ domain: string; pageType: string; task: string; steps: string; createdAt: number }>;
  };
  lastReflection: string;
}): void {

  // Stats grid — precision/recall derived from measured outcomes, never asserted.
  const statsEl = $("learning-stats");
  const deltaClass = stats.improvementDelta > 0 ? "positive" : stats.improvementDelta < 0 ? "negative" : "";
  const deltaSign = stats.improvementDelta > 0 ? "+" : "";
  const { precision, recall } = accuracyMetrics(
    stats.piiRedacted,
    stats.falsePositives,
    stats.missedPII,
  );
  const metricClass = (v: number | null): string =>
    v === null ? "" : v >= 0.85 ? "positive" : v < 0.6 ? "negative" : "";
  const fmt = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

  statsEl.innerHTML = `
    <div class="learning-stat">
      <span class="number">${stats.totalRuns}</span>
      <span class="label">TOTAL RUNS</span>
    </div>
    <div class="learning-stat">
      <span class="number ${stats.successRate >= 80 ? "positive" : "negative"}">${stats.successRate}%</span>
      <span class="label">SUCCESS RATE</span>
    </div>
    <div class="learning-stat">
      <span class="number ${deltaClass}">${deltaSign}${Math.round(stats.improvementDelta * 100)}%</span>
      <span class="label">IMPROVEMENT</span>
    </div>
    <div class="learning-stat">
      <span class="number ${metricClass(precision)}">${fmt(precision)}</span>
      <span class="label">PRECISION</span>
    </div>
    <div class="learning-stat">
      <span class="number ${metricClass(recall)}">${fmt(recall)}</span>
      <span class="label">RECALL</span>
    </div>
    <div class="learning-stat">
      <span class="number">${stats.piiDetected}</span>
      <span class="label">PII DETECTED</span>
    </div>
    <div class="learning-stat">
      <span class="number positive">${stats.piiRedacted}</span>
      <span class="label">PII REDACTED</span>
    </div>
    <div class="learning-stat">
      <span class="number">${stats.rulesSummary.total}</span>
      <span class="label">RULES LEARNED</span>
    </div>
  `;

  // Learned rules — show the ACTUAL rules (what was learned), not just counts.
  const rulesEl = $("learning-rules");
  const categoryLabels: Record<string, string> = {
    pii_detection: "PII Detection",
    strategy: "Strategy",
    site_pattern: "Site Pattern",
    redaction: "Redaction",
    safety: "Safety",
  };
  if (stats.rulesSummary.total > 0) {
    rulesEl.innerHTML = `<h4>Learned Rules (${stats.rulesSummary.total})</h4><div class="rule-list"></div>`;
    const list = rulesEl.querySelector(".rule-list")!;
    const items = stats.rulesSummary.recent ?? [];
    if (items.length > 0) {
      for (const rule of items) {
        const item = document.createElement("div");
        item.className = "rule-item";
        const top = document.createElement("div");
        top.className = "rule-top";
        const tag = document.createElement("span");
        tag.className = `rule-tag ${rule.category}`;
        tag.textContent = categoryLabels[rule.category] ?? rule.category;
        const conf = document.createElement("span");
        conf.className = "rule-conf";
        conf.textContent = `conf ${Math.round(rule.confidence * 100)}%${rule.confirmedCount > 0 ? ` · confirmed ×${rule.confirmedCount}` : ""}`;
        top.appendChild(tag);
        top.appendChild(conf);
        const desc = document.createElement("span");
        desc.className = "rule-desc";
        desc.textContent = rule.description;
        item.appendChild(top);
        item.appendChild(desc);
        list.appendChild(item);
      }
    } else {
      // Fallback for producers that predate the rule-content field.
      for (const [cat, count] of Object.entries(stats.rulesSummary.byCategory)) {
        const chip = document.createElement("span");
        chip.className = `rule-chip ${cat}`;
        chip.textContent = `${categoryLabels[cat] ?? cat}: ${count}`;
        list.appendChild(chip);
      }
    }
    if (stats.rulesSummary.highConfidence > 0) {
      const badge = document.createElement("span");
      badge.className = "rule-chip";
      badge.style.cssText = "border-color: var(--color-teal); color: var(--color-teal);";
      badge.textContent = `${stats.rulesSummary.highConfidence} high-confidence`;
      list.appendChild(badge);
    }
  } else {
    rulesEl.innerHTML = `<h4>Learned Rules</h4><p class="empty-sub">No rules learned yet. Complete tasks to start improving.</p>`;
  }

  // User corrections — measured ground truth that feeds precision/recall.
  const note = document.createElement("p");
  note.className = "empty-sub";
  note.style.cssText = "margin:6px 0 0;";
  if ((stats.corrections ?? 0) > 0) {
    note.textContent = `${stats.corrections} user-flagged false positive(s) corrected across runs — each one taught a rule.`;
    rulesEl.appendChild(note);
  }

  // Measured false positives — checksum rejects + rule suppressions that
  // prevented over-redaction across all runs.
  if (stats.falsePositives > 0 && stats.rulesSummary.total > 0) {
    const note = document.createElement("p");
    note.className = "empty-sub";
    note.style.cssText = "margin:6px 0 0;";
    note.textContent = `False-positive filters avoided ${stats.falsePositives} lookalike(s) across runs (Verhoeff/Luhn checksums + learned rules).`;
    rulesEl.appendChild(note);
  }

  // Semantic lessons — Reflexion-style lessons learned from failed runs.
  const lessonsEl = $("learning-lessons");
  const lessonCount = stats.lessons?.total ?? 0;
  if (lessonCount > 0) {
    lessonsEl.innerHTML = `<h4>Lessons Learned (${lessonCount})</h4><div class="lesson-list"></div>`;
    const list = lessonsEl.querySelector(".lesson-list")!;
    for (const lesson of stats.lessons?.recent ?? []) {
      const item = document.createElement("div");
      item.className = "lesson-item";
      const top = document.createElement("div");
      top.className = "rule-top";
      const domain = document.createElement("span");
      domain.className = "rule-tag strategy";
      domain.textContent = lesson.domain;
      const page = document.createElement("span");
      page.className = "lesson-page";
      page.textContent = lesson.pageType || "any page";
      top.appendChild(domain);
      top.appendChild(page);
      const text = document.createElement("span");
      text.className = "lesson-text";
      text.textContent = lesson.text;
      item.appendChild(top);
      item.appendChild(text);
      list.appendChild(item);
    }
  } else {
    lessonsEl.innerHTML = `<h4>Lessons Learned</h4><p class="empty-sub">Failed runs teach lessons here — so far, none.</p>`;
  }

  // Replay library — successful trajectories reused as few-shot examples.
  const trajEl = $("learning-trajectories");
  const trajCount = stats.trajectories?.total ?? 0;
  if (trajCount > 0) {
    trajEl.innerHTML = `<h4>Replay Library (${trajCount})</h4><div class="traj-list"></div>`;
    const list = trajEl.querySelector(".traj-list")!;
    for (const t of stats.trajectories?.recent ?? []) {
      const item = document.createElement("div");
      item.className = "lesson-item";
      const top = document.createElement("div");
      top.className = "rule-top";
      const domain = document.createElement("span");
      domain.className = "rule-tag pii_detection";
      domain.textContent = t.domain;
      top.appendChild(domain);
      const task = document.createElement("span");
      task.className = "traj-task";
      task.textContent = t.task;
      const steps = document.createElement("span");
      steps.className = "traj-steps";
      steps.textContent = t.steps;
      item.appendChild(top);
      item.appendChild(task);
      item.appendChild(steps);
      list.appendChild(item);
    }
  } else {
    trajEl.innerHTML = `<h4>Replay Library</h4><p class="empty-sub">Successful runs deposit reusable action sequences here.</p>`;
  }

  // Last reflection.
  const reflectionEl = $("learning-reflection");
  if (stats.lastReflection) {
    reflectionEl.innerHTML = `
      <h4>Last Reflection</h4>
      <div class="reflection-text">${escapeHtml(stats.lastReflection)}</div>
    `;
  } else {
    reflectionEl.innerHTML = "";
  }

  // Privacy ledger.
  loadLedger();
}

// ─── Privacy Ledger Display ────────────────────────────────────────────────

async function loadLedger(): Promise<void> {
  const ledgerEl = $("ledger-section");
  const response = (await send({ kind: "get-ledger" })) as any;
  if (!response?.ledgerSummary) {
    ledgerEl.innerHTML = "";
    return;
  }
  const ls = response.ledgerSummary;

  const chainClass = ls.chainValid ? "verified" : "tampered";
  const chainLabel = ls.chainValid ? "INTACT" : "TAMPERED";

  ledgerEl.innerHTML = `
    <h4>Privacy Ledger</h4>
    <div class="ledger-summary">
      <div class="ledger-stat">
        <span class="number">${ls.totalEntries}</span>
        <span class="label">ENTRIES</span>
      </div>
      <div class="ledger-stat">
        <span class="number">${ls.totalDetections}</span>
        <span class="label">DETECTIONS</span>
      </div>
      <div class="ledger-stat">
        <span class="number">${ls.totalRedactions}</span>
        <span class="label">REDACTIONS</span>
      </div>
      <div class="ledger-stat">
        <span class="number">${ls.totalSnapshots}</span>
        <span class="label">SNAPSHOTS</span>
      </div>
      <div class="ledger-stat">
        <span class="number">${ls.totalActions}</span>
        <span class="label">ACTIONS</span>
      </div>
      <div class="ledger-stat">
        <span class="number ${chainClass}">${chainLabel}</span>
        <span class="label">CHAIN</span>
      </div>
    </div>
  `;
}

// ─── Confirm Dialog ────────────────────────────────────────────────────────

function answerConfirm(approved: boolean): void {
  if (!pendingConfirmId) return;
  void send({ kind: "confirm-reply", id: pendingConfirmId, approved });
  pendingConfirmId = null;
  confirmEl.classList.add("hidden");
}

$("confirm-yes").addEventListener("click", () => answerConfirm(true));
$("confirm-no").addEventListener("click", () => answerConfirm(false));

// ─── Audit Close ───────────────────────────────────────────────────────────

$("audit-close").addEventListener("click", () => {
  privacyAuditEl.classList.add("hidden");
});

// ─── Learning Dashboard ────────────────────────────────────────────────────

async function refreshLearningDashboard(): Promise<void> {
  // Fetch current learning stats and map raw MemoryStats fields to dashboard format.
  const response = (await send({ kind: "get-learning-stats" })) as any;
  if (response && response.stats) {
    const s = response.stats;
    renderLearningDashboard({
      totalRuns: s.totalRuns ?? 0,
      successRate: Math.round((s.averageSuccessRate ?? 0) * 100),
      piiDetected: s.totalPIIDetected ?? 0,
      piiRedacted: s.totalPIIRedacted ?? 0,
      falsePositives: s.totalFalsePositives ?? 0,
      missedPII: s.totalMissedPII ?? 0,
      sitesVisited: s.sitesVisited ?? 0,
      rulesLearned: s.rulesLearned ?? 0,
      improvementDelta: s.improvementDelta ?? 0,
      corrections: s.totalUserCorrections ?? 0,
      rulesSummary: response.rulesSummary ?? { total: 0, byCategory: {}, highConfidence: 0, recentlyCreated: 0 },
      lessons: response.lessons ?? { total: 0, recent: [] },
      trajectories: response.trajectories ?? { total: 0, recent: [] },
      lastReflection: response.lastReflection ?? "",
    });
  } else {
    renderLearningDashboard({
      totalRuns: 0, successRate: 0, piiDetected: 0, piiRedacted: 0,
      falsePositives: 0, missedPII: 0, sitesVisited: 0, rulesLearned: 0,
      improvementDelta: 0, corrections: 0,
      rulesSummary: { total: 0, byCategory: {}, highConfidence: 0, recentlyCreated: 0 },
      lessons: { total: 0, recent: [] },
      trajectories: { total: 0, recent: [] },
      lastReflection: "",
    });
  }
}

/** "✕ not PII" chip action — user ground truth feeding the learning loop. */
async function reportFalsePositive(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "…";
  const response = (await send({
    kind: "record-correction",
    piiKind: btn.dataset.kind ?? "",
    label: btn.dataset.label ?? "",
    correction: "false_positive",
  })) as { ok?: boolean } | undefined;
  if (response?.ok) {
    btn.textContent = "✓ counted";
  } else {
    btn.textContent = "✕ not PII";
    btn.disabled = false;
  }
  // Keep the learning view live when it is open.
  if (!learningDashboardEl.classList.contains("hidden")) {
    await refreshLearningDashboard();
  }
}

$("btn-learning")?.addEventListener("click", () => setActivePanel("learning-dashboard"));

$("learning-close")?.addEventListener("click", () => setActivePanel(null));

// Reset learning memory (experiences + rules + ledger) — useful when a buggy
// run polluted the memory with garbage rules, so the demo starts clean.
$("learning-reset").addEventListener("click", async () => {
  await send({ kind: "clear-learning" });
  await send({ kind: "reset" });
  await refreshLearningDashboard();
  loadLedger();
});

// ─── Task Submission ───────────────────────────────────────────────────────

async function submit(task?: string): Promise<void> {
  const text = task ?? taskInput.value.trim();
  if (!text) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  taskInput.value = "";
  taskInput.style.height = "auto";
  setActivePanel(null);
  updatePerceptionCount();
  await send({ kind: "run", task: text, tabId: tab.id });
}

// Run button / Enter
runBtn.addEventListener("click", () => void submit());
taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void submit();
  }
});

// Voice (ElevenLabs) — lazy bootstrap; no-op if user hasn't added an API key.
void bootstrapVoice();
// Auto-grow textarea
taskInput.addEventListener("input", () => {
  taskInput.style.height = "auto";
  taskInput.style.height = `${Math.min(taskInput.scrollHeight, 120)}px`;
});

// Stop button
stopBtn.addEventListener("click", () => {
  void send({ kind: "stop" });
});

// New task
$("new-task-btn").addEventListener("click", () => {
  void send({ kind: "reset" });
  nodes.clear();
  rawTexts.clear();
  transcriptEl.querySelectorAll(".entry").forEach((n) => n.remove());
  emptyEl.classList.remove("hidden");
  setActivePanel(null);
  setRunning(false);
  perceptionCount = 0;
  if (egressBadge) egressBadge.textContent = "EGRESS —";
  if (perceptionCounter) perceptionCounter.textContent = "PERCEPTION N° 01";
});

// Settings
$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ─── History Panel ──────────────────────────────────────────────────────

const historyList = $("history-list");

async function loadHistory(): Promise<void> {
  const response = await send({ kind: "get-history" }) as { sessions?: Array<{
    id: string; task: string; status: string; completedAt: number;
    durationMs: number; piiRedacted: number; summary: string;
  }> } | undefined;

  const sessions = response?.sessions ?? [];
  if (sessions.length === 0) {
    historyList.innerHTML = `<div class="empty-state" style="padding: 20px;"><p class="empty-sub">No sessions yet. Complete a task to see history here.</p></div>`;
    return;
  }

  historyList.innerHTML = "";
  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "history-item";
    const date = new Date(session.completedAt);
    const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });
    const dur = session.durationMs > 60000
      ? `${Math.round(session.durationMs / 60000)}m`
      : `${Math.round(session.durationMs / 1000)}s`;

    item.innerHTML = `
      <div class="history-item-task">${escapeHtml(session.task)}</div>
      <div class="history-item-meta">
        <span class="history-status ${session.status}">${session.status}</span>
        <span>${timeStr} · ${dateStr}</span>
        <span>${dur}</span>
        ${session.piiRedacted > 0 ? `<span>🔒 ${session.piiRedacted}</span>` : ""}
      </div>
      <div class="history-item-actions">
        <button class="history-action-btn" data-replay="${escapeAttr(session.task)}">REPLAY</button>
        <button class="history-action-btn" data-delete="${session.id}">DELETE</button>
      </div>
    `;

    // Replay button.
    item.querySelector("[data-replay]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      historyPanel.classList.add("hidden");
      void submit(session.task);
    });

    // Delete button.
    item.querySelector("[data-delete]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void send({ kind: "delete-history", sessionId: session.id });
      item.remove();
    });

    historyList.appendChild(item);
  }
}

$("btn-history")?.addEventListener("click", () => setActivePanel("history-panel"));

$("history-close")?.addEventListener("click", () => setActivePanel(null));

$("history-clear")?.addEventListener("click", () => {
  void send({ kind: "delete-history", clearAll: true });
  historyList.innerHTML = `<div class="empty-state" style="padding: 20px;"><p class="empty-sub">No sessions yet. Complete a task to see history here.</p></div>`;
});

// Perception view (toggle audit)
$("btn-perception")?.addEventListener("click", () => setActivePanel("privacy-audit"));
$("audit-close")?.addEventListener("click", () => setActivePanel(null));

// ─── Tripwire Radar Log ──────────────────────────────────────────────────────

const tripwireLogEl = $("tripwire-log");
const tripwireSummaryEl = $("tripwire-summary");

function renderTripwireLog(alerts: TripwireAlertDetail[], summary: string): void {
  if (tripwireSummaryEl) tripwireSummaryEl.textContent = summary;
  if (alerts.length === 0) {
    tripwireLogEl.innerHTML = `
      <div class="empty-state" style="padding: 14px;">
        <p class="empty-sub">No third-party exfiltration detected. Outbound wire clean.</p>
      </div>
    `;
    return;
  }
  tripwireLogEl.innerHTML = "";
  for (const alert of alerts) {
    const row = document.createElement("div");
    row.className = "tripwire-log-entry";
    const kind = escapeHtml((alert.piiType || "PII").toUpperCase());
    let host = "";
    try {
      host = new URL(alert.url).hostname.replace(/^www\./, "");
    } catch {
      host = alert.url.slice(0, 40);
    }
    const time = new Date(alert.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    row.innerHTML = `
      <span class="tl-kind">${kind}</span>
      <span class="tl-method">${escapeHtml(alert.method)}</span>
      <span class="tl-host" title="${escapeAttr(alert.url)}">${escapeHtml(host)}</span>
      <span class="tl-sample">${escapeHtml(alert.sample)}</span>
      <span class="tl-time">${time}</span>
    `;
    tripwireLogEl.appendChild(row);
  }
}

async function refreshTripwireLog(): Promise<void> {
  const response = (await send({ kind: "get-tripwire-log" })) as
    | { alerts?: TripwireAlertDetail[]; summary?: string }
    | undefined;
  if (!response) return;
  renderTripwireLog(response.alerts ?? [], response.summary ?? "");
}

// Tripwire Radar view
$("btn-radar")?.addEventListener("click", () => setActivePanel("tripwire-panel"));
$("tripwire-close")?.addEventListener("click", () => setActivePanel(null));

// Global Escape key listener to close active drawer
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setActivePanel(null);
  }
});

// ─── Quick Actions ─────────────────────────────────────────────────────────

document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
  el.addEventListener("click", () => {
    const action = el.dataset.action;
    const taskMap: Record<string, string> = {
      "fill-form": "Fill all visible form fields on this page with appropriate data",
      "extract-data": "Extract all visible data from this page and list it",
      "scan-pii": "Scan this page for any PII (passwords, IDs, emails, phone numbers) and report what you find",
      "click-target": "Identify and click the primary action button on this page",
    };
    void submit(taskMap[action ?? ""] ?? "Do something on this page");
  });
});

// ─── Context Presets ───────────────────────────────────────────────────────

document.querySelectorAll<HTMLElement>("[data-preset]").forEach((el) => {
  el.addEventListener("click", () => {
    const preset = el.dataset.preset;
    const presetMap: Record<string, string> = {
      aadhaar: "Scan this page for Aadhaar numbers (12-digit) and redact them",
      pan: "Scan this page for PAN card numbers (5 letters + 4 digits + 1 letter) and redact them",
      contact: "Scan this page for contact information (emails, phone numbers, addresses) and list them",
    };
    void submit(presetMap[preset ?? ""] ?? "Scan for PII");
  });
});

// ─── Input Auto-grow ───────────────────────────────────────────────────────

taskInput.addEventListener("input", () => {
  taskInput.style.height = "auto";
  taskInput.style.height = `${Math.min(taskInput.scrollHeight, 120)}px`;
});

// ─── Restore State on Reopen ───────────────────────────────────────────────

void (async () => {
  const state = (await chrome.runtime.sendMessage({ kind: "get-state" })) as
    | { transcript: TranscriptEntry[]; running: boolean }
    | undefined;
  if (!state) return;
  state.transcript.forEach(render);
  setRunning(state.running);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
})();
