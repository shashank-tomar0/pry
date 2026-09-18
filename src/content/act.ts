import type { ActionResult, AgentAction } from "../shared/types";
import { lookupElement, snapshot } from "./perceive";
import { settle, CLICK_CEILING } from "./settle";
import {
  pickTextMatch,
  pickFieldMatch,
  rankFieldMatches,
  isClickableTarget,
  describeTextTarget,
  normalizeForMatch,
  type FieldRun,
  type TextRun,
} from "../shared/text-target";

const fail = (detail: string): ActionResult => ({ ok: false, detail });
const done = (detail: string): ActionResult => ({ ok: true, detail });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Finds the element that actually scrolls.
 *
 * App shells (Gmail, Slack, X) pin the window at zero and scroll an inner
 * container, so a bare `scrollBy` did nothing and the page reported itself as
 * both at the top and at the bottom. Walking up from the element under the
 * viewport's centre finds the same container the user's wheel would move.
 */
function findScroller(): HTMLElement | Element {
  const doc = document.scrollingElement ?? document.documentElement;

  const scrollable = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.scrollHeight <= el.clientHeight + 4) return false;
    const overflow = getComputedStyle(el).overflowY;
    return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
  };

  const start = document.elementFromPoint(
    Math.floor(innerWidth / 2),
    Math.floor(innerHeight / 2),
  );
  for (let el = start; el; el = el.parentElement) {
    if (el === document.body || el === document.documentElement) break;
    if (scrollable(el)) return el;
  }

  // Nothing under the centre scrolls; an app shell may still have one large
  // scrolling panel elsewhere — take the biggest if it is worth having.
  if (doc.scrollHeight <= doc.clientHeight + 4) {
    let best: HTMLElement | undefined;
    let bestArea = 0;
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      if (!scrollable(el)) continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area < innerWidth * innerHeight * 0.2) continue;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    if (best) return best;
  }

  return doc;
}

/**
 * Text runs on screen, each paired with the element a click should target.
 *
 * Two candidates are produced per text run: the run's own clickable container
 * (the nearest `<a>`/`<button>`/`<tr>`/role=… ancestor), and — when the run has
 * no such ancestor — the run itself. The container carries the row's full text,
 * which is what lets "Meta — You're on the Muse waitlist" match even though the
 * sender and the subject are separate spans.
 */
interface TextCandidate extends TextRun {
  element: Element;
  /** Static flags for the pure matcher / reporting. */
  tag: string;
  role: string | null;
}

/** Caps keep the walk bounded on a huge page (a Gmail inbox is ~10k nodes). */
const TEXT_TARGET_BUDGET_MS = 1500;
const TEXT_TARGET_MAX_NODES = 6000;
const TEXT_TARGET_MAX_RUNS = 400;
/** How far up from a text node to look for the clickable container. */
const TEXT_TARGET_CLIMB = 6;

function roleOfElement(el: Element): string | null {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.toLowerCase();
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "option") return "option";
  return null;
}

/**
 * The element that owns a run for clicking purposes.
 *
 * Climbing is capped and only accepts containers whose whole text stays short
 * enough to be a label or a row — otherwise a wrapper `<div>` around the entire
 * inbox would "own" every message and a click would land in the middle of the
 * page instead of on the row the text belongs to.
 */
function clickableOwner(node: Node): Element | null {
  let el: Element | null = node.parentElement;
  let fallback: Element | null = null;
  for (let depth = 0; el && depth < TEXT_TARGET_CLIMB; depth++, el = el.parentElement) {
    const tag = el.tagName.toLowerCase();
    if (tag === "body" || tag === "html" || tag === "main") break;
    const owner = isClickableTarget(tag, roleOfElement(el), el.hasAttribute("tabindex"));
    const textLength = (el.textContent ?? "").trim().length;
    if (owner && textLength <= 240) return el;
    if (!fallback && textLength <= 240) fallback = el;
  }
  return fallback;
}

