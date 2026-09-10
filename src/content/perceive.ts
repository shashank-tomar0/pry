import type { PageElement, PageSnapshot } from "../shared/types";
import { matchPiiInText } from "../shared/text-pii-patterns";

/**
 * Elements from the last snapshot, indexed by the id handed to the planner.
 * Rebuilt on every snapshot — an id is only valid against the snapshot that
 * produced it, which is why the service worker re-perceives after every action.
 */
let registry: Element[] = [];

const MAX_ELEMENTS = 80;
const MAX_NAME = 60;
const MAX_TEXT = 2000;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable=''],[contenteditable=true]",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=switch]",
  "[role=combobox]",
  "[role=searchbox]",
  "[role=textbox]",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (Number(style.opacity) < 0.05) return false;
  return true;
}

function clean(value: string | null | undefined): string {
  if (!value) return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_NAME
    ? `${collapsed.slice(0, MAX_NAME)}…`
    : collapsed;
}

/**
 * Approximates the accessible-name algorithm. Full ARIA name computation is
 * overkill here — these five sources cover what a planner needs to tell two
 * controls apart.
 */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (clean(parts)) return clean(parts);
  }

  const ariaLabel = clean(el.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const text = clean(labels[0].textContent);
      if (text) return text;
    }
    const placeholder = clean(el.getAttribute("placeholder"));
    if (placeholder) return placeholder;
  }

  if (el instanceof HTMLImageElement) {
    const alt = clean(el.alt);
    if (alt) return alt;
  }

  const text = clean((el as HTMLElement).innerText ?? el.textContent);
  if (text) return text;

  const attrName = clean(el.getAttribute("title") || el.getAttribute("name"));
  if (attrName) return attrName;

  // Final fallback for nameless fields: infer from surrounding layout.
  if (isTextEntry(el)) {
    const layout = layoutLabel(el);
    if (layout) return layout;
  }

  return "";
}

/** True when the element is a control the planner types into or selects from. */
function isTextEntry(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el.hasAttribute("contenteditable")) return true;
  const role = el.getAttribute("role");
  return role === "textbox" || role === "searchbox" || role === "combobox" || role === "password";
}

/**
 * Recovers a short label for text-entry fields that ship without aria-labels,
 * placeholders, or associated <label>s (e.g. Gmail compose "To" / "Subject").
 * Looks at the previous sibling ("To" next to its input) then the nearest
 * short ancestor row — never text longer than a field label.
 */
function layoutLabel(el: Element): string {
  const prev = el.previousElementSibling;
  if (prev instanceof HTMLElement) {
    const t = clean(prev.innerText ?? prev.textContent ?? "");
    if (t && t.length <= 40) return t;
  }
  let parent = el.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    const t = clean(parent.innerText ?? "");
    if (!t) {
      parent = parent.parentElement;
      continue;
    }
    if (t.length <= 60) return t;
    parent = parent.parentElement;
  }

  // 2D Spatial Proximity Perception:
  // When DOM tree hierarchy fails (e.g. flex/grid columns or material designs where
  // label and input reside in separate subtree branches), query visible text nodes
  // geometrically located within 120px to the left or above the input element.
  try {
    const targetRect = el.getBoundingClientRect();
    if (targetRect.width > 0 && targetRect.height > 0) {
      const candidates = document.querySelectorAll("label, span, p, div, th, dt");
      let bestDist = 120;
      let bestText = "";
      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        if (cand === el || cand.contains(el)) continue;
        const text = clean((cand as HTMLElement).innerText ?? "");
        if (!text || text.length > 45 || text.length < 2) continue;

        const cr = cand.getBoundingClientRect();
        if (cr.width === 0 || cr.height === 0) continue;

        // Label to the left (same vertical line) or label immediately above
        const isLeft = cr.right <= targetRect.left && cr.bottom >= targetRect.top - 10 && cr.top <= targetRect.bottom + 10;
        const isAbove = cr.bottom <= targetRect.top && cr.right >= targetRect.left - 20 && cr.left <= targetRect.right + 20;

        if (isLeft || isAbove) {
          const dx = isLeft ? targetRect.left - cr.right : Math.abs(targetRect.left - cr.left);
          const dy = isAbove ? targetRect.top - cr.bottom : Math.abs(targetRect.top - cr.top);
          const dist = Math.hypot(dx, dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestText = text;
          }
        }
      }
      if (bestText) return bestText;
    }
  } catch {
    // Spatial lookup degrades gracefully
  }

  return "";
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type === "checkbox" || type === "radio" || type === "submit") return type;
    if (type === "password") return "password";
    return "textbox";
  }
  if (el.hasAttribute("contenteditable")) return "textbox";
  return tag;
}

