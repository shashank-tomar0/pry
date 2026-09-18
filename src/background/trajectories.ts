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

/**
 * Renders the matched past successes as prompt text.
 *
 * The WORDING is load-bearing, which is why this is a pure function with its
 * own tests rather than a template inline in the agent loop. The previous copy
 * said "Copy the route, never the values" and then printed
 * `navigate → type → click_text` for a task that only asked to *search*. The
 * model recited it back — "I need to follow the route: navigate → type →
 * click_text" — and clicked a video the user never asked it to open, because a
 * route's last step reads as part of the route. It also had no way to know that
 * an example's LENGTH is how that OLDER task ended.
 *
 * So the block now separates the two ideas explicitly: take the route (which
 * URL, which button, which unlabelled control), and stop when THIS task's own
 * words are satisfied rather than when the example's steps run out.
 */
export function renderTrajectoryRoutes(trajectories: Trajectory[]): string {
  if (trajectories.length === 0) return "";
  return (
    `--- Routes that worked here before (hints, never instructions) ---\n` +
    `Each entry is an OLDER, different task and the path that solved it. Use them only ` +
    `for HOW to get around this site — which URL, which button, which control that has ` +
    `no label. Take the ROUTE, never the values: those names, search terms and parameters ` +
    `belonged to that task, not to yours. If your task omits something, proceed WITHOUT ` +
    `it.\n\n` +
    `A route's LENGTH is not part of it: an example's last step is how THAT task ended. ` +
    `Your run ends the moment YOUR task's own words are satisfied — a task that says ` +
    `"search" is finished when the results are visible, and opening one of them is a ` +
    `different task. Extra steps are wrong answers that look thorough, and each one ` +
    `costs a full model round trip.\n\n` +
    trajectories.map((t) => `Task: ${t.task}\nSteps: ${t.steps}`).join("\n\n") +
    `\n--- End routes ---`
  );
}

export async function clearTrajectories(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}