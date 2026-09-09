import type { ActionResult, AgentAction } from "../shared/types";
import { lookup, snapshot } from "./perceive";

const fail = (detail: string): ActionResult => ({ ok: false, detail });
const done = (detail: string): ActionResult => ({ ok: true, detail });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
function observeReaction(ms: number): Promise<number> {
  return new Promise((resolve) => {
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
    setTimeout(() => {
      observer.disconnect();
      resolve(count);
    }, ms);
  });
}

function resolve(input: Record<string, unknown>): Element | string {
  const id = input.element_id;
  if (typeof id !== "number") return "element_id must be a number";
  const el = lookup(id);
  if (!el) {
    return `No element ${id} on the current page. The page changed since the last read — call read_page and use the new ids.`;
  }
  return el;
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
    // page read, crowding out the real results). Losing focus closes them.
    (target as HTMLElement).blur?.();
    await sleep(400);
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
  const hits: string[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()) && hits.length < 5) {
    const text = node.textContent?.trim();
    if (text && text.toLowerCase().includes(needle)) {
      const parent = node.parentElement;
      if (parent && parent.offsetParent !== null) {
        hits.push(text.slice(0, 200));
      }
    }
  }
  return hits.length > 0
    ? done(`Found ${hits.length} match(es):\n${hits.map((h) => `- ${h}`).join("\n")}`)
    : fail(`No visible text matching ${JSON.stringify(query)} on this page.`);
}

/** Executes one action in the page. Never throws — errors come back as results. */
export async function act(action: AgentAction): Promise<ActionResult> {
  const { name, input } = action;

  try {
    switch (name) {
      case "click": {
        const el = resolve(input);
        if (typeof el === "string") return fail(el);
        await bringIntoView(el);
        const reaction = observeReaction(500);
        realClick(el);
        const updates = await reaction;
        const verdict = updates > 0
          ? ` Page reacted (${updates} DOM updates).`
          : " NO visible page reaction — the click may have missed or the control is inert. Call read_page to confirm the state before retrying.";
        return done(`Clicked ${describe(el)}.${verdict}`);
      }

      case "type": {
        const el = resolve(input);
        if (typeof el === "string") return fail(el);
        const text = typeof input.text === "string" ? input.text : "";
        return await typeInto(el, text, input.submit === true);
      }

      case "select": {
        const el = resolve(input);
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
        scrollBy({ top: direction * amount, behavior: "instant" as ScrollBehavior });
        await sleep(300);
        const atBottom = scrollY + innerHeight >= document.body.scrollHeight - 4;
        return done(
          `Scrolled ${input.direction === "up" ? "up" : "down"}. Now at y=${Math.round(scrollY)}` +
            (atBottom ? " (bottom of page)." : "."),
        );
      }

      case "key": {
        const key = String(input.key ?? "");
        const target = (document.activeElement ?? document.body) as HTMLElement;
        const init = { bubbles: true, cancelable: true, key, code: key };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        await sleep(200);
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