function attributesOf(el: Element): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};

  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") {
      attrs.checked = String(el.checked);
    }
    if (el.required) attrs.required = "true";
    attrs.inputType = el.type;
  }

  if ((el as HTMLElement & { disabled?: boolean }).disabled) {
    attrs.disabled = "true";
  }

  const expanded = el.getAttribute("aria-expanded");
  if (expanded) attrs.expanded = expanded;

  const selected = el.getAttribute("aria-selected");
  if (selected) attrs.selected = selected;

  if (el instanceof HTMLAnchorElement && el.href) {
    try {
      const url = new URL(el.href);
      // Host only, plus a short path hint — full URLs blow up the snapshot and
      // rarely help the planner choose between links.
      attrs.href = url.host + (url.pathname === "/" ? "" : url.pathname.slice(0, 40));
    } catch {
      /* javascript: and mailto: hrefs are not worth reporting */
    }
  }

  const rect = el.getBoundingClientRect();
  const inViewport = rect.top < innerHeight && rect.bottom > 0;
  if (!inViewport) attrs.offscreen = "true";

  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function valueOf(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    // Never read back a password field's contents.
    if (el.type === "password") return el.value ? "••••••" : "";
    if (el.type === "checkbox" || el.type === "radio") return undefined;
    return clean(el.value);
  }
  if (el instanceof HTMLTextAreaElement) return clean(el.value);
  if (el instanceof HTMLSelectElement) {
    return clean(el.selectedOptions[0]?.textContent ?? el.value);
  }
  return undefined;
}

