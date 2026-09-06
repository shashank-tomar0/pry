import type {
  ActionResult,
  AgentAction,
  ContentRequest,
  PageSnapshot,
} from "../shared/types";
import { PAGE_ACTIONS } from "./tools";

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

function normaliseUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[\w-]+(\.[\w-]+)+/.test(raw)) return `https://${raw}`;
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
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
      const url = normaliseUrl(String(input.url ?? ""));
      await chrome.tabs.update(controller.tabId, { url });
      await controller.waitForLoad();
      return { result: { ok: true, detail: `Navigated to ${url}.` }, controller };
    }

    case "go_back": {
      await chrome.tabs.goBack(controller.tabId).catch(() => undefined);
      await controller.waitForLoad();
      const tab = await chrome.tabs.get(controller.tabId);
      return { result: { ok: true, detail: `Went back. Now on ${tab.url}.` }, controller };
    }

    case "open_tab": {
      const url = normaliseUrl(String(input.url ?? ""));
      const tab = await chrome.tabs.create({ url, active: true });
      const next = new TabController(tab.id!);
      await next.waitForLoad();
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
