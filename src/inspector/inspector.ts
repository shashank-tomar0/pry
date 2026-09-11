/**
 * PRY — Standalone Deep Privacy Inspector
 *
 * Provides whole-page and viewport-level inspection across all browser tabs:
 * - Redacted vs Original screenshot comparison with bounding boxes
 * - In-memory Vault inspection (live mappings, masked previews)
 * - Findings categorized by PII kind (email, phone, aadhaar, pan, name, credentials)
 * - Before & After DOM text comparison
 * - Adversarial re-OCR verification status display
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const tabPicker = $<HTMLSelectElement>("tab-picker");
const statusEl = $("status");
const residualEl = $("residual-banner");
const summaryEl = $("summary");
const shot = $<HTMLCanvasElement>("shot");
const shotNote = $("shot-note");
const findingsEl = $("findings");
const filtersEl = $("filters");
const vaultEl = $("vault");
const vaultNote = $("vault-note");
const textviewEl = $("textview");
const treeEl = $("tree");
const treeStats = $("tree-stats");
const fullPageEl = $<HTMLInputElement>("full-page");
const scanBtn = $<HTMLButtonElement>("scan");
const clearWireBtn = $<HTMLButtonElement>("clear-wire");

interface Detection {
  kind: string;
  label: string;
  confidence: number;
  box?: { x: number; y: number; width: number; height: number };
}

interface VaultEntry {
  token: string;
  original: string;
  kind: string;
  createdAt: number;
}

interface InspectData {
  tab: { id: number; title?: string; url?: string };
  original: string;
  redacted: string;
  width: number;
  height: number;
  tiles: number;
  detections: Detection[];
  redactedCount: number;
  processingTimeMs: number;
  verification?: {
    verified: boolean;
    regionsChecked: number;
    regionsRedacted: number;
    leakedPatterns: string[];
    confidence: number;
    summary: string;
    ocrRan?: boolean;
    leakedText?: string;
  };
  vault: VaultEntry[];
  snapshot?: {
    url: string;
    title: string;
    elements: Array<{ id: number; role: string; name: string; value?: string }>;
    text: string;
  };
}

let currentData: InspectData | null = null;
let shotView: "redacted" | "original" = "redacted";
let textView: "after" | "before" = "after";
let activeFilter = "all";
let activeDetectionIndex: number | null = null;

function setStatus(text: string, bad = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("bad", bad);
}

function escape(text: string): string {
  return text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}

function maskValue(val: string): string {
  if (val.length <= 4) return "••••";
  return val.slice(0, 2) + "••••" + val.slice(-2);
}

async function loadTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  tabPicker.innerHTML = "";
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (/^(chrome|edge|about|devtools):/.test(tab.url)) continue;
    const option = document.createElement("option");
    option.value = String(tab.id);
    let host = tab.url;
    try {
      host = new URL(tab.url).host || tab.url;
    } catch {
      /* extension pages & file: urls */
    }
    option.textContent = `${tab.title || "untitled"} — ${host}`;
    tabPicker.appendChild(option);
  }
  if (tabPicker.options.length === 0) {
    setStatus("No inspectable tabs found. Open a webpage or test fixture first.", true);
  }
}

// --- Drawing Screenshot ---------------------------------------------------

async function drawShot(): Promise<void> {
  if (!currentData) return;

  const ctx = shot.getContext("2d");
  if (!ctx) return;

  const source = shotView === "redacted" ? currentData.redacted : currentData.original;
  if (!source) {
    shot.width = 1;
    shot.height = 1;
    shotNote.textContent = "No screenshot available.";
    return;
  }

  const image = new Image();
  image.src = source;
  await image.decode().catch(() => undefined);

  shot.width = image.naturalWidth;
  shot.height = image.naturalHeight;
  ctx.drawImage(image, 0, 0);

  const kb = Math.round(source.length / 1024);
  const coverage = currentData.tiles > 1 ? `full-page (${currentData.tiles} tiles stitched)` : "viewport";

  if (shotView === "redacted") {
    shotNote.textContent = `${image.naturalWidth}x${image.naturalHeight}px · ${kb} KB · ${coverage} · ${currentData.redactedCount} regions masked. Shipped to planner.`;
  } else {
    shotNote.textContent = `${image.naturalWidth}x${image.naturalHeight}px · ${kb} KB · ${coverage} · Raw un-redacted capture (NEVER leaves device). Outlines mark detection boxes.`;

    // Draw detection boxes on original
    currentData.detections.forEach((det, idx) => {
      if (!det.box) return;
      const { x, y, width, height } = det.box;
      ctx.strokeStyle = idx === activeDetectionIndex ? "#00888c" : "#e23829";
      ctx.lineWidth = idx === activeDetectionIndex ? 3 : 2;
      ctx.strokeRect(x, y, width, height);

      // Label badge
      ctx.fillStyle = idx === activeDetectionIndex ? "#00888c" : "#e23829";
      ctx.font = "bold 11px sans-serif";
      const text = `${det.kind}: ${det.label}`;
      const textWidth = ctx.measureText(text).width;
      ctx.fillRect(x, Math.max(0, y - 16), textWidth + 8, 16);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, x + 4, Math.max(12, y - 4));
    });
  }
}

