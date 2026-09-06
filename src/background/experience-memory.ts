/**
 * Experience Memory
 *
 * Stores structured data from every agent run so the reflection engine
 * can learn from successes and failures. The memory grows over time
 * and powers the self-improvement loop.
 *
 * Storage: chrome.storage.local (persists across sessions)
 * Key: "pry-experience-memory"
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PIIExperience {
  /** Type of PII detected (e.g., "credential", "id_number", "face"). */
  kind: string;
  /** Detection method that found it ("regex", "dom", "face_detector", "learned_rule"). */
  method: string;
  /** Whether it was a true positive or false positive. */
  outcome: "true_positive" | "false_positive" | "missed";
  /** Confidence score from the detector. */
  confidence: number;
}

export interface ActionExperience {
  /** Tool name (click, type, navigate, etc.). */
  tool: string;
  /** Whether the action succeeded. */
  success: boolean;
  /** Latency in ms. */
  latencyMs: number;
  /** Whether this was deterministic or LLM-planned. */
  strategy: "deterministic" | "llm";
  /** Error message if failed. */
  error?: string;
}

export interface SiteExperience {
  /** Domain of the site visited. */
  domain: string;
  /** Page type classification (inferred from content). */
  pageType: string;
  /** PII types commonly found on this site. */
  commonPII: string[];
  /** Whether the deterministic planner worked for this site. */
  deterministicWorks: boolean;
  /** Number of times this site has been visited. */
  visitCount: number;
}

export interface RunExperience {
  /** Unique run ID. */
  id: string;
  /** Timestamp. */
  timestamp: number;
  /** The task description. */
  task: string;
  /** Domain where the task was executed. */
  domain: string;
  /** Page type (banking, email, social, form, e-commerce, etc.). */
  pageType: string;
  /** PII detected during this run. */
  piiDetections: PIIExperience[];
  /** Actions taken during this run. */
  actions: ActionExperience[];
  /** Whether the task completed successfully. */
  taskSuccess: boolean;
  /** Total duration in ms. */
  durationMs: number;
  /** Total PII items redacted. */
  piiRedacted: number;
  /** Total tokens used (estimated from message lengths). */
  estimatedTokens: number;
  /** How many learned rules were applied during this run (FP suppression, routing). */
  rulesApplied?: number;
  /** Bytes sent to a remote planner during this run (0 for local providers). */
  egressBytes?: number;
  /** Whether re-OCR verification was run and passed. */
  reocrVerified?: boolean;
  /** Re-OCR results: PII found in redacted image. */
  reocrLeakedPII?: string[];
  /** `kind:method` keys of learned rules that FIRED (suppressed a detection)
   * during this run — reflection confirms the matching rules, so repeated
   * use strengthens them (confidence grows, never stays inert). */
  rulesFired?: string[];
  /** Learned rules generated from this run. */
  rulesGenerated: string[];
  /** User corrections (if any). */
  userCorrections: string[];
}

export interface MemoryStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  totalPIIDetected: number;
  totalPIIRedacted: number;
  totalFalsePositives: number;
  totalMissedPII: number;
  averageSuccessRate: number;
  sitesVisited: number;
  rulesLearned: number;
  /** Improvement trend: success rate over last 5 runs vs first 5 runs. */
  improvementDelta: number;
  /** User-flagged false-positive corrections (measured ground truth). */
  totalUserCorrections: number;
}

// ─── Storage ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "pry-experience-memory";
const MAX_EXPERIENCES = 200;

async function getExperiences(): Promise<RunExperience[]> {
  const { [STORAGE_KEY]: experiences } = await chrome.storage.local.get(STORAGE_KEY);
  return experiences ?? [];
}

async function saveExperiences(experiences: RunExperience[]): Promise<void> {
  // Trim to max size.
  if (experiences.length > MAX_EXPERIENCES) {
    experiences = experiences.slice(0, MAX_EXPERIENCES);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: experiences });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a completed run experience.
 */
export async function recordExperience(experience: RunExperience): Promise<void> {
  const experiences = await getExperiences();
  experiences.unshift(experience);
  await saveExperiences(experiences);
}

/**
 * Get all stored experiences.
 */