/**
 * Measure visible text runs and the elements that own them.
 *
 * Text-node walking (not `innerText`) on purpose: a range gives the exact box
 * of the words the planner quoted, and skipping off-screen runs means index 0
 * is the topmost thing the user can actually see.
 */
function collectTextCandidates(): TextCandidate[] {
  const runs: TextCandidate[] = [];
  const deadline = performance.now() + TEXT_TARGET_BUDGET_MS;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let visited = 0;

  while ((node = walker.nextNode())) {
    if (runs.length >= TEXT_TARGET_MAX_RUNS) break;
    if (++visited > TEXT_TARGET_MAX_NODES || performance.now() > deadline) break;
    const text = (node.textContent ?? "").trim();
    if (text.length < 2) continue;
    // Script/style text is never visible; skip it rather than measuring it.
    const parentTag = node.parentElement?.tagName.toLowerCase();
    if (!parentTag || parentTag === "script" || parentTag === "style" || parentTag === "noscript") continue;

    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      range.detach?.();
      for (const rect of rects) {
        if (rect.top >= innerHeight || rect.bottom <= 0) continue; // off-screen
        if (rect.left >= innerWidth || rect.right <= 0) continue;
        const owner = clickableOwner(node);
        if (!owner) continue;
        runs.push({
          text,
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          element: owner,
          tag: owner.tagName.toLowerCase(),
          role: roleOfElement(owner),
        });
      }
    } catch {
      // A detached or unmeasurable node — skip it and keep walking.
    }
  }

  // A container's OWN text is the best candidate for a row-level query: it is
  // how "Meta You're on the Muse waitlist" matches even though the sender and
  // subject are separate text nodes. Dropped for nodes whose text is already
  // just that container's text (the single-span case).
  const byOwner = new Map<Element, TextCandidate>();
  const textsByOwner = new Map<Element, string[]>();
  for (const run of runs) {
    if (!byOwner.has(run.element)) byOwner.set(run.element, run);
    const texts = textsByOwner.get(run.element);
    if (!texts) textsByOwner.set(run.element, [run.text]);
    else if (texts[texts.length - 1] !== run.text) texts.push(run.text);
  }
  const containerRuns: TextCandidate[] = [];
  for (const [element, sample] of byOwner) {
    // Joined from the MEASURED runs rather than `textContent`, and joined with
    // a space. Minified app markup (Gmail) has no whitespace text nodes between
    // cells, so textContent gives "MetaYou're on the Muse waitlist1:19 AM" —
    // which a planner quoting the row naturally, with spaces, cannot match.
    const text = (textsByOwner.get(element) ?? [sample.text]).join(" ");
    if (text.length < 2 || text.length > 240) continue;
    if (text === sample.text) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.top >= innerHeight || rect.bottom <= 0) continue;
    containerRuns.push({
      text,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      element,
      tag: element.tagName.toLowerCase(),
      role: roleOfElement(element),
    });
  }

  return [...containerRuns, ...runs];
}

/**
 * Click whatever on screen says `query`.
 *
 * The capability this adds: element ids only exist for elements the page read
 * selected, and a row driven by a delegated handler has no id to give. The
 * planner can always see the text, so the text becomes the handle.
 */
async function clickByText(
  query: string,
  index: number,
  settleCeiling: number,
): Promise<ActionResult> {
  const wanted = query.trim();
  if (wanted.length < 2) {
    return fail("click_text needs at least 2 characters of visible text to match.");
  }
  const candidates = collectTextCandidates();
  if (candidates.length === 0) {
    return fail("No visible text could be measured on this page. Call read_page to see what is there.");
  }
  const match = pickTextMatch(candidates, wanted, index);
  if (!match) {
    const sample = candidates
      .slice(0, 6)
      .map((c) => JSON.stringify(normalizeForMatch(c.text).slice(0, 28)))
      .join(", ");
    return fail(
      `No visible text on screen matches ${JSON.stringify(wanted)}. ` +
      `Text measured on this frame starts with: ${sample}. ` +
      `If you are looking for something you can SEE but it is inside another site's popup, ` +
      `player or embedded frame, it is not reachable from here: use navigate with the target's ` +
      `URL instead. Otherwise call read_page for the full list.`,
    );
  }

  const target = match.run.element;
  await bringIntoView(target);
  const reaction = watchMutations();
  realClick(target);
  await settle({ ceiling: settleCeiling });
  const updates = reaction.count();
  reaction.stop();

  const what = describeTextTarget(match.run.text, match.run.tag, match.run.role);
  const verdict = updates > 0
    ? ` Page reacted (${updates} DOM updates).`
    : " NO visible page reaction — the text may be non-interactive, or the click missed. Call read_page to confirm.";
  return done(`Clicked ${what} (${match.reason} match).${verdict}`);
}