// --- Render Summary ---------------------------------------------------------

function renderSummary(): void {
  if (!currentData) return;

  const d = currentData;
  const cells: [string, string | number][] = [
    ["PII detections", d.detections.length],
    ["Redacted items", d.redactedCount],
    ["Vault tokens", d.vault.length],
    ["Processing time", `${d.processingTimeMs}ms`],
    ["Page tiles", d.tiles],
    ["Re-OCR verified", d.verification?.verified ? "YES" : "NO"],
  ];

  summaryEl.innerHTML = cells
    .map(([k, n]) => `<div class="stat"><span class="n">${n}</span><span class="k">${k}</span></div>`)
    .join("");
  summaryEl.classList.remove("hidden");

  // Residual banner
  const hasResidual = d.verification && !d.verification.verified;
  residualEl.className = `residual ${hasResidual ? "dirty" : "clean"}`;
  residualEl.innerHTML = hasResidual
    ? `<strong>Residual PII Leak Detected!</strong><span class="sub">${d.verification?.summary || "Adversarial re-OCR identified un-redacted characters."}</span>`
    : `<strong>Zero-Leak Integrity Confirmed.</strong><span class="sub">${d.verification?.summary || "Adversarial re-OCR verified zero residual sensitive patterns in redacted pixels."}</span>`;
  residualEl.classList.remove("hidden");
}

// --- Render Vault ----------------------------------------------------------

function renderVault(): void {
  if (!currentData || currentData.vault.length === 0) {
    vaultEl.innerHTML = `<p class="hint" style="padding: 14px;">Vault is empty (no values tokenized yet).</p>`;
    vaultNote.textContent = "0 active mappings";
    return;
  }

  vaultNote.textContent = `${currentData.vault.length} active mapping(s) in RAM`;
  vaultEl.innerHTML = `
    <table>
      <thead>
        <tr><th>Token</th><th>Kind</th><th>Masked Sample</th><th>Created</th></tr>
      </thead>
      <tbody>
        ${currentData.vault
          .map(
            (e) => `<tr>
              <td class="tok">${escape(e.token)}</td>
              <td>${escape(e.kind)}</td>
              <td class="pv">${escape(maskValue(e.original))}</td>
              <td>${new Date(e.createdAt).toLocaleTimeString()}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

// --- Render Findings -------------------------------------------------------

function renderFilters(): void {
  if (!currentData) return;

  const kinds = new Map<string, number>();
  for (const det of currentData.detections) {
    kinds.set(det.kind, (kinds.get(det.kind) || 0) + 1);
  }

  const options: [string, string][] = [
    ["all", `ALL (${currentData.detections.length})`],
    ...Array.from(kinds.entries()).map(([k, n]) => [k, `${k.toUpperCase()} (${n})`] as [string, string]),
  ];

  filtersEl.innerHTML = "";
  for (const [val, label] of options) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.setAttribute("aria-pressed", String(val === activeFilter));
    btn.addEventListener("click", () => {
      activeFilter = val;
      renderFilters();
      renderFindings();
    });
    filtersEl.appendChild(btn);
  }
}

