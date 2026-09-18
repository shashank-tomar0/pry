import type { ToolSpec } from "./providers/types";

/**
 * The agent's entire action surface. Kept deliberately small: every tool here
 * is one thing a person can do to a web page, and nothing here can reach
 * outside the browser.
 */
export const TOOLS: ToolSpec[] = [
  {
    name: "read_page",
    description:
      "Re-read the current page and return a fresh list of elements with new ids. " +
      "Element ids are only valid for the most recent read — call this after any " +
      "navigation, or whenever an id you expected no longer resolves. This is " +
      "enforced, not advice: an id from an earlier read is refused rather than " +
      "applied to whatever now sits at that number, and the refusal names the " +
      "read you are holding versus the one the page is on.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "click",
    description:
      "Click an element by its id from the most recent page read. Use this for " +
      "links, buttons, checkboxes, tabs, and menu items. Ids are positional: if " +
      "the page changed since the id was issued, the click is refused (and, when " +
      "the intended control is still uniquely identifiable, retried on it).",
    parameters: {
      type: "object",
      properties: {
        element_id: { type: "number", description: "id from the latest page read" },
        reason: { type: "string", description: "One short phrase: why this click" },
      },
      required: ["element_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "click_text",
    description:
      "Click whatever visible text on screen matches, e.g. an inbox row, a search " +
      "result, a list item or a menu entry. Use this when the thing you need to " +
      "click has no element id in the page read — rows and cards often have none. " +
      "Quote text you can actually see; the topmost match wins, and `index` picks " +
      "the next match down when several match equally.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Visible text of the target, e.g. the row's sender and subject" },
        index: { type: "number", description: "0-based position among equally-good matches, topmost first" },
        reason: { type: "string", description: "One short phrase: why this click" },
      },
      required: ["text", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Type text into a text field, replacing whatever is already there. Set " +
      "submit to true to press Enter afterwards, which is usually how you run a " +
      "search. The element_id must come from the most recent page read; an id " +
      "from an earlier read is refused rather than typed into a different control.",
    parameters: {
      type: "object",
      properties: {
        element_id: { type: "number" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after typing" },
        reason: { type: "string" },
      },
      required: ["element_id", "text", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description:
      "Type text into a field named by its visible name — its label, placeholder, " +
      "aria-label or name — for fields that have no element id in the page read: " +
      "search boxes, filter inputs, and form fields inside components the read " +
      "cannot enumerate. Give `field` as the words on or in the box (\"Search\"), " +
      "not its current contents. Set submit true to press Enter afterwards, which " +
      "is how you run a search. If several fields match equally, the result names " +
      "them so you can pass index; if none match, it lists the fields that exist.",
    parameters: {
      type: "object",
      properties: {
        field: {
          type: "string",
          description: "Visible name of the field, e.g. its label or placeholder text",
        },
        text: { type: "string", description: "The text to type into it" },
        submit: { type: "boolean", description: "Press Enter after typing" },
        index: { type: "number", description: "0-based position among equally-good field matches" },
        reason: { type: "string", description: "One short phrase: why this field, this text" },
      },
      required: ["field", "text", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "select",
    description: "Choose an option in a <select> dropdown by its visible label or value.",
    parameters: {
      type: "object",
      properties: {
        element_id: { type: "number" },
        option: { type: "string" },
        reason: { type: "string" },
      },
      required: ["element_id", "option", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description:
      "Scroll the page. Elements marked offscreen in a page read are on the page " +
      "but out of view — scroll toward them before clicking if a click misbehaves.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number", description: "Pixels; defaults to about one screen" },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "key",
    description: "Press a single key such as Enter, Escape, Tab, or ArrowDown.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "find_text",
    description:
      "Search the visible text of the page for a phrase. Cheaper than a full page " +
      "read when you only need to confirm something is present.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "wait",
    description: "Pause for content to load. Use sparingly — most actions already wait.",
    parameters: {
      type: "object",
      properties: { ms: { type: "number", description: "Milliseconds, max 10000" } },
      required: ["ms"],
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description: "Go to a URL in the current tab.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        reason: { type: "string" },
      },
      required: ["url", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "go_back",
    description: "Go back one entry in the tab's history.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_tab",
    description: "Open a URL in a new tab and switch the agent's focus to it.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "list_tabs",
    description: "List the open tabs in this window with their ids, titles, and URLs.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "switch_tab",
    description: "Move the agent's focus to an existing tab by its id from list_tabs.",
    parameters: {
      type: "object",
      properties: { tab_id: { type: "number" } },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "close_tab",
    description: "Close a tab the agent opened.",
    parameters: {
      type: "object",
      properties: { tab_id: { type: "number" } },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
];

/** Actions that run in the page rather than against the tabs API. */
export const PAGE_ACTIONS = new Set([
  "click",
  "click_text",
  "type",
  "type_text",
  "select",
  "scroll",
  "key",
  "find_text",
  "wait",
  "read_page",
]);

/**
 * Actions that cannot change a single pixel.
 *
 * `find_text` and `wait` were already excluded from the post-action capture;
 * `read_page` was not, so a pure text read paid for a full fresh frame — and a
 * frame is not cheap: capture → paint → OCR triage (up to 6 tiles) → pixel
 * verification → OCR re-read → adversarial probes, all awaited before the next
 * planner turn. Measured locally at 2.6 s for a 1x viewport and 10.1 s at the
 * 6-tile cap, per capture, before any model latency is counted.
 *
 * Reading the page as text cannot alter it, so re-capturing after a read is
 * cost with no new evidence attached to it.
 */
export const READ_ONLY_ACTIONS = new Set(["find_text", "wait", "read_page"]);

/**
 * Whether an action justifies re-capturing the tab's pixels.
 *
 * Anything unknown is treated as frame-changing (the conservative direction:
 * a missed capture costs a stale screenshot, a false skip costs an action taken
 * on a page the agent has not seen). Pure and exported so the policy is pinned
 * by the harness rather than inferred from the loop.
 */
export function actionChangesFrame(actionName: string): boolean {
  return !READ_ONLY_ACTIONS.has(actionName);
}

// ─── Action-loop detection ──────────────────────────────────────────────────
//
// Where the agent gets stuck. Pure (it takes names and signatures, nothing
// else) and exported so the three shapes are pinned by the harness instead of
// being read out of a closure in the middle of the agent loop.

/** Identical action+signature, this many turns running. */
export const LOOP_THRESHOLD = 3;
/** How many recent actions the checks look at. */
export const LOOP_WINDOW = 5;

/** One recorded action. `signature` is already semantic (role+name for a click
 *  on an element id), because ids are re-issued on every snapshot. */
export interface ActionStamp {
  name: string;
  signature: string;
}

/** Why a run of recent actions looks stuck. */
export type ActionLoopFinding =
  /** Same action, same argument, LOOP_THRESHOLD turns running. */
  | { kind: "repeat"; action: string }
  /** A -> B -> A -> B with identical arguments: two states, no progress. */
  | { kind: "oscillation"; action: string; other: string }
  /** A full window of turns that only LOOKED at the page. */
  | { kind: "observation"; actions: string[] };

/**
 * The loop verdict for the recent actions, or null when the run is making
 * progress. The three shapes are separate because they need three different
 * sentences: "read_page repeated 3 times" is wrong (and misleading) for an
 * alternation, and a wrong diagnosis is how the planner repeats the very thing
 * it was told to stop.
 *
 * The third shape is the one that used to be missed entirely: alternating
 * READ-ONLY actions with a fresh argument each time — `read_page`,
 * `find_text("harkirat singh")`, `read_page`, `find_text("Videos")`,
 * `find_text("1 day ago")` … — repeats nothing consecutively and has no two
 * equal signatures to oscillate between, yet cannot change the page, so the
 * next snapshot is guaranteed to be the one the agent already has.
 */
export function actionLoopFinding(
  recent: readonly ActionStamp[],
): ActionLoopFinding | null {
  if (recent.length < LOOP_THRESHOLD) return null;

  // 1. Consecutive identical action.
  const last = recent[recent.length - 1];
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].name === last.name && recent[i].signature === last.signature) count++;
    else break;
  }
  if (count >= LOOP_THRESHOLD) return { kind: "repeat", action: last.name };

  // 2. Oscillation (A -> B -> A -> B).
  if (recent.length >= 4) {
    const a1 = recent[recent.length - 1];
    const b1 = recent[recent.length - 2];
    const a2 = recent[recent.length - 3];
    const b2 = recent[recent.length - 4];
    if (
      a1.name === a2.name && a1.signature === a2.signature &&
      b1.name === b2.name && b1.signature === b2.signature
    ) {
      return { kind: "oscillation", action: a1.name, other: b1.name };
    }
  }

  // 3. A full window of turns that could not have changed the page. Reusing
  //    `actionChangesFrame` rather than a list of its own: which actions can
  //    alter the page is decided in ONE place, and a second opinion here would
  //    drift from it. Scrolling is NOT read-only, deliberately — it is how a
  //    target below the fold is reached, and the page that comes back from a
  //    scroll is a different page.
  if (recent.length >= LOOP_WINDOW && recent.every((a) => !actionChangesFrame(a.name))) {
    return { kind: "observation", actions: [...new Set(recent.map((a) => a.name))] };
  }

  return null;
}
