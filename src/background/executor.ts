import type {
  ActionResult,
  AgentAction,
  ContentRequest,
  PageSnapshot,
} from "../shared/types";
import { PAGE_ACTIONS } from "./tools";
import { canonicalHost } from "./deterministic";

/** How long a content-script round trip may take before we treat it as hung. */
const CONTENT_TIMEOUT_MS = 30_000;

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
      const missingScript = /Receiving end does not exist|Could not establish connection|No tab with id/i.test(message);
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

  /** Resolves once the tab has finished loading, or after a timeout. */
  async waitForLoad(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(this.tabId).catch(() => null);
      if (!tab) return;
      if (tab.status === "complete") {
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
    return { result: await controller.act(action), controller };
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
      await chrome.tabs.update(controller.tabId, { url });
      await controller.waitForLoad();
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
      return { result: { ok: true, detail: `Navigated to ${url}.` }, controller };
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
      await next.waitForLoad();
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
        result: { ok: true, detail: `Opened ${url} in new tab ${tab.id}. Agent focus moved there.` },
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