function renderFindings(): void {
  if (!currentData) return;

  const shown =
    activeFilter === "all"
      ? currentData.detections
      : currentData.detections.filter((d) => d.kind === activeFilter);

  if (shown.length === 0) {
    findingsEl.innerHTML = `<p class="hint" style="padding: 14px;">No findings for filter "${activeFilter}".</p>`;
    return;
  }

  findingsEl.innerHTML = "";
  shown.forEach((det, idx) => {
    const row = document.createElement("div");
    row.className = `finding ${idx === activeDetectionIndex ? "active" : ""}`;
    row.innerHTML = `
      <span class="kind">${escape(det.kind)}</span>
      <span>
        <span class="tag ${det.box ? "pixel" : "text"}">${det.box ? "SOLID BOX" : "TOKEN"}</span>
        <span class="tag">${Math.round(det.confidence * 100)}% CONF</span>
      </span>
      <span class="val">${escape(det.label)}</span>
      <span class="why">${det.box ? `box [${det.box.x}, ${det.box.y}, ${det.box.width}x${det.box.height}]` : "DOM text span"}</span>
    `;
    row.addEventListener("click", () => {
      activeDetectionIndex = activeDetectionIndex === idx ? null : idx;
      renderFindings();
      if (shotView === "original") void drawShot();
    });
    findingsEl.appendChild(row);
  });
}

// --- Render Text View ------------------------------------------------------

function renderTextView(): void {
  if (!currentData || !currentData.snapshot) {
    textviewEl.innerHTML = `<p class="hint">No DOM text available.</p>`;
    return;
  }

  const text = currentData.snapshot.text || "";
  if (!text) {
    textviewEl.innerHTML = `<p class="hint">Page has no visible text.</p>`;
    return;
  }

  const paragraphs = text.split("\n").filter((p) => p.trim().length > 0);
  textviewEl.innerHTML = paragraphs
    .map((p) => {
      const escaped = escape(p);
      return `<p>${escaped.replace(/&lt;([A-Z]+_\d+)&gt;/g, '<span class="tok">&lt;$1&gt;</span>')}</p>`;
    })
    .join("");
}

// --- Render DOM Tree -------------------------------------------------------

function renderTree(): void {
  if (!currentData || !currentData.snapshot) {
    treeEl.innerHTML = `<p class="hint">No element data available.</p>`;
    return;
  }

  const elements = currentData.snapshot.elements || [];
  treeStats.textContent = `${elements.length} interactive / landmark elements captured`;

  const lines = elements.map(
    (el) =>
      `<span class="lbl">${el.id}</span> <span class="role">[${escape(el.role)}]</span> ${escape(el.name)} ${
        el.value ? `<span class="flag">= "${escape(el.value)}"</span>` : ""
      }`,
  );
  treeEl.innerHTML = lines.join("\n");
}

// --- Scan Function ---------------------------------------------------------

async function scan(): Promise<void> {
  const tabId = Number(tabPicker.value);
  if (!tabId) {
    setStatus("Select a valid tab first.", true);
    return;
  }

  const fullPage = fullPageEl.checked;
  setStatus(fullPage ? "Scrolling & stitching full page tiles..." : "Capturing tab & executing privacy pipeline...");
  scanBtn.disabled = true;

  try {
    const res = (await chrome.runtime.sendMessage({
      kind: "inspect-tab",
      tabId,
      fullPage,
    })) as { ok: boolean; result?: InspectData; error?: string };

    if (!res.ok || !res.result) {
      setStatus(`Scan failed: ${res.error || "Unknown error"}`, true);
      return;
    }

    currentData = res.result;
    activeDetectionIndex = null;
    activeFilter = "all";

    renderSummary();
    renderVault();
    renderFilters();
    renderFindings();
    renderTextView();
    renderTree();
    await drawShot();

    setStatus(
      `? Scanned ${currentData.tab.title || "tab"} — ${currentData.detections.length} detections, ${
        currentData.redactedCount
      } masked in ${currentData.processingTimeMs}ms.`,
    );
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    scanBtn.disabled = false;
  }
}

// --- Event Bindings --------------------------------------------------------

scanBtn.addEventListener("click", () => void scan());

clearWireBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ kind: "clear-wire-log" });
  setStatus("Wire log cleared.");
});

// Switches
for (const [id, apply] of [
  ["shot-switch", (v: string) => { shotView = v as typeof shotView; void drawShot(); }],
  ["text-switch", (v: string) => { textView = v as typeof textView; renderTextView(); }],
] as const) {
  $(id).addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn?.dataset.view) return;
    for (const sib of $(id).querySelectorAll("button")) {
      sib.setAttribute("aria-pressed", String(sib === btn));
    }
    apply(btn.dataset.view);
  });
}

void loadTabs();