/**
 * Controls someone can type into. `type` needs an element id, and the page read
 * is capped and dominated by page chrome — on the sites this matters most
 * (search boxes, filter inputs, compose fields inside UI-kit wrappers) the field
 * either misses the budget or has no id at all. Its NAME is always on screen,
 * so the name becomes the handle, exactly as it does for `click_text`.
 */
const FIELD_SELECTOR = [
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset])",
  "input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=image])",
  "input:not([type=range]):not([type=color])",
  "textarea",
  "[contenteditable='']",
  "[contenteditable=true]",
  "[role=searchbox]",
  "[role=textbox]",
  "[role=combobox]",
].join(", ");

/** How far up from a field to look for the name its wrapper carries. */
const FIELD_NAME_CLIMB = 3;

/**
 * Every name a field answers to, best first.
 *
 * A person names a search box "Search" whether that word is its placeholder, its
 * aria-label, its <label>, or the title on the component wrapping it — and which
 * one a given site uses is arbitrary. Matching all of them is what makes the tool
 * work without a per-site table. The wrapper climb of 3 covers UI kits that put
 * the name on a `role=combobox` div and leave the inner input bare, which is the
 * shape this exists for.
 */
function fieldLabels(el: Element, target: Element): string[] {
  const labels: string[] = [];
  const input = target as HTMLInputElement;
  const push = (value: string | null | undefined): void => {
    const text = (value ?? "").trim();
    if (text && !labels.includes(text)) labels.push(text);
  };

  for (const el2 of [target, el]) {
    push(el2.getAttribute("aria-label"));
    const labelledBy = el2.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) push(document.getElementById(id)?.textContent);
    }
  }
  if (input.labels) for (const label of Array.from(input.labels)) push(label.textContent);
  const wrappingLabel = target.closest("label");
  if (wrappingLabel) push(wrappingLabel.textContent);
  push(input.placeholder);
  for (const el2 of [target, el]) push(el2.getAttribute("title"));
  push(input.name);
  // The wrapper's own aria-label/title, for components that name the box one
  // level up from the input they contain.
  let up: Element | null = target.parentElement;
  for (let depth = 0; up && depth < FIELD_NAME_CLIMB; depth++, up = up.parentElement) {
    push(up.getAttribute("aria-label"));
    push(up.getAttribute("title"));
  }
  return labels;
}

/**
 * Measurable, writable text fields, each with the names it answers to.
 *
 * Keyed by the RESOLVED writable node: a `role=combobox` wrapper and the <input>
 * inside it are one field, not two, and the labels gathered from the wrapper are
 * merged onto the input so naming it works either way.
 */