export async function getAllExperiences(): Promise<RunExperience[]> {
  return getExperiences();
}

/**
 * Get experiences for a specific domain.
 */
export async function getExperiencesForDomain(domain: string): Promise<RunExperience[]> {
  const experiences = await getExperiences();
  return experiences.filter((e) => e.domain === domain);
}

/**
 * Get experiences for a specific page type.
 */
export async function getExperiencesForPageType(pageType: string): Promise<RunExperience[]> {
  const experiences = await getExperiences();
  return experiences.filter((e) => e.pageType === pageType);
}

/**
 * Get the most recent N experiences.
 */
export async function getRecentExperiences(n: number): Promise<RunExperience[]> {
  const experiences = await getExperiences();
  return experiences.slice(0, n);
}

/**
 * Compute aggregate memory statistics.
 */
export async function getMemoryStats(): Promise<MemoryStats> {
  const experiences = await getExperiences();

  if (experiences.length === 0) {
    return {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      totalPIIDetected: 0,
      totalPIIRedacted: 0,
      totalFalsePositives: 0,
      totalMissedPII: 0,
      averageSuccessRate: 0,
      sitesVisited: 0,
      rulesLearned: 0,
      improvementDelta: 0,
      totalUserCorrections: 0,
    };
  }

  const totalRuns = experiences.length;
  const successfulRuns = experiences.filter((e) => e.taskSuccess).length;
  const failedRuns = totalRuns - successfulRuns;

  let totalPIIDetected = 0;
  let totalPIIRedacted = 0;
  let totalFalsePositives = 0;
  let totalMissedPII = 0;
  let totalRulesLearned = 0;
  let totalUserCorrections = 0;

  const domains = new Set<string>();

  for (const exp of experiences) {
    domains.add(exp.domain);
    totalRulesLearned += exp.rulesGenerated.length;
    totalUserCorrections += exp.userCorrections?.length ?? 0;

    for (const pii of exp.piiDetections) {
      totalPIIDetected++;
      if (pii.outcome === "true_positive") totalPIIRedacted++;
      if (pii.outcome === "false_positive") totalFalsePositives++;
      if (pii.outcome === "missed") totalMissedPII++;
    }
  }

  // Improvement delta: success rate of the most recent runs vs the runs right
  // before them. Experiences are stored newest-first. With >= 4 runs we split
  // into halves (min 2 per window) so the trend is visible long before the
  // old 10-run threshold; action-level reliability adds signal within a run.
  let improvementDelta = 0;
  if (totalRuns >= 4) {
    const win = Math.min(3, Math.floor(totalRuns / 2));
    const recent = experiences.slice(0, win);
    const previous = experiences.slice(win, win * 2);
    if (recent.length > 0 && previous.length > 0) {
      const recentWin = recent.reduce(
        (acc, e) => acc + (e.taskSuccess ? 1 : 0) + actionSuccessRate(e) * 0.5,
        0,
      ) / recent.length;
      const prevWin = previous.reduce(
        (acc, e) => acc + (e.taskSuccess ? 1 : 0) + actionSuccessRate(e) * 0.5,
        0,
      ) / previous.length;
      // Normalise the action component so the combined score stays in 0-1.
      improvementDelta = (recentWin - prevWin) / 1.5;
    }
  }

  return {
    totalRuns,
    successfulRuns,
    failedRuns,
    totalPIIDetected,
    totalPIIRedacted,
    totalFalsePositives,
    totalMissedPII,
    averageSuccessRate: successfulRuns / totalRuns,
    sitesVisited: domains.size,
    rulesLearned: totalRulesLearned,
    improvementDelta,
    totalUserCorrections,
  };
}

/**
 * A user-flagged correction on a completed run — the human is ground truth.
 *
 * Flips the run's first matching true-positive detection to a false positive
 * (or records one when nothing matched), and appends the correction to the
 * experience. Reflection re-runs against the corrected experience so a real
 * false-positive rule is generated immediately and later runs suppress it.
 *
 * Returns the corrected experience, or null when no experience matches.
 */
export async function recordUserCorrection(correction: {
  experienceId?: string;
  kind: string;
  label: string;
  correction: "false_positive";
}): Promise<RunExperience | null> {
  const experiences = await getExperiences();
  const target = correction.experienceId
    ? experiences.find((e) => e.id === correction.experienceId)
    : experiences[0];
  if (!target) return null;

  const hit = target.piiDetections.find(
    (p) => p.kind === correction.kind && p.outcome === "true_positive",
  );
  if (hit) {
    // Keep the original method so reflection targets the right detector and
    // the suppression key (`kind:method`) matches what the agent consults.
    hit.outcome = "false_positive";
  } else {
    target.piiDetections.push({
      kind: correction.kind,
      method: "user",
      outcome: "false_positive",
      confidence: 0.9,
    });
  }

  target.userCorrections = target.userCorrections ?? [];
  target.userCorrections.push(
    `user:${correction.correction}:${correction.kind}:${correction.label}`,
  );

  await saveExperiences(experiences);
  return target;
}

/**
 * Extract domain from a URL.
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

/**
 * Classify page type from URL and content heuristics.
 *
 * Uses scoring rather than first-match: bare words like "account", "payment"
 * and "balance" appear on nearly every page (Gmail inbox previews, settings
 * pages), so a single occurrence must never classify a page as banking. Email
 * is resolved by URL first — a mail client is unambiguous regardless of what
 * its inbox previews contain.
 */
export function classifyPageType(url: string, title: string, text: string): string {
  const s = `${url} ${title} ${text}`.toLowerCase();

  // Email: mail-client URLs are unambiguous — an inbox preview mentioning
  // "balance" or "payment" must not reclassify the client as banking.
  if (/mail\.google\.com|outlook\.(com|live|office365)|proton(\.me|mail)|yahoo\.com\/mail|icloud\.com\/mail|zoho\.com\/mail|mail\.yahoo\.com/.test(s)) return "email";
  if (/(^|[\s./])(inbox|compose|sent mail|drafts|spam)([\s/.]|$)/.test(s) && /@/.test(s)) return "email";

  // Banking: strong terms score 3, medium terms 2, weak terms 1; a page must
  // reach 3 to be banking. "balance" or "payment" alone never classifies.
  // aadhaar/otp are deliberately excluded — they belong to government/auth
  // contexts, not banking.
  const banking =
    (s.match(/\b(upi|neft|rtgs|net\s?banking|cvv|iban)\b/g)?.length ?? 0) * 3 +
    (s.match(/\b(credit\s?card|debit\s?card|account\s?(number|no\.?)|bank\s?account|savings\s?account|transaction\s?(history|details)|netbanking)\b/g)?.length ?? 0) * 2 +
    (s.match(/\b(bank|banking|balance|statement|transfer|payment|finance|account)\b/g)?.length ?? 0);
  if (banking >= 3) return "banking";

  // Auth: strong login vocabulary only — "password" appears in every settings
  // page; "credential" in every security blurb.
  if (/(login|signin|sign-in|log in|log-in|2fa|two-factor|otp|forgot password|reset password|change password)/.test(s)) return "auth";

  if (/\b(shop|cart|checkout|product|buy now|amazon|flipkart|myntra|ajio)\b/.test(s)) return "ecommerce";
  if (/\b(form|survey|quiz)\b/.test(s)) return "form";
  if (/\b(feed|timeline|profile|tweet|post|facebook|twitter|instagram|linkedin|reddit)\b/.test(s)) return "social";
  if (/\b(search|query|results?|bing|duckduckgo)\b/.test(s)) return "search";
  if (/\b(doc|sheet|slide|notion|confluence|wiki|docs\.google)\.?\b/.test(s)) return "productivity";
  if (/\b(gov\.in|aadhaar|pan card|passport|tax filing|itr|gst)\b/.test(s)) return "government";

  return "other";
}

/** Fraction of actions that succeeded within one run (0-1; 1 when no actions). */
function actionSuccessRate(experience: RunExperience): number {
  if (experience.actions.length === 0) return 1;
  return experience.actions.filter((a) => a.success).length / experience.actions.length;
}

/**
 * Clear all experience memory.
 */
export async function clearExperienceMemory(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
