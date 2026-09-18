/**
 * Deterministic Planner
 *
 * Before calling the LLM, check if the action can be resolved
 * deterministically. This saves tokens, reduces latency, and avoids
 * hallucination for simple tasks.
 *
 * The architecture diagram says: "deterministic planner can do it?
 * form fill by label match, click by text match"
 */

import type { PageSnapshot, AgentAction } from "../shared/types";

interface DeterministicResult {
  /** Whether the action was resolved deterministically. */
  resolved: boolean;
  /** The action to execute (with element_id resolved). */
  action?: AgentAction;
  /** Human-readable explanation of what was resolved. */
  explanation?: string;
}

/**
 * Canonical host for a bare, well-known site name. "gmail" must become
 * gmail.com (not the invalid https://gmail), "notion" → notion.so, and so on.
 * Exporting this lets the executor apply the same correction to model-written
 * URLs like https://gmail.
 */
export const KNOWN_DOMAIN_HOSTS: Record<string, string> = {
  youtube: "youtube.com",
  google: "google.com",
  github: "github.com",
  twitter: "twitter.com",
  reddit: "reddit.com",
  facebook: "facebook.com",
  instagram: "instagram.com",
  linkedin: "linkedin.com",
  amazon: "amazon.com",
  netflix: "netflix.com",
  spotify: "spotify.com",
  wikipedia: "wikipedia.org",
  stackoverflow: "stackoverflow.com",
  gmail: "gmail.com",
  outlook: "outlook.com",
  yahoo: "yahoo.com",
  bing: "bing.com",
  discord: "discord.com",
  slack: "slack.com",
  notion: "notion.so",
  figma: "figma.com",
  linear: "linear.app",
  vercel: "vercel.com",
  netlify: "netlify.com",
};

/** Resolve a bare site name to its canonical host, or null if it is not a known name. */
export function canonicalHost(raw: string): string | null {
  const bare = raw.trim().replace(/^www\./i, "").toLowerCase();
  if (!/^[\w-]+$/.test(bare)) return null; // already contains a dot (real host) or junk
  return KNOWN_DOMAIN_HOSTS[bare] ?? null;
}

/**
 * Try to resolve a task description into a concrete action without
 * using the LLM. Returns null if the task is too complex.
 *
 * Supports:
 * - "click <button text>" → find and click matching element
 * - "fill <field> with <value>" → find input near label and type
 * - "scroll down/up" → scroll action
 * - "go to <url>" → navigate action
 * - "press <key>" → key action
 */