function collectFieldCandidates(): Array<FieldRun & { element: Element }> {
  const fields = new Map<Element, FieldRun & { element: Element }>();
  const deadline = performance.now() + TEXT_TARGET_BUDGET_MS;
  let visited = 0;

  for (const el of Array.from(document.body.querySelectorAll(FIELD_SELECTOR))) {
    if (++visited > TEXT_TARGET_MAX_NODES || performance.now() > deadline) break;
    if ((el as HTMLInputElement).disabled) continue;
    const input = el as HTMLInputElement;
    if (input.readOnly) continue;
    // Zero client rects means display:none, a collapsed ancestor, or a detached
    // node — a field nobody can type into.
    if (el.getClientRects().length === 0) continue;
    // A wrapper (`role=combobox` around the real input) resolves to the node that
    // actually takes text — the same resolution `type` does, so naming a field
    // cannot type into a div. A wrapper whose inner control is missing is not writable
    // at all and is skipped rather than listed as a field that cannot be used.
    const writable = writableTarget(el);
    const directlyWritable =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.hasAttribute("contenteditable");
    if (!writable && !directlyWritable) continue;
    const target = writable ?? el;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const role = roleOfElement(target) ?? roleOfElement(el) ?? (target instanceof HTMLInputElement ? "textbox" : null);
    const labels = fieldLabels(el, target);
    if (labels.length === 0) continue;
    const existing = fields.get(target);
    if (existing) {
      for (const label of labels) if (!existing.labels.includes(label)) existing.labels.push(label);
      continue;
    }
    fields.set(target, {
      text: labels[0],
      labels,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      tag: target.tagName.toLowerCase(),
      role,
      element: target,
    });
  }

  return Array.from(fields.values());
}

/** Names every field the page offers, so a missed query is recoverable. */
function describeAvailableFields(fields: Array<FieldRun & { element: Element }>): string {
  return fields
    .slice(0, 8)
    .map((f) => `${JSON.stringify(normalizeForMatch(f.labels[0]).slice(0, 40))} (${f.role ?? f.tag})`)
    .join(", ");
}

/**
 * Type into a field named by its visible label, placeholder or name.
 *
 * The refusal paths are the useful ones: a query that matches several fields of
 * equal standing reports the others instead of picking silently, and a query that
 * matches nothing lists what the page does offer — which is what turns a dead end
 * into one more turn instead of another blind `type` on a guessed id.
 */
async function typeByText(
  field: string,
  text: string,
  submit: boolean,
  index: number,
): Promise<ActionResult> {
  const wanted = field.trim();
  if (wanted.length < 2) {
    return fail("type_text needs the field's visible name (at least 2 characters) to know where to type.");
  }
  const fields = collectFieldCandidates();
  if (fields.length === 0) {
    return fail(
      "No text fields with a usable name are visible on this page. Call read_page, or scroll to bring " +
      "the field into view.",
    );
  }
  const match = pickFieldMatch(fields, wanted, index);
  if (!match) {
    return fail(
      `No text field on this page is named ${JSON.stringify(wanted)}. ` +
      `Fields available: ${describeAvailableFields(fields)}. ` +
      `Use one of those names, or read_page if the field is further down the page.`,
    );
  }

  const result = await typeInto(match.run.element, text, submit);
  if (!result.ok) return result;

  // Naming the other equal-standing matches is the difference between "the query
  // was ambiguous and the tool chose" and a silent choice the model cannot see: it
  // can retry with `index` in one turn instead of wondering which box took the text.
  const others = rankFieldMatches(fields, wanted).filter((m) => m.run.element !== match.run.element);
  const ambiguity = others.length > 0
    ? ` ${others.length} other field(s) match ${JSON.stringify(wanted)} — pass index 1..${others.length} to pick one: ` +
      others.map((m) => JSON.stringify(normalizeForMatch(m.run.labels[0]).slice(0, 30))).join(", ") + "."
    : "";

  return done(
    `Matched the field named ${JSON.stringify(match.run.labels[0])} (${match.reason} match). ${result.detail}${ambiguity}`,
  );
}

function describe(el: Element): string {
  // A click detail of just "<button>" is undebuggable and untrustworthy for
  // the model — icon-only buttons have empty innerText, so fall back to the
  // accessible name sources before giving up on a name.
  const name =
    (el as HTMLElement).innerText?.trim().slice(0, 60) ||
    el.getAttribute("aria-label")?.trim().slice(0, 60) ||
    (el as HTMLInputElement).placeholder?.trim().slice(0, 60) ||
    el.getAttribute("title")?.trim().slice(0, 60) ||
    el.getAttribute("name")?.trim().slice(0, 60) ||
    "";
  return `<${el.tagName.toLowerCase()}${name ? ` "${name}"` : " (unnamed)"}>`;
}

