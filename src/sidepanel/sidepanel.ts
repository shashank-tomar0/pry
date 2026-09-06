import type { AgentEvent, PanelCommand, TranscriptEntry } from "../shared/types";
import { accuracyMetrics } from "../shared/metrics";

// ─── DOM References ────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const transcriptEl = $("transcript");
const emptyEl = $("empty");
const taskInput = $<HTMLTextAreaElement>("task-input");
const runBtn = $("run-btn");
const stopBtn = $("stop-btn");
const statusDot = $("status-dot");
const statusText = $("status-text");
const confirmEl = $("confirm");
const confirmText = $("confirm-text");
const privacyAuditEl = $("privacy-audit");
const egressBadge = $("egress-badge");
const perceptionCounter = $("perception-counter");

/** Rendered entries, so patches can find their node without a re-render. */
const nodes = new Map<string, HTMLElement>();
let pendingConfirmId: string | null = null;
let perceptionCount = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────

function send(command: PanelCommand): Promise<unknown> {
  return chrome.runtime.sendMessage(command).catch(() => undefined);
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
    }
    nodes.set(entry.id, node);
    transcriptEl.appendChild(node);
  }

  if (entry.role === "step") {
    const glyph = node.querySelector(".glyph");
    if (glyph) glyph.textContent = GLYPHS[entry.action ?? ""] ?? "•";
    const detail = node.querySelector(".detail");
    if (detail) detail.textContent = entry.text;
    node.classList.toggle("pending", entry.pending === true);
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
  privacyAuditEl.classList.remove("hidden");

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

  // Re-OCR verification badge — pixel-level proof the redaction worked.
  if (audit.verification) {
    const vEl = document.createElement("div");
    vEl.className = audit.verification.verified
      ? "verification-badge verified"
      : "verification-badge warn";
    vEl.textContent = audit.verification.verified
      ? `✓ RE-OCR VERIFIED — ${audit.verification.regionsRedacted}/${audit.verification.regionsChecked} sensitive regions confirmed redacted in the shipped image`
      : `⚠ ${audit.verification.summary}`;
    summaryEl.appendChild(vEl);
  }

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
            <img src="${shot.redacted}" alt="Redacted" />
            <div class="shot-label">🔒 Redacted</div>
          </div>`;
      }
      screenshotsEl.appendChild(pair);
    }
  } else {
    screenshotsEl.innerHTML = "";
  }    // Detection chips.
  const detectionsEl = $("audit-detections");
  if (audit.allDetections.length > 0) {
    const unique = new Map<string, { kind: string; label: string; count: number }>();
    for (const d of audit.allDetections) {
      const existing = unique.get(d.label);
      if (existing) existing.count++;
      else unique.set(d.label, { kind: d.kind, label: d.label, count: 1 });
    }
    detectionsEl.innerHTML = `<h4>Detected PII <span class="detection-hint">— flagged anything wrong? Tell the agent and it learns not to repeat it.</span></h4><div class="detection-list"></div>`;
    const list = detectionsEl.querySelector(".detection-list")!;
    for (const [, det] of unique) {
      const chip = document.createElement("span");
      chip.className = `detection-chip ${det.kind}`;
      chip.textContent = `${KIND_EMOJI[det.kind] ?? "•"} ${det.label}${det.count > 1 ? ` ×${det.count}` : ""}`;
      // User ground truth: report a detection that was actually wrong. The
      // service worker flips the outcome on the latest run and reflects a rule.
      const fpBtn = document.createElement("button");
      fpBtn.type = "button";
      fpBtn.className = "fp-btn";
      fpBtn.textContent = "✕ not PII";
      fpBtn.dataset.kind = det.kind;
      fpBtn.dataset.label = det.label;
      fpBtn.addEventListener("click", () => void reportFalsePositive(fpBtn));
      chip.appendChild(fpBtn);
      list.appendChild(chip);
    }
  } else {
    detectionsEl.innerHTML = "";
  }

  // Token vault.
  const tokensEl = $("audit-tokens");
  if (audit.allTokens.length > 0) {
    // Dedupe tokens (they can repeat across screenshot entries).
    const seen = new Map<string, { token: string; kind: string; sample?: string }>();
    for (const tok of audit.allTokens) {
      if (!seen.has(tok.token)) seen.set(tok.token, tok);
    }
    tokensEl.innerHTML = `<h4>Token Vault (values never leave the browser)</h4><div class="token-list"></div>`;
    const list = tokensEl.querySelector(".token-list")!;
    for (const tok of seen.values()) {
      const chip = document.createElement("span");
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

  privacyAuditEl.scrollIntoView({ behavior: "smooth" });
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
          node.textContent = (node.textContent ?? "") + event.text;
        } else if (node.classList.contains("step")) {
          const detail = node.querySelector(".detail");
          if (detail) detail.textContent = event.text;
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
  }
});

// ─── Learning Dashboard ───────────────────────────────────────────────────

const learningDashboardEl = $("learning-dashboard");

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
  lastReflection: string;
}): void {
  learningDashboardEl.classList.remove("hidden");

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

  learningDashboardEl.scrollIntoView({ behavior: "smooth" });
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
      lastReflection: response.lastReflection ?? "",
    });
  } else {
    renderLearningDashboard({
      totalRuns: 0, successRate: 0, piiDetected: 0, piiRedacted: 0,
      falsePositives: 0, missedPII: 0, sitesVisited: 0, rulesLearned: 0,
      improvementDelta: 0, corrections: 0,
      rulesSummary: { total: 0, byCategory: {}, highConfidence: 0, recentlyCreated: 0 },
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

$("btn-learning").addEventListener("click", async () => {
  learningDashboardEl.classList.toggle("hidden");
  if (!learningDashboardEl.classList.contains("hidden")) {
    await refreshLearningDashboard();
  }
});

$("learning-close").addEventListener("click", () => {
  learningDashboardEl.classList.add("hidden");
});

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
  privacyAuditEl.classList.add("hidden");
  updatePerceptionCount();
  await send({ kind: "run", task: text, tabId: tab.id });
}

// Run button / Enter
runBtn.addEventListener("click", () => void submit());
taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
});

// Stop
stopBtn.addEventListener("click", () => void send({ kind: "stop" }));

// New task
$("new-task-btn").addEventListener("click", () => {
  void send({ kind: "reset" });
  nodes.clear();
  transcriptEl.querySelectorAll(".entry").forEach((n) => n.remove());
  emptyEl.classList.remove("hidden");
  privacyAuditEl.classList.add("hidden");
  setRunning(false);
  perceptionCount = 0;
  if (egressBadge) egressBadge.textContent = "EGRESS —";
  if (perceptionCounter) perceptionCounter.textContent = "PERCEPTION N° 01";
});

// Settings
$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ─── History Panel ──────────────────────────────────────────────────────

const historyPanel = $("history-panel");
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

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(str: string): string {
  return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

$("btn-history").addEventListener("click", () => {
  historyPanel.classList.toggle("hidden");
  if (!historyPanel.classList.contains("hidden")) {
    void loadHistory();
  }
});

$("history-close").addEventListener("click", () => {
  historyPanel.classList.add("hidden");
});

$("history-clear").addEventListener("click", () => {
  void send({ kind: "delete-history", clearAll: true });
  historyList.innerHTML = `<div class="empty-state" style="padding: 20px;"><p class="empty-sub">No sessions yet. Complete a task to see history here.</p></div>`;
});

// Perception view (toggle audit)
$("btn-perception").addEventListener("click", () => {
  privacyAuditEl.classList.toggle("hidden");
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