export function tryDeterministic(
  task: string,
  snapshot: PageSnapshot | null,
): DeterministicResult {
  if (!snapshot) return { resolved: false };

  const lower = task.toLowerCase().trim();

  // ── Click by text match ──
  const clickMatch = lower.match(
    /^(?:click|tap|press|hit|select)\s+(?:on\s+|the\s+)?["']?(.+?)["']?\s*$/i,
  );
  if (clickMatch) {
    const needle = clickMatch[1].toLowerCase().trim();
    if (needle) {
      const el = snapshot.elements.find((e) => {
        const name = (e.name || "").toLowerCase().trim();
        const role = (e.role || "").toLowerCase().trim();
        if (name) {
          if (name === needle || name.includes(needle)) return true;
          if (needle.length >= 3 && needle.includes(name)) return true;
        }
        if (role && (role === needle || (needle.length >= 4 && needle.includes(role)))) {
          return true;
        }
        return false;
      });
      if (el) {
        return {
          resolved: true,
          action: { name: "click", input: { element_id: el.id, reason: `Deterministic: matched "${el.name}"` } },
          explanation: `Found element [${el.id}] "${el.name}" matching "${clickMatch[1]}"`,
        };
      }
    }
  }

  // ── Fill field with value ──
  const fillMatch = lower.match(
    /^(?:fill|type|enter|input|write)\s+(.+?)\s+(?:with|into|in|:)\s+(.+)$/i,
  );
  if (fillMatch) {
    const fieldDesc = fillMatch[1].toLowerCase().trim();
    const value = fillMatch[2].trim();
    if (fieldDesc) {
      const el = snapshot.elements.find((e) => {
        const name = (e.name || "").toLowerCase().trim();
        const role = (e.role || "").toLowerCase().trim();
        if (!name) return false;
        const matchesName = name === fieldDesc || name.includes(fieldDesc) || (fieldDesc.length >= 3 && fieldDesc.includes(name));
        return matchesName && (role === "textbox" || role === "password" || role === "combobox");
      });
      if (el) {
        return {
          resolved: true,
          action: { name: "type", input: { element_id: el.id, text: value, reason: `Deterministic: fill "${el.name}" with "${value.slice(0, 30)}"` } },
          explanation: `Found field [${el.id}] "${el.name}" matching "${fillMatch[1]}"`,
        };
      }
    }
  }

  // ── Scroll ──
  const scrollMatch = lower.match(/^scroll\s+(down|up|top|bottom)$/i);
  if (scrollMatch) {
    const dir = scrollMatch[1].toLowerCase();
    if (dir === "top") {
      return {
        resolved: true,
        action: { name: "scroll", input: { direction: "up", amount: snapshot.scroll.y } },
        explanation: "Scrolled to top of page",
      };
    }
    if (dir === "bottom") {
      return {
        resolved: true,
        action: { name: "scroll", input: { direction: "down", amount: snapshot.scroll.maxY - snapshot.scroll.y } },
        explanation: "Scrolled to bottom of page",
      };
    }
    return {
      resolved: true,
      action: { name: "scroll", input: { direction: dir } },
      explanation: `Scrolled ${dir}`,
    };
  }

  // ── Navigate ──
  // Only match simple "go to X" where X is a URL or domain, NOT a multi-step
  // task like "open youtube and search for...". The captured text must look
  // like a real URL/domain with no additional instructions.
  const navMatch = lower.match(
    /^(?:go to|open|navigate to|visit)\s+(.+)$/i,
  );
  if (navMatch) {
    const raw = navMatch[1].trim();

    // Reject if the URL contains multi-step connectors — this is a complex
    // task that the LLM should handle, not the deterministic planner.
    const hasMultiStep = /\b(and|then|after|before|next|search|find|click|type|fill|read|play|watch|submit|send|post)\b/.test(raw);
    if (hasMultiStep) return { resolved: false };

    // Validate: must look like a URL or domain name.
    const isUrl = /^(https?:\/\/|www\.|[\w-]+\.[\w.-]+(?:\/\S*)?$)/.test(raw);
    const canonical = canonicalHost(raw);
    if (!isUrl && !canonical) return { resolved: false };

    // Normalize: add https:// if no protocol. Bare known names get their
    // canonical TLD appended (gmail → https://gmail.com, never https://gmail).
    // Protocol-carrying URLs with a bare host (https://gmail) get the same
    // fix — the planner must not emit invalid URLs even before the executor
    // gets a chance to correct them.
    let url: string;
    if (/^https?:\/\//.test(raw)) {
      try {
        const u = new URL(raw);
        const host = u.hostname.toLowerCase();
        const isBare = !host.includes(".") && host !== "localhost";
        const fix = isBare ? canonicalHost(host) : null;
        if (fix) u.hostname = fix;
        url = u.toString();
      } catch {
        url = raw;
      }
    } else if (canonical) {
      // canonicalHost strips a leading www., so "www.gmail" also lands here.
      url = `https://${canonical}`;
    } else if (/^www\./.test(raw)) {
      url = `https://${raw}`;
    } else {
      url = `https://${raw}`;
    }

    return {
      resolved: true,
      action: { name: "navigate", input: { url, reason: `Deterministic: navigate to "${url.slice(0, 50)}"` } },
      explanation: `Navigate to ${url.slice(0, 50)}`,
    };
  }

  // ── Press key ──
  const keyMatch = lower.match(
    /^(?:press|hit)\s+(enter|escape|tab|space|backspace|delete|arrowdown|arrowup|arrowleft|arrowright)$/i,
  );
  if (keyMatch) {
    return {
      resolved: true,
      action: { name: "key", input: { key: keyMatch[1] } },
      explanation: `Press ${keyMatch[1]}`,
    };
  }

  return { resolved: false };
}

// ─── A task that is nothing but a navigation ────────────────────────────────

/**
 * Site words the user's own phrasing uses which are not the site's name.
 *
 * Kept separate from `KNOWN_DOMAIN_HOSTS` because the two answer different
 * questions: that table says "what host does this bare name mean" (for BUILDING
 * a URL), this one says "what hosts would satisfy this word" (for CHECKING one).
 * "yt" and "mail" are how people speak, not hostnames, so they only belong
 * here.
 */
const SITE_ALIASES: Record<string, string[]> = {
  yt: ["youtube.com"],
  ytube: ["youtube.com"],
  // Both spellings reach the same place in practice — `gmail` resolves to
  // gmail.com and immediately lands on mail.google.com — so both hosts satisfy
  // either word. Listing only the canonical one would leave the check unable to
  // recognise the very run it was written for.
  gmail: ["mail.google.com", "gmail.com"],
  mail: ["mail.google.com", "gmail.com"],
  gh: ["github.com"],
  fb: ["facebook.com"],
  ig: ["instagram.com"],
};

export interface BareNavigationGoal {
  /** The site token, as the user wrote it. */
  site: string;
  /** Hosts that satisfy it — lowercase, `www.` stripped. */
  hosts: string[];
}

/** Lowercase and drop a leading `www.`, which is the only form compared. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

/**
 * A task whose ENTIRE content is one navigation: `open yt`, `go to gmail`.
 *
 * WHY THIS EXISTS
 *
 * A live run was asked to "open yt" and then clicked a video, read the page
 * several more times, and answered with a paragraph about its own tooling —
 * because nothing in the loop knew the task had been satisfied by the
 * navigation itself. "Open <site>" has an observable, checkable success state:
 * is the tab on that site? Once it is, every further step is the model inventing
 * work, and on a slow reasoning model each invented step costs a minute.
 *
 * WHAT MAKES IT SAFE TO ACT ON
 *
 * The shape is deliberately tiny — a navigation verb followed by a SINGLE token
 * and nothing else. That is what separates this from the tasks that must keep
 * going:
 *
 *   "open yt"                                       → bare
 *   "open gmail"                                    → bare
 *   "open youtube.com"                              → bare
 *   "open yt and search for iit"                    → not bare (a second step)
 *   "open mail and open the first email i received" → not bare
 *   "open the first video"                          → not bare (a step, not a site)
 *
 * and only names that RESOLVE may be treated as satisfiable at all — an
 * unresolvable token ("open settings") returns null, so a run can never stop on
 * a check it is unable to perform.
 */
export function bareNavigationGoal(task: string): BareNavigationGoal | null {
  const trimmed = String(task ?? "").trim().replace(/[.!?]+$/, "");
  const match = trimmed.match(/^(?:open|go to|goto|visit|navigate to|launch|show me)\s+(\S+)$/i);
  if (!match) return null;
  const site = normalizeHost(match[1]);
  if (site.length === 0) return null;

  // A hostname the user typed is its own goal — there is nothing to resolve.
  if (/^[\w-]+(?:\.[\w-]+)+$/.test(site)) return { site, hosts: [site] };

  const canonical = canonicalHost(site);
  const aliases = SITE_ALIASES[site];
  if (!canonical && !aliases) return null;
  return { site, hosts: [...new Set([...(canonical ? [canonical] : []), ...(aliases ?? [])])] };
}

/**
 * Is `url` on a host that satisfies this goal?
 *
 * EXACT host match, deliberately — a subdomain does NOT count. `gist.github.com`
 * is not `github.com`, and the cost of the two errors is not symmetric: a false
 * positive stops the run on a page that is not the one the user asked for, while
 * a false negative simply continues the run the way it worked before. So the
 * check only ever says yes when the tab is on the site itself.
 */
export function hostSatisfiesBareGoal(goal: BareNavigationGoal, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return goal.hosts.includes(normalizeHost(host));
}