/**
 * Counts DOM mutations for `ms` after an action so the result can say whether
 * the page actually reacted. "Clicked <button>." with ok:true is not evidence
 * anything happened — a synthetic click on an inert overlay, a hidden handler,
 * or a stale node all return fine while nothing changes. Telling the model
 * "no visible page reaction" turns a silent failure into a recoverable one.
 */
function watchMutations(): { count: () => number; stop: () => void } {
  let count = 0;
  const observer = new MutationObserver((mutations) => {
    count += mutations.length;
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  return {
    count: () => count,
    stop: () => observer.disconnect(),
  };
}

/**
 * Resolves the id a tool call asked for, refusing one from an older page read.
 *
 * The refusal is the point. Element ids are positional, so "element 3" from two
 * reads ago may be a completely different control now — and a click or a type
 * that lands on the wrong control returns ok:true and reports success. Asking
 * for a fresh read costs one turn; acting on the wrong element can submit a
 * form, send a message or delete something. So a stale id is refused, and the
 * message names both reads so the planner can see what happened.
 */
function resolve(input: Record<string, unknown>, generation?: number): Element | string {
  const id = input.element_id;
  if (typeof id !== "number") return "element_id must be a number";
  const found = lookupElement(id, generation);
  if (found.ok) return found.element;
  if (found.reason === "stale") {
    return (
      `Element ${id} came from page read #${found.askedFor}, but the page has been read again since ` +
      `(#${found.current}). Element numbers are positional, so #${id} may now mean a different ` +
      `control — the action was refused rather than risk the wrong element. ` +
      `Call read_page and use the ids from the newest read.`
    );
  }
  return `No element ${id} on the current page. The page changed since the last read — call read_page and use the new ids.`;
}

async function bringIntoView(el: Element): Promise<void> {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  await sleep(60);
}

/**
 * Frameworks like React attach listeners for the full pointer sequence and
 * ignore a bare .click(). Replaying the real sequence makes the interaction
 * indistinguishable from a user's.
 */
function realClick(el: Element): void {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };

  (el as HTMLElement).focus?.({ preventScroll: true });
  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", base));
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.dispatchEvent(new MouseEvent("click", base));
}

/**
 * React tracks input values on the DOM node itself and swallows an `input`
 * event whose value it believes it already applied. Writing through the native
 * prototype setter bypasses that tracker.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/**
 * Finds the actually-writable node inside an element. Some field components
 * (Gmail's compose recipient box, many UI kits) expose a `role=combobox` or
 * label wrapper around the real <input>/<textarea>/contenteditable, so typing
 * must target the inner control, not the wrapper.
 */
function writableTarget(el: Element): Element | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
  if (el.hasAttribute("contenteditable")) return el;
  const role = el.getAttribute("role");
  if (role === "combobox" || role === "textbox" || role === "searchbox") {
    const inner = el.querySelector("input:not([type=hidden]), textarea, [contenteditable=''], [contenteditable=true]");
    if (inner) return inner;
  }
  return null;
}

