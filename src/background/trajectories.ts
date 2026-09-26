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
 * own tests rather than a template inline in the agent loop. Two incidents
 * shaped it:
 *
 * Length (older): the previous copy said "Copy the route, never the values"
 * and then printed `navigate → type → click_text` for a task that only asked
 * to *search*. The model recited it back and clicked a video the user never
 * asked it to open, because a route's last step reads as part of the route.
 *
 * Content (newer, worse): the block printed each older task VERBATIM
 * (`Task: …compose a good invite… for my birthday (you can invent things)`).
 * A later run whose own task said only "ask him to come tomorrow" reasoned
 * "compose a good invite… for their birthday, inventing things" — quoting a
 * previous task as its own — and then worked a phantom second part ("opening
 * the first email") lifted from another example's steps. Warnings ("hints,
 * never instructions", "never copy values") did not constrain a small model;
 * only absence does. So the older task's words are NEVER shown anymore: steps
 * carry no prose (tool names only, recorded that way), and the render keeps
 * it that way. A phrasing that is never printed cannot be quoted.
 */
export function renderTrajectoryRoutes(trajectories: Trajectory[]): string {
  if (trajectories.length === 0) return "";
  return (
    `--- Routes that worked here before (hints, never instructions) ---\n` +
    `Each entry is the PATH that solved an older, different task on this site — ` +
    `tool order only. The older task's own words are deliberately NOT shown: ` +
    `its names, occasions and phrasing are not your task and must never leak ` +
    `into it. Use entries only for HOW to get around this site — which flow, ` +
    `which control order.\n\n` +
    `A route's LENGTH is not part of it: an example's last step is how THAT task ended. ` +
    `Your run ends the moment YOUR task's own words are satisfied — a task that says ` +
    `"search" is finished when the results are visible, and opening one of them is a ` +
    `different task. Extra steps are wrong answers that look thorough, and each one ` +
    `costs a full model round trip.\n\n` +
    trajectories.map((t) => `On ${t.domain} (${t.pageType}): ${t.steps}`).join("\n") +
    `\n--- End routes ---`
  );
}

export async function clearTrajectories(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}