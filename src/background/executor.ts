import type {
  ActionResult,
  AgentAction,
  ContentRequest,
  PageSnapshot,
} from "../shared/types";
import { PAGE_ACTIONS } from "./tools";
import { canonicalHost } from "./deterministic";

/**
 * How long a content-script round trip may take before we treat it as hung.
 *
 * 10 s turned slow-but-alive page work (a heavy page re-perceiving its DOM
 * while an animation runs) into a reported failure, and the agent then
 * re-planned against a page that had actually succeeded. Long enough to
 * absorb a busy main thread, still short enough that a dead content script
 * surfaces as an error instead of a silent freeze.
 */
const CONTENT_TIMEOUT_MS = 20_000;

/** Tracks which tab the agent is currently driving. */
export class TabController {
  constructor(public tabId: number) {}

  /**
   * Sends a message to the page, injecting the content script first if the tab
   * predates the extension being installed or reloaded. Every round trip is
   * bounded: a dead or hung content script must surface as an error, never as
   * an infinite silent freeze between log lines.
   */
  private async send(request: ContentRequest): Promise<ActionResult> {
    const kind = request.kind;
    const call = () =>
      new Promise<ActionResult>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `The page did not respond to ${kind} within ${Math.round(CONTENT_TIMEOUT_MS / 1000)}s — the tab may be busy or the content script stopped. Try the task again on a freshly loaded page.`,
              ),
            ),
          CONTENT_TIMEOUT_MS,
        );
        chrome.tabs.sendMessage(this.tabId, request).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });

    try {
      return await call();
    } catch (error) {
      // Injection errors and "Receiving end does not exist" mean the content
      // script is missing — inject once and retry. Timeouts are NOT retried
      // (the page genuinely did not answer) and bubble up as-is.
      const message = error instanceof Error ? error.message : String(error);
      // A page that navigates mid-action destroys the old content script and
      // closes the channel mid-response. The NEW page is about to be read
      // anyway, so this is recoverable: inject on the fresh document and
      // retry once instead of failing the whole run.
      const navigationClosed = /message channel closed/i.test(message);
      const missingScript =
        /Receiving end does not exist|Could not establish connection|No tab with id/i.test(message)
        || navigationClosed;
      if (!missingScript || message.startsWith("The page did not respond")) throw error;
      await this.inject();
      return await call();
    }
  }

  private async inject(): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      files: ["content.js"],
    });
  }

  /**
   * Resolves once the tab has finished loading, or after a timeout.
   *
   * `untilNotUrl` is the URL the tab was showing BEFORE the caller asked the
   * browser to go somewhere else, and passing it is what makes this wait mean
   * anything for a navigation. `chrome.tabs.update({url})` resolves as soon as
   * the navigation is REQUESTED, and the outgoing document stays
   * `status: "complete"` for a beat afterwards — so a wait keyed only on
   * "complete" returned instantly, the caller then read the old URL, found it
   * perfectly valid, and reported "Navigated to https://youtube.com." while the
   * tab was still on mail.google.com. The planner read the old page, saw the
   * contradiction between the action report and the page, and burned turns
   * reconciling it.
   *
   * Waiting for the URL to actually CHANGE is the only signal available here
   * that the old document is gone. Redirects are handled by "different from the
   * old URL", not "equal to the requested one": gmail.com legitimately lands on
   * mail.google.com, and that is a successful navigation.
   */
  async waitForLoad(timeoutMs = 8000, untilNotUrl?: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const previous = (untilNotUrl ?? "").trim();
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(this.tabId).catch(() => null);
      if (!tab) return;
      const leftOldDocument = previous === "" || tab.url !== previous;
      if (leftOldDocument && tab.status === "complete") {
        // Give client-rendered pages a moment to paint their first content.
        await new Promise((r) => setTimeout(r, 400));
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async snapshot(): Promise<PageSnapshot | undefined> {
    const result = await this.send({ kind: "snapshot" }).catch(() => undefined);
    return result?.snapshot;
  }

  async act(action: AgentAction): Promise<ActionResult> {
    return this.send({ kind: "act", action });
  }
}

/** URLs the content script can never run on, so the agent cannot work there. */
export function isRestricted(url: string | undefined): boolean {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://") ||
    url.startsWith("https://chromewebstore.google.com")
  );
}

/** Only these schemes may drive a navigate/open_tab — browser-internal and
 * non-web schemes (file:, chrome:, about:, data:, javascript:, edge:, etc.)
 * are refused so the model or a prompt-injected page cannot steer the agent
 * onto internal pages or privileged URI handlers. */
const ALLOWED_NAV_SCHEMES = new Set(["http:", "https:"]);

/**
 * Returns `true` when a navigable URL uses only allowed schemes, or `false`
 * (refusing the navigation) for anything browser-internal or non-web.
 * Exported for the verification harness; the agent loop calls execute(),
 * which enforces this before any chrome.tabs call.
 */
export function isNavigableUrl(raw: string): boolean {
  try {
    const colon = raw.indexOf(":");
    if (colon === -1) return true; // no scheme — normalised later
    const scheme = raw.slice(0, colon + 1).toLowerCase();
    return ALLOWED_NAV_SCHEMES.has(scheme);
  } catch {
    return false;
  }
}

function normaliseUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) {
    // A host with no dot (https://gmail) is never a real site: correct known
    // names to their canonical TLD, otherwise search instead of dead-ending.
    // localhost and bare IPs are legit (Ollama) and pass through untouched.
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      const isBare =
        !host.includes(".") &&
        host !== "localhost" &&
        !/^\d{1,3}(\.\d{1,3}){3}$/.test(host);
      if (isBare) {
        const canonical = canonicalHost(host);
        if (canonical) {
          u.hostname = canonical;
          return u.toString();
        }
        return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
      }
    } catch {
      // Unparseable — fall through to the raw URL and let the browser decide.
    }
    return raw;
  }
  if (/^[\w-]+(\.[\w-]+)+/.test(raw)) {
    // "www.gmail" is www + a bare name — canonicalize it too.
    const bare = canonicalHost(raw.replace(/^www\./i, ""));
    if (bare) return `https://${bare}`;
    return `https://${raw}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
}

/**
 * True when two URLs name the same site (host, ignoring a leading `www.`).
 *
 * Deliberately host-level, not string-level: the question the navigate path
 * asks is "is the tab already where I am being asked to send it?", and asking
 * that string-for-string would call `https://youtube.com` and
 * `https://www.youtube.com/` different places. It is used only to decide
 * whether an UNCHANGED tab url is a failure or a no-op re-navigation, never to
 * claim a navigation succeeded — a redirect that changes the site (gmail.com →
 * mail.google.com) is a success because the URL CHANGED, and that is decided by
 * comparison with the previous URL, not by this function.
 *
 * Exported for the verification harness.
 */
export function sameSite(a: string | undefined, b: string | undefined): boolean {
  const host = (raw: string | undefined): string | null => {
    if (!raw) return null;
    try {
      return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return null;
    }
  };
  const ha = host(a);
  const hb = host(b);
  return ha !== null && ha === hb;
}

/**
 * Chrome error pages (chrome-error://chromewebdata/…) are unreadable by
 * extensions and invisible to the content script. Detecting them here turns a
 * confusing dead tab into a clean, explainable failure the planner can recover
 * from (and the learning loop can classify).
 */
export function chromeErrorReason(url: string | undefined): string | undefined {
  if (!url || !url.startsWith("chrome-error://")) return undefined;
  const m = url.match(/[?&]error=([^&#]+)/i);
  return m ? decodeURIComponent(m[1]) : "browser error page";
}

/**
 * Runs one action, routing page-level work to the content script and
 * tab-level work to the browser APIs. Returns the result plus, when the page
 * may have changed, a fresh snapshot so the planner never acts on stale ids.
 */
export async function execute(
  controller: TabController,
  action: AgentAction,
): Promise<{ result: ActionResult; controller: TabController }> {
  const { name, input } = action;

  if (PAGE_ACTIONS.has(name)) {
    const tab = await chrome.tabs.get(controller.tabId).catch(() => null);
    if (isRestricted(tab?.url)) {
      return {
        result: {
          ok: false,
          detail:
            `This tab (${tab?.url ?? "unknown"}) is a browser-internal page that ` +
            `extensions cannot read. Navigate somewhere else first.`,
        },
        controller,
      };
    }
    const beforeUrl = tab?.url ?? "";
    const result = await controller.act(action);
    if (result.ok) {
      // SPA navigations (YouTube: click a thumbnail → /watch; Gmail: open a
      // conversation) change the URL via history.pushState without a real
      // load event. The content script's post-click settle window can race
      // the new page's first render and hand the planner a half-transitioned
      // DOM — a watch-page URL with homepage elements — which the planner
      // then cannot reconcile. A URL change after the action is the reliable
      // signal: wait for the page to finish rendering and re-perceive once.
      const afterUrl = (await chrome.tabs.get(controller.tabId).catch(() => null))?.url ?? "";
      if (afterUrl && afterUrl !== beforeUrl) {
        await controller.waitForLoad();
        const fresh = await controller.snapshot();
        if (fresh) result.snapshot = fresh;
      }
    }
    return { result, controller };
  }

  switch (name) {
    case "navigate": {
      const rawUrl = String(input.url ?? "");
      if (!isNavigableUrl(rawUrl)) {
        return {
          result: {
            ok: false,
            detail:
              `Refusing to navigate to "${rawUrl.slice(0, 60)}" — only http/https destinations are allowed. ` +
              `I can't open browser-internal pages, local files, or custom URL handlers.`,
          },
          controller,
        };
      }
      const url = normaliseUrl(rawUrl);
      // Where the tab was, so the wait can tell "still on the old page" from
      // "arrived". See waitForLoad.
      const before = (await chrome.tabs.get(controller.tabId).catch(() => null))?.url;
      await chrome.tabs.update(controller.tabId, { url });
      await controller.waitForLoad(8000, before);
      const tab = await chrome.tabs.get(controller.tabId).catch(() => null);
      const errorReason = chromeErrorReason(tab?.url);
      if (errorReason) {
        return {
          result: {
            ok: false,
            detail:
              `Navigation failed — ${errorReason} (${tab?.url ?? url}). ` +
              `The page never loaded; the URL may be malformed. Re-navigate with a corrected URL.`,
          },
          controller,
        };
      }
      // The tab never moved. Reporting success here is what produced the
      // contradiction above; saying so plainly lets the planner re-navigate
      // instead of acting on a page it was told had been replaced. A request for
      // the site the tab is ALREADY on is not a failure, so it is excluded.
      if (before && tab?.url === before && !sameSite(before, url)) {
        return {
          result: {
            ok: false,
            detail:
              `Navigation to ${url} did not take effect — the tab is still on ${tab.url}. ` +
              `The page was NOT replaced, so anything you read from it is the old page. ` +
              `Re-navigate to ${url} (a second attempt usually lands), or use the URL that ` +
              `is actually open if that is what the task needs.`,
          },
          controller,
        };
      }
      // The reported destination is the tab's, not the requested one: a
      // redirect to a different host is normal, and the next page read will
      // show THAT url, so the action report must not disagree with it.
      return { result: { ok: true, detail: `Navigated to ${tab?.url ?? url}.` }, controller };
    }

    case "go_back": {
      await chrome.tabs.goBack(controller.tabId).catch(() => undefined);
      await controller.waitForLoad();
      const tab = await chrome.tabs.get(controller.tabId);
      const errorReason = chromeErrorReason(tab?.url);
      if (errorReason) {
        return {
          result: {
            ok: false,
            detail: `Went back, but the page failed to load — ${errorReason}.`,
          },
          controller,
        };
      }
      return { result: { ok: true, detail: `Went back. Now on ${tab.url}.` }, controller };
    }

    case "open_tab": {
      const rawUrl = String(input.url ?? "");
      if (!isNavigableUrl(rawUrl)) {
        return {
          result: {
            ok: false,
            detail:
              `Refusing to open "${rawUrl.slice(0, 60)}" — only http/https destinations are allowed.`,
          },
          controller,
        };
      }
      const url = normaliseUrl(rawUrl);
      const tab = await chrome.tabs.create({ url, active: true });
      const next = new TabController(tab.id!);
      await next.waitForLoad(8000, "");
      const loaded = await chrome.tabs.get(tab.id!).catch(() => null);
      const errorReason = chromeErrorReason(loaded?.url);
      if (errorReason) {
        return {
          result: {
            ok: false,
            detail:
              `Opened ${url} in tab ${tab.id}, but the page failed to load — ${errorReason}. ` +
              `The URL may be malformed; re-navigate with a corrected URL.`,
          },
          controller: next,
        };
      }
      return {
        // The tab's own URL, so a redirect does not make the report disagree
        // with the page the agent is about to read.
        result: {
          ok: true,
          detail: `Opened ${loaded?.url ?? url} in new tab ${tab.id}. Agent focus moved there.`,
        },
        controller: next,
      };
    }

    case "list_tabs": {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const lines = tabs.map(
        (t) => `- id ${t.id}${t.id === controller.tabId ? " (current)" : ""}: ${t.title} — ${t.url}`,
      );
      return { result: { ok: true, detail: lines.join("\n") }, controller };
    }

    case "switch_tab": {
      const tabId = Number(input.tab_id);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return { result: { ok: false, detail: `No tab ${tabId}.` }, controller };
      await chrome.tabs.update(tabId, { active: true });
      const next = new TabController(tabId);
      await next.waitForLoad();
      return { result: { ok: true, detail: `Switched to tab ${tabId}: ${tab.title}.` }, controller: next };
    }

    case "close_tab": {
      const tabId = Number(input.tab_id);
      if (tabId === controller.tabId) {
        return {
          result: { ok: false, detail: "Refusing to close the tab the agent is working in." },
          controller,
        };
      }
      await chrome.tabs.remove(tabId).catch(() => undefined);
      return { result: { ok: true, detail: `Closed tab ${tabId}.` }, controller };
    }

    default:
      return { result: { ok: false, detail: `Unknown tool ${name}.` }, controller };
  }
}
