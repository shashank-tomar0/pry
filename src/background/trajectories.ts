/**
 * Successful-Trajectory Store — experience replay for prompting.
 *
 * Research (Sarukkai et al., NeurIPS 2025) shows that prompting with a few
 * past successful trajectories lifts task success substantially. When a run
 * succeeds we save a compact, sanitized trace (tokenized task, tool sequence,
 * redacted answer) keyed by domain; the next same-domain run gets 1–2 as
 * few-shot examples.
 *
 * Storage: chrome.storage.local, key "pry-trajectories".
 */

export interface Trajectory {
  id: string;
  domain: string;
  pageType: string;
  /** Tokenized task — never raw PII. */
  task: string;
  /** Compact action sequence, e.g. "navigate → type#3 → click#12". */
  steps: string;
  /** Redacted final-answer snippet. */
  answer: string;
  createdAt: number;
}

const STORAGE_KEY = "pry-trajectories";
const MAX_PER_DOMAIN = 5;
const MAX_TOTAL = 30;
const ANSWER_MAX = 200;
const TASK_MAX = 200;

export async function getTrajectories(): Promise<Trajectory[]> {
  const { [STORAGE_KEY]: trajectories } = await chrome.storage.local.get(STORAGE_KEY);
  return trajectories ?? [];
}

export async function recordTrajectory(
  input: Omit<Trajectory, "id" | "createdAt">,
): Promise<void> {
  const trajectories = await getTrajectories();
  const entry: Trajectory = {
    ...input,
    task: input.task.slice(0, TASK_MAX),
    answer: input.answer.slice(0, ANSWER_MAX),
    createdAt: Date.now(),
    id: `traj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  };
  // Replace an older identical trace for the same domain+task.
  const withoutDup = trajectories.filter(
    (t) => !(t.domain === entry.domain && t.task === entry.task),
  );
  withoutDup.unshift(entry);
  // Cap per domain, newest first.
  const perDomain = new Map<string, number>();
  const capped = withoutDup.filter((t) => {
    const n = perDomain.get(t.domain) ?? 0;
    if (n >= MAX_PER_DOMAIN) return false;
    perDomain.set(t.domain, n + 1);
    return true;
  });
  await chrome.storage.local.set({ [STORAGE_KEY]: capped.slice(0, MAX_TOTAL) });
}

/** Pure: pick the most relevant past successes for this domain+page type. */
export function matchTrajectories(
  trajectories: Trajectory[],
  domain: string,
  pageType: string,
  limit = 2,
): Trajectory[] {
  const sorted = [...trajectories].sort((a, b) => b.createdAt - a.createdAt);
  const exact = sorted.filter((t) => t.domain === domain && t.pageType === pageType);
  const domainOnly = sorted.filter((t) => t.domain === domain && t.pageType !== pageType);
  return [...exact, ...domainOnly].slice(0, limit);
}

export async function clearTrajectories(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}