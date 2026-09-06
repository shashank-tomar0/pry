/**
 * Reflection Engine
 *
 * Analyzes completed agent runs to identify:
 * - False positives (PII flagged that wasn't actually PII)
 * - False negatives (PII missed that should have been caught)
 * - Strategy optimization (when to use deterministic vs LLM)
 * - Site-specific patterns
 *
 * Generates concrete, actionable rules that get stored and applied
 * on subsequent runs. This is the core of the self-improvement loop.
 */

import type { RunExperience, PIIExperience } from "./experience-memory.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LearnedRule {
  /** Unique rule ID. */
  id: string;
  /** Rule category. */
  category: "pii_detection" | "strategy" | "site_pattern" | "safety" | "redaction";
  /** The rule in natural language. */
  description: string;
  /** The actual pattern/rule to check. */
  pattern: {
    /** Domain this rule applies to (empty = all domains). */
    domain?: string;
    /** Page type this rule applies to (empty = all page types). */
    pageType?: string;
    /** The specific condition. */
    condition: string;
    /** The action to take. */
    action: string;
  };
  /** Confidence in this rule (0-1). Increases with each confirmation. */
  confidence: number;
  /** Number of times this rule has been confirmed. */
  confirmedCount: number;
  /** Timestamp when this rule was created. */
  createdAt: number;
  /** Timestamp when this rule was last confirmed. */
  lastConfirmedAt: number;
}

export interface ReflectionResult {
  /** New rules generated from this analysis. */
  newRules: LearnedRule[];
  /** Existing rules that were confirmed. */
  confirmedRules: string[];
  /** Existing rules that were contradicted. */
  contradictedRules: string[];
  /** Summary of what was learned. */
  summary: string;
  /** Key metrics to show in the dashboard. */
  metrics: {
    falsePositives: number;
    falseNegatives: number;
    strategyOptimizations: number;
    sitePatternsFound: number;
  };
}

// ─── Rule Generation ────────────────────────────────────────────────────────

/**
 * Analyze a completed run and generate improvement rules.
 *
 * `priorVisitCount` is how many times this domain appeared in stored
 * experiences BEFORE this run — site-pattern rules require at least one prior
 * visit so a single accidental visit can never brand a domain.
 */
export function reflectOnRun(
  experience: RunExperience,
  existingRules: LearnedRule[],
  priorVisitCount: number = 0,
): ReflectionResult {
  const newRules: LearnedRule[] = [];
  const confirmedRules: string[] = [];
  const contradictedRules: string[] = [];

  let falsePositives = 0;
  let falseNegatives = 0;
  let strategyOptimizations = 0;
  let sitePatternsFound = 0;

  // ── 1. Analyze PII Detection Accuracy ──────────────────────────────────

  for (const pii of experience.piiDetections) {
    if (pii.outcome === "false_positive") {
      falsePositives++;

      // Generate a rule to avoid this false positive on similar pages.
      const rule = generateFalsePositiveRule(experience, pii, existingRules);
      if (rule) {
        newRules.push(rule);
      }
    }

    if (pii.outcome === "missed") {
      falseNegatives++;

      // Generate a rule to catch this PII type on similar pages.
      const rule = generateMissedPIIRule(experience, pii, existingRules);
      if (rule) {
        newRules.push(rule);
      }
    }

    if (pii.outcome === "true_positive" && pii.method === "learned_rule") {
      // A previously learned rule worked! Confirm it.
      const matchingRule = existingRules.find(
        (r) => r.category === "pii_detection" && r.pattern.condition.includes(pii.kind),
      );
      if (matchingRule) {
        confirmedRules.push(matchingRule.id);
      }
    }
  }

  // ── 1b. Confirm rules that actually FIRED this run ──────────────────────
  //
  // The agent records `rulesFired` (kind:method keys) for every learned-rule
  // suppression during the run. A rule that suppressed a detection and was
  // not corrected by the user is evidence the rule works — confirm it so
  // confidence grows with use instead of staying frozen at creation.
  for (const key of experience.rulesFired ?? []) {
    const matchingRule = existingRules.find(
      (r) => r.category === "pii_detection" && r.pattern.condition === `false_positive:${key}`,
    );
    if (matchingRule && !confirmedRules.includes(matchingRule.id)) {
      confirmedRules.push(matchingRule.id);
    }
  }

  // ── 2. Analyze Strategy Effectiveness ───────────────────────────────────

  // If deterministic planner succeeded, note that for this page type.
  const deterministicActions = experience.actions.filter((a) => a.strategy === "deterministic");
  const llmActions = experience.actions.filter((a) => a.strategy === "llm");

  if (deterministicActions.length > 0 && experience.taskSuccess) {
    // Deterministic worked for this page type. Create/confirm a rule.
    const rule = generateStrategyRule(experience, "deterministic", existingRules);
    if (rule) {
      newRules.push(rule);
      strategyOptimizations++;
    }
  }

  // If LLM was needed and deterministic would have been cheaper.
  if (llmActions.length > 0 && deterministicActions.length === 0 && experience.taskSuccess) {
    // Check if the task was simple enough for deterministic.
    const isSimpleTask = /^(click|fill|scroll|navigate|press)/i.test(experience.task);
    if (isSimpleTask) {
      const rule = generateStrategyRule(experience, "deterministic", existingRules);
      if (rule) {
        newRules.push(rule);
        strategyOptimizations++;
      }
    }
  }

  // If deterministic failed and LLM saved the day.
  if (!experience.taskSuccess && deterministicActions.length > 0) {
    const rule = generateStrategyRule(experience, "llm", existingRules);
    if (rule) {
      newRules.push(rule);
      strategyOptimizations++;
    }
  }

  // ── 3. Analyze Site-Specific Patterns ───────────────────────────────────

  // Only after a domain has been visited more than once does a site pattern
  // carry evidence — a single run (e.g. one help page) must not brand a domain.
  if (experience.domain && priorVisitCount >= 1 && experience.piiDetections.length >= 3) {
    const piiKinds = [...new Set(experience.piiDetections.map((p) => p.kind))];
    const rule = generateSitePatternRule(experience, piiKinds, existingRules);
    if (rule) {
      newRules.push(rule);
      sitePatternsFound++;
    }
  }

  // ── 4. Check Re-OCR Verification ───────────────────────────────────────

  if (experience.reocrVerified && experience.reocrLeakedPII && experience.reocrLeakedPII.length > 0) {
    // Re-OCR found PII that wasn't redacted. Generate a redaction rule.
    for (const leaked of experience.reocrLeakedPII) {
      const rule: LearnedRule = {
        id: `reocr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        category: "redaction",
        description: `Re-OCR detected leaked PII "${leaked.slice(0, 20)}..." in redacted image. Redaction needs strengthening.`,
        pattern: {
          domain: experience.domain,
          pageType: experience.pageType,
          condition: `reocr_leak:${leaked.slice(0, 30)}`,
          action: "strengthen_redaction",
        },
        confidence: 0.7,
        confirmedCount: 0,
        createdAt: Date.now(),
        lastConfirmedAt: Date.now(),
      };
      newRules.push(rule);
    }
  }

  // ── 5. Build Summary ───────────────────────────────────────────────────

  const summary = buildSummary(experience, {
    falsePositives,
    falseNegatives,
    strategyOptimizations,
    sitePatternsFound,
    newRulesCount: newRules.length,
  });

  return {
    newRules,
    confirmedRules,
    contradictedRules,
    summary,
    metrics: {
      falsePositives,
      falseNegatives,
      strategyOptimizations,
      sitePatternsFound,
    },
  };
}

// ─── Rule Generators ────────────────────────────────────────────────────────

function generateFalsePositiveRule(
  experience: RunExperience,
  pii: PIIExperience,
  existingRules: LearnedRule[],
): LearnedRule | null {
  // Check if a similar rule already exists.
  const duplicate = existingRules.find(
    (r) =>
      r.category === "pii_detection" &&
      r.pattern.condition.includes(`false_positive:${pii.kind}`) &&
      r.pattern.domain === experience.domain,
  );
  if (duplicate) return null;

  return {
    id: `fp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: "pii_detection",
    description: `False positive: ${pii.kind} detected by ${pii.method} on ${experience.pageType} page is not actually sensitive.`,
    pattern: {
      domain: experience.domain,
      pageType: experience.pageType,
      condition: `false_positive:${pii.kind}:${pii.method}`,
      action: "reduce_confidence",
    },
    confidence: 0.5,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now(),
  };
}

function generateMissedPIIRule(
  experience: RunExperience,
  pii: PIIExperience,
  existingRules: LearnedRule[],
): LearnedRule | null {
  // OCR noise reports generic "pii_text" misses (text OCR couldn't classify);
  // a rule like "add detection for pii_text" is unactionable. Only concrete
  // kinds get rules.
  if (pii.kind === "pii_text" || pii.kind === "face") return null;

  const duplicate = existingRules.find(
    (r) =>
      r.category === "pii_detection" &&
      r.pattern.condition.includes(`missed:${pii.kind}`) &&
      r.pattern.domain === experience.domain,
  );
  if (duplicate) return null;

  return {
    id: `miss-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: "pii_detection",
    description: `Missed PII: ${pii.kind} on ${experience.pageType} page was not detected. Add detection for this pattern.`,
    pattern: {
      domain: experience.domain,
      pageType: experience.pageType,
      condition: `missed:${pii.kind}:${pii.method}`,
      action: "add_detection",
    },
    confidence: 0.5,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now(),
  };
}

function generateStrategyRule(
  experience: RunExperience,
  recommendedStrategy: "deterministic" | "llm",
  existingRules: LearnedRule[],
): LearnedRule | null {
  const duplicate = existingRules.find(
    (r) =>
      r.category === "strategy" &&
      r.pattern.condition === `strategy:${recommendedStrategy}` &&
      r.pattern.pageType === experience.pageType,
  );
  if (duplicate) return null;

  return {
    id: `strat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: "strategy",
    description: `${recommendedStrategy} planner ${recommendedStrategy === "deterministic" ? "works" : "is needed"} for ${experience.pageType} pages.`,
    pattern: {
      pageType: experience.pageType,
      condition: `strategy:${recommendedStrategy}`,
      action: `use_${recommendedStrategy}`,
    },
    confidence: 0.6,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now(),
  };
}

function generateSitePatternRule(
  experience: RunExperience,
  piiKinds: string[],
  existingRules: LearnedRule[],
): LearnedRule | null {
  const duplicate = existingRules.find(
    (r) =>
      r.category === "site_pattern" &&
      r.pattern.domain === experience.domain,
  );
  if (duplicate) return null;

  return {
    id: `site-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: "site_pattern",
    description: `${experience.domain} commonly contains: ${piiKinds.join(", ")}.`,
    pattern: {
      domain: experience.domain,
      condition: `site_pii:${piiKinds.join(",")}`,
      action: "prioritize_detection",
    },
    confidence: 0.6,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now(),
  };
}

// ─── Summary Builder ────────────────────────────────────────────────────────

function buildSummary(
  experience: RunExperience,
  metrics: {
    falsePositives: number;
    falseNegatives: number;
    strategyOptimizations: number;
    sitePatternsFound: number;
    newRulesCount: number;
  },
): string {
  const parts: string[] = [];

  parts.push(`Task ${experience.taskSuccess ? "succeeded" : "failed"} on ${experience.pageType} page.`);

  if (metrics.falsePositives > 0) {
    parts.push(`${metrics.falsePositives} false positive(s) identified.`);
  }
  if (metrics.falseNegatives > 0) {
    parts.push(`${metrics.falseNegatives} missed PII item(s) found.`);
  }
  if (metrics.strategyOptimizations > 0) {
    parts.push(`${metrics.strategyOptimizations} strategy optimization(s) noted.`);
  }
  if (metrics.sitePatternsFound > 0) {
    parts.push(`New site pattern recorded for ${experience.domain}.`);
  }
  if (metrics.newRulesCount > 0) {
    parts.push(`${metrics.newRulesCount} new rule(s) generated.`);
  }

  return parts.join(" ");
}