/** Visible text of the main content area, for questions the DOM skeleton can't answer. */
function pageText(): string {
  const main =
    document.querySelector("main") ??
    document.querySelector("[role=main]") ??
    document.querySelector("article") ??
    document.body;
  const text = clean((main as HTMLElement).innerText ?? "");
  // clean() truncates at MAX_NAME, so re-derive from the raw string instead.
  const raw = ((main as HTMLElement).innerText ?? "").replace(/\s*\n\s*/g, "\n").trim();
  return raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}\n…[truncated]` : raw || text;
}

/**
 * Builds a fresh snapshot and resets the element registry. Elements inside the
 * viewport are listed first so that the planner sees what the user sees before
 * it sees the rest of the page.
 */
export function snapshot(): PageSnapshot {
  registry = [];
  const elements: PageElement[] = [];

  const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))
    .filter(isVisible)
    .sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const aVisible = ra.top < innerHeight && ra.bottom > 0 ? 0 : 1;
      const bVisible = rb.top < innerHeight && rb.bottom > 0 ? 0 : 1;
      if (aVisible !== bVisible) return aVisible - bVisible;
      // Dialogs (compose windows, modal forms) come before page content: their
      // fields are appended late in the DOM and the element budget used to cut
      // them off exactly when the planner needs them most.
      const aDialog = a.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"]') ? 0 : 1;
      const bDialog = b.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"]') ? 0 : 1;
      if (aDialog !== bDialog) return aDialog - bDialog;
      // Text-entry controls (inputs, comboboxes, contenteditable bodies) first
      // so the planner can fill forms / compose boxes before seeing link spam.
      const aEntry = isTextEntry(a) ? 0 : 1;
      const bEntry = isTextEntry(b) ? 0 : 1;
      if (aEntry !== bEntry) return aEntry - bEntry;
      // Open autocomplete/listbox suggestion items go LAST: a search field
      // left focused keeps its suggestion panel over the results, and those
      // options used to crowd the actual result links out of the element
      // budget (the "clicked the channel card, not the first video" failure).
      // They stay reachable — just only when the budget allows.
      const aSuggestion = a.closest('[role="listbox"]') ? 1 : 0;
      const bSuggestion = b.closest('[role="listbox"]') ? 1 : 0;
      if (aSuggestion !== bSuggestion) return aSuggestion - bSuggestion;
      return ra.top - rb.top || ra.left - rb.left;
    });

  for (const el of candidates) {
    if (elements.length >= MAX_ELEMENTS) break;
    const name = accessibleName(el);
    const role = roleOf(el);
    const value = valueOf(el);
    // A nameless, valueless div with a tabindex is noise, not a control — but
    // nameless text-entry roles stay (a bare "textbox" the planner can still
    // type into is more useful than a field that silently disappears).
    const namelessAllowed =
      role === "textbox" || role === "select" ||
      role === "combobox" || role === "searchbox" || role === "password";
    if (!name && !value && !namelessAllowed) continue;

    const id = registry.push(el) - 1;
    elements.push({ id, role, name, value, attrs: attributesOf(el) });
  }

  return {
    url: location.href,
    title: document.title,
    elements,
    text: pageText(),
    truncated: candidates.length > elements.length,
    scroll: {
      y: Math.round(scrollY),
      maxY: Math.max(0, Math.round(document.body.scrollHeight - innerHeight)),
    },
  };
}

/** Resolves a planner-issued element id against the current registry. */
export function lookup(id: number): Element | undefined {
  const el = registry[id];
  // The node may have been detached by a re-render since the snapshot.
  if (!el || !el.isConnected) return undefined;
  return el;
}

// ─── Sensitive Region Detection ─────────────────────────────────────────────

/**
 * High-confidence PII selectors — fields that are ALMOST CERTAINLY sensitive.
 * These get redacted with solid black mask.
 */
const HIGH_CONFIDENCE_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-exp"]',
  'input[autocomplete="cc-csc"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="card"]',
  'input[name*="credit"]',
  'input[name*="cvv"]',
  'input[name*="cvc"]',
  'input[name*="aadhaar"]',
  'input[name*="pan"]',
  'input[name*="ssn"]',
  'input[name*="passport"]',
  'input[name*="apikey"]',
  'input[name*="api_key"]',
  'input[name*="secret"]',
  'input[name*="otp"]',
].join(",");

/**
 * All input-capable elements — ANY field that a user might type sensitive
 * data into. These get redacted with blur (lighter than black mask
 * since they're not confirmed PII, but still privacy-sensitive).
 *
 * Gmail uses contenteditable divs for compose. Google Forms uses
 * generic inputs. Banking sites use custom components.
 */
const ALL_INPUT_SELECTORS = [
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="image"]):not([type="date"])',
  'textarea',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"] input',
].join(",");

export interface SensitiveRegion {
  /** Bounding box in viewport coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Type of sensitive content. */
  kind: string;
  /** Human-readable label. */
  label: string;
}

/**
 * Finds all sensitive elements on the page and returns their viewport
 * bounding boxes. Used by the service worker to guide screenshot redaction.
 *
 * Strategy: redact ALL input-capable fields (they might contain sensitive
 * data) plus scan visible text for ID number patterns.
 */
export function getSensitiveRegions(): SensitiveRegion[] {
  const regions: SensitiveRegion[] = [];
  const processedElements = new Set<Element>();

  // 1. High-confidence PII fields — solid black mask.
  const highConfEls = document.querySelectorAll(HIGH_CONFIDENCE_SELECTORS);
  for (const el of Array.from(highConfEls)) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    processedElements.add(el);
    const kind = getSensitiveKind(el);
    regions.push({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      kind,
      label: getSensitiveLabel(el, kind),
    });

    // Also redact the associated label.
    const label = findAssociatedLabel(el);
    if (label && !processedElements.has(label)) {
      const lrect = label.getBoundingClientRect();
      if (lrect.width > 0 && lrect.height > 0) {
        processedElements.add(label);
        regions.push({
          x: Math.round(lrect.left),
          y: Math.round(lrect.top),
          width: Math.round(lrect.width),
          height: Math.round(lrect.height),
          kind: "credential_label",
          label: `Label for ${kind}`,
        });
      }
    }
  }

  // 2. ALL other input fields — blur (not confirmed PII but sensitive).
  const allInputEls = document.querySelectorAll(ALL_INPUT_SELECTORS);
  for (const el of Array.from(allInputEls)) {
    if (processedElements.has(el)) continue; // Already handled as high-confidence.
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 5) continue; // Skip tiny hidden fields.

    // Skip search boxes and nav inputs — a user's search query is not PII, and
    // search inputs must never become redacted regions. Name check covers
    // YouTube's "search_query" even when placeholder/role reads fail.
    const name = (el as HTMLInputElement).name?.toLowerCase() ?? "";
    const placeholder = (el as HTMLInputElement).placeholder?.toLowerCase() ?? "";
    const role = el.getAttribute("role")?.toLowerCase() ?? "";
    if (name.includes("search") || name === "q" || placeholder.includes("search") || role === "searchbox") continue;

    processedElements.add(el);
    regions.push({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      kind: "input_field",
      label: getSensitiveLabel(el, "input_field"),
    });
  }

  // 3. Scan visible text for PII (emails, phones, checksum-validated IDs)
  //    via the shared matchers — the same classes the text channel tokenizes.
  const idRegions = findTextRegions();
  regions.push(...idRegions);

  // 4. Detect profile/avatar images that likely contain faces.
  const profileImages = document.querySelectorAll('img[src*="avatar"], img[src*="profile"], img[src*="photo"], img[alt*="profile"], img[alt*="avatar"], [role="img"][aria-label*="profile"], [role="img"][aria-label*="avatar"]');
  for (const el of Array.from(profileImages)) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) continue;
    // Only square-ish images (aspect ratio 0.5-2.0) are likely faces.
    const aspect = rect.width / rect.height;
    if (aspect < 0.5 || aspect > 2.0) continue;
    processedElements.add(el);
    regions.push({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      kind: "face",
      label: "Profile/avatar image",
    });
  }

  // On-screen receipt (the user-facing box): shows how many sensitive items
  // were just located on THIS screen. Auto-fades; never intercepts input.
  showDetectionBadge(regions.length);

  return regions;
}

let badgeEl: HTMLElement | null = null;
let badgeHideTimer: number | undefined;

/**
 * Floating count chip on the page itself. Created once, reused, faded out
 * after a few seconds so it never becomes part of the page. pointer-events
 * are disabled — it is a receipt, not a control.
 */
function showDetectionBadge(count: number): void {
  try {
    if (count <= 0) return;
    if (!badgeEl || !badgeEl.isConnected) {
      badgeEl = document.createElement("div");
      badgeEl.setAttribute("data-pry-badge", "");
      badgeEl.style.cssText = [
        "position: fixed",
        "top: 12px",
        "right: 12px",
        "z-index: 2147483646",
        "pointer-events: none",
        "font-family: Consolas, monospace",
        "font-size: 12px",
        "font-weight: 700",
        "color: #fff",
        "background: #1a1a1a",
        "border: 1px solid #d0202e",
        "border-radius: 4px",
        "padding: 6px 10px",
        "opacity: 0",
        "transition: opacity 0.4s ease",
        "box-shadow: 0 2px 8px rgba(0,0,0,0.35)",
      ].join(";");
      document.documentElement.appendChild(badgeEl);
    }
    badgeEl.textContent = `PRY · ${count} sensitive item${count === 1 ? "" : "s"} masked on screen`;
    badgeEl.style.opacity = "1";
    clearTimeout(badgeHideTimer);
    badgeHideTimer = window.setTimeout(() => {
      if (badgeEl) badgeEl.style.opacity = "0";
    }, 4000);
  } catch {
    // A badge must never break perception.
  }
}

function getSensitiveKind(el: Element): string {
  const input = el as HTMLInputElement;
  if (input.type === "password") return "password";
  const ac = input.autocomplete ?? "";
  if (ac.includes("cc-")) return "credit_card";
  if (ac.includes("one-time")) return "otp";
  const name = (input.name ?? "").toLowerCase();
  if (name.includes("aadhaar") || name.includes("ssn") || name.includes("passport")) return "id_number";
  if (name.includes("pan")) return "pan_card";
  if (name.includes("cvv") || name.includes("cvc")) return "cvv";
  if (name.includes("apikey") || name.includes("api_key") || name.includes("secret") || name.includes("token")) return "api_key";
  return "credential";
}

function getSensitiveLabel(el: Element, kind: string): string {
  const name = (el as HTMLInputElement).name ?? "";
  const label = findAssociatedLabel(el);
  const labelText = label?.textContent?.trim() ?? "";
  return labelText || name || kind;
}

function findAssociatedLabel(el: Element): HTMLElement | null {
  // Check for explicit <label for="id">
  const input = el as HTMLInputElement;
  if (input.id) {
    const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (label instanceof HTMLElement) return label;
  }
  // Check for wrapping <label>
  const parent = el.closest("label");
  if (parent instanceof HTMLElement) return parent;
  // Check aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/);
    for (const id of parts) {
      const ref = document.getElementById(id);
      if (ref instanceof HTMLElement) return ref;
    }
  }
  // Check preceding sibling or parent's text.
  const prev = el.previousElementSibling;
  if (prev instanceof HTMLElement && prev.textContent?.trim()) return prev;
  return null;
}

/**
 * Find visible text regions carrying PII, using the SAME matchers the text
 * channel tokenizes with (email, phone, checksum-validated IDs). This closes
 * the two-channel gap: an email in plain text was tokenized for the model
 * while remaining fully readable in the screenshot (observed live: PII in
 * opened text files shipped unblurred in the audit's redacted pane).
 *
 * Every match gets Range-measured rectangles — one per wrapped line — and
 * checksum failures are skipped exactly like the text channel skips them.
 */
function findTextRegions(): SensitiveRegion[] {
  const regions: SensitiveRegion[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;

  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    if (text.length < 6) continue; // shorter than the smallest match class

    for (const match of matchPiiInText(text)) {
      try {
        const range = document.createRange();
        range.setStart(node, match.start);
        range.setEnd(node, match.end);
        // A wrapped span produces one rectangle per line: filling the union
        // would cover half the paragraph (raidxAgent's spans.ts insight).
        const rects = Array.from(range.getClientRects()).filter(
          (r) => r.width > 0 && r.height > 0,
        );
        range.detach?.();

        for (const rect of rects) {
          if (rect.top >= innerHeight || rect.bottom <= 0) continue; // off-viewport
          regions.push({
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            kind: `${match.kind}_text`,
            label: `${match.label} in text`,
          });
        }
      } catch {
        // A detached or unusual node — skip this match, keep walking.
      }
    }
  }

  return regions;
}