async function typeInto(el: Element, text: string, submit: boolean): Promise<ActionResult> {
  const target = writableTarget(el);
  if (!target) {
    return fail(`${describe(el)} is not a text field.`);
  }
  await bringIntoView(target);
  (target as HTMLElement).focus({ preventScroll: true });

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    setNativeValue(target, "");
    target.dispatchEvent(new Event("input", { bubbles: true }));
    setNativeValue(target, text);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (target.hasAttribute("contenteditable")) {
    (target as HTMLElement).textContent = text;
    target.dispatchEvent(new InputEvent("input", { bubbles: true }));
  } else {
    return fail(`${describe(target)} is not a text field.`);
  }

  if (submit) {
    const enter = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    };
    // dispatchEvent returns false when a page handler called preventDefault —
    // that is our signal the page took the keypress and will submit itself.
    const handled = !target.dispatchEvent(new KeyboardEvent("keydown", enter));
    target.dispatchEvent(new KeyboardEvent("keyup", enter));
    // Plain forms ignore a synthetic Enter, so submit them directly instead.
    const form = (target as HTMLInputElement).form;
    if (!handled && form) form.requestSubmit?.();
    // Blur after submitting: sites keep autocomplete/search-suggestion
    // dropdowns open while the input holds focus (YouTube's suggestion panel
    // stayed open over the results and its option items then flooded the next
    // page read). Losing focus closes them.
    (target as HTMLElement).blur?.();
    // DOM-settle instead of a fixed 400ms: navigation commits get the full
    // ceiling, no-op Enters return fast.
    await settle({ start: 250, ceiling: 1500 });
  }

  // Ground truth beats intent: the page may reformat, truncate, chip or
  // prefix what we typed (Gmail's recipient combobox showed a different
  // value than the one we sent, and the model burned turns reconciling the
  // two). Report what the field holds NOW so the model never has to guess.
  const echo =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.value
      : (target.textContent ?? "");

  return done(
    `Typed ${JSON.stringify(text)} into ${describe(target)}. ` +
      `Field now shows: ${JSON.stringify(echo.trim().slice(0, 60))}` +
      (submit ? ", and pressed Enter." : "."),
  );
}

function findText(query: string): ActionResult {
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const candidates: string[] = [];
  const seen = new Set<string>();
  let node: Node | null;
  while ((node = walker.nextNode()) && candidates.length < 24) {
    const text = node.textContent?.trim();
    if (text && text.toLowerCase().includes(needle)) {
      const parent = node.parentElement;
      if (parent && parent.offsetParent !== null && !seen.has(text)) {
        seen.add(text);
        candidates.push(text.slice(0, 200));
      }
    }
  }
  if (candidates.length === 0) {
    return fail(`No visible text matching ${JSON.stringify(query)} on this page.`);
  }
  // Rank, don't just take document order: the node whose ENTIRE text is the
  // needle ("YouTube" — a menu item) is almost always what the planner is
  // hunting for, while long nodes that merely contain it ("YouTube - Quarterly
  // reminder about YouTube's Terms of Service…" — newsletter rows) used to
  // fill the hit cap in DOM order and hide the actual match. Ties break
  // toward shorter text.
  const rank = (text: string): number => {
    const lower = text.toLowerCase();
    if (lower === needle) return 0;
    if (lower.startsWith(needle)) return 1;
    return 2;
  };
  const top = candidates
    .map((text) => ({ text, r: rank(text), len: text.length }))
    .sort((a, b) => a.r - b.r || a.len - b.len)
    .slice(0, 5);
  const scope = candidates.length > top.length ? ` (top ${top.length} of ${candidates.length})` : "";
  return done(
    `Found ${candidates.length} match(es)${scope}:\n${top.map((h) => `- ${h.text}`).join("\n")}`,
  );
}

