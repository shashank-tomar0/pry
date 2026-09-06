import type { PageElement, PageSnapshot } from "../shared/types";
import { isAadhaarNumber, isCardNumber } from "../shared/checksums";

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

  // 3. Scan visible text for ID numbers (Aadhaar, PAN, SSN, card numbers).
  const idRegions = findTextRegions([
    /\b\d{4}\s?\d{4}\s?\d{4}\b/,           // Aadhaar
    /\b[A-Z]{5}\d{4}[A-Z]\b/,               // PAN
    /\b\d{3}-\d{2}-\d{4}\b/,                // SSN
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // Card numbers
    /\b[A-Z]{2}\d{6,8}\b/,                   // Passport
  ]);
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

  return regions;
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
 * Find visible text regions matching regex patterns using TreeWalker.
 * Returns bounding boxes for matching text nodes.
 */
function findTextRegions(patterns: RegExp[]): SensitiveRegion[] {
  const regions: SensitiveRegion[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;

  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    if (text.length < 8) continue; // Skip short text.

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match.index !== undefined) {
        // ID-shaped numbers are not blacked out on regex alone: 12-digit
        // lookalikes must pass Verhoeff and 16-digit ones must pass Luhn,
        // otherwise order/reference numbers get masked as Aadhaar/cards.
        const digits = match[0].replace(/\D/g, "");
        if (digits.length === 12 && !isAadhaarNumber(digits)) continue;
        if (digits.length === 16 && !isCardNumber(digits)) continue;

        // Get the bounding box of the text node.
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rect = range.getBoundingClientRect();
        range.detach();

        if (rect.width > 0 && rect.height > 0) {
          // Only add if visible in viewport.
          if (rect.top < innerHeight && rect.bottom > 0) {
            regions.push({
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              kind: "id_text",
              label: `ID number in text: ${match[0].slice(0, 8)}...`,
            });
          }
        }
        break; // One match per text node is enough.
      }
    }
  }

  return regions;
}