/** Executes one action in the page. Never throws — errors come back as results. */
export async function act(action: AgentAction): Promise<ActionResult> {
  const { name, input } = action;

  try {
    switch (name) {
      case "click": {
        const el = resolve(input, action.snapshotGeneration);
        if (typeof el === "string") return fail(el);
        await bringIntoView(el);
        const reaction = watchMutations();
        realClick(el);
        // DOM-settle instead of a fixed sleep: fast on static pages, patient
        // on slow mounts (cold Gmail compose). The watcher counts the
        // mutations that arrived while settling, so the "Page reacted"
        // verdict still measures real activity — and the count is read when
        // settle resolves, not after a fixed window.
        await settle({ ceiling: CLICK_CEILING });
        const updates = reaction.count();
        reaction.stop();
        const verdict = updates > 0
          ? ` Page reacted (${updates} DOM updates).`
          : " NO visible page reaction — the click may have missed or the control is inert. Call read_page to confirm the state before retrying.";
        return done(`Clicked ${describe(el)}.${verdict}`);
      }

      case "click_text": {
        // The handle that exists when no element id does: inbox rows, search
        // results, list items and menu entries are often not in the page read
        // at all, but their text is always visible.
        const text = typeof input.text === "string" ? input.text : "";
        const index = typeof input.index === "number" ? input.index : 0;
        return await clickByText(text, index, CLICK_CEILING);
      }

      case "type": {
        const el = resolve(input, action.snapshotGeneration);
        if (typeof el === "string") return fail(el);
        const text = typeof input.text === "string" ? input.text : "";
        return await typeInto(el, text, input.submit === true);
      }

      case "type_text": {
        // The handle that exists when a field has no element id: its name. Ids
        // come from the page read, and a search box or filter input inside a
        // component may not be in it at all. This never touches the registry, so
        // it cannot act on a stale id either.
        const field = typeof input.field === "string" ? input.field : "";
        const text = typeof input.text === "string" ? input.text : "";
        const index = typeof input.index === "number" ? input.index : 0;
        return await typeByText(field, text, input.submit === true, index);
      }

      case "select": {
        const el = resolve(input, action.snapshotGeneration);
        if (typeof el === "string") return fail(el);
        if (!(el instanceof HTMLSelectElement)) {
          return fail(`${describe(el)} is not a <select>.`);
        }
        const wanted = String(input.option ?? "");
        const match = Array.from(el.options).find(
          (o) =>
            o.value === wanted ||
            o.textContent?.trim().toLowerCase() === wanted.toLowerCase(),
        );
        if (!match) {
          const available = Array.from(el.options)
            .map((o) => o.textContent?.trim())
            .filter(Boolean)
            .slice(0, 20)
            .join(", ");
          return fail(`No option ${JSON.stringify(wanted)}. Available: ${available}`);
        }
        el.value = match.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return done(`Selected ${JSON.stringify(match.textContent?.trim())}.`);
      }

      case "scroll": {
        const direction = input.direction === "up" ? -1 : 1;
        const amount = typeof input.amount === "number" ? input.amount : innerHeight * 0.8;
        // Scroll the container that actually moves (document OR app shell).
        // Reporting `moved` matters: a scroll that changed nothing must not
        // be described as if it had.
        const el = findScroller();
        const doc = document.scrollingElement ?? document.documentElement;
        const inner = el !== doc;
        const before = inner ? (el as HTMLElement).scrollTop : scrollY;
        if (inner) {
          (el as HTMLElement).scrollTop = before + direction * amount;
        } else {
          scrollBy({ top: direction * amount, behavior: "instant" as ScrollBehavior });
        }
        await settle({ start: 200, ceiling: 1200 });
        const after = inner ? (el as HTMLElement).scrollTop : scrollY;
        const height = inner ? (el as HTMLElement).clientHeight : innerHeight;
        const total = inner
          ? (el as HTMLElement).scrollHeight
          : Math.max(doc.scrollHeight, document.body.scrollHeight, innerHeight);
        const moved = Math.abs(after - before) > 1;
        if (!moved) {
          return done(
            `Scrolled but nothing moved — ${inner ? "this panel" : "the page"} is already at its ${direction === 1 ? "bottom" : "top"}. Use read_page to see the current content.`,
          );
        }
        const atBottom = after + height >= total - 4;
        return done(
          `Scrolled ${direction === 1 ? "down" : "up"}${inner ? " (app panel)" : ""}. Now at y=${Math.round(after)}` +
            (atBottom ? " (bottom of page)." : "."),
        );
      }

      case "key": {
        const key = String(input.key ?? "");
        const target = (document.activeElement ?? document.body) as HTMLElement;
        const init = { bubbles: true, cancelable: true, key, code: key };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        await settle({ start: 150, ceiling: 600 });
        return done(`Pressed ${key}.`);
      }

      case "find_text":
        return findText(String(input.query ?? ""));

      case "wait": {
        const ms = Math.min(Number(input.ms ?? 1000), 10000);
        await sleep(ms);
        return done(`Waited ${ms}ms.`);
      }

      case "read_page":
        return { ok: true, detail: "Read the page.", snapshot: snapshot() };

      default:
        return fail(`Action ${name} is not handled in the page context.`);
    }
  } catch (error) {
    return fail(`${name} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
