/**
 * Lessons Store — semantic reflection output.
 *
 * The template reflection engine (reflection.ts) mints structured rules; this
 * store keeps free-form, model-generated lessons ("the compose button is a
 * pencil icon on this site", "verify the URL has a TLD before navigating").
 * Relevant lessons for the current domain + page type are injected into the
 * planner prompt so the model conditions on what past runs learned.
 *
 * Storage: chrome.storage.local, key "pry-lessons". Lessons are capped per
 * domain and in total; matching is a pure function so the harness can test it.
 */

export interface Lesson {
  id: string;
  domain: string;
  pageType: string;
  /** One actionable sentence, model-written, length-capped. */
  text: string;
  createdAt: number;
}

const STORAGE_KEY = "pry-lessons";
const MAX_PER_DOMAIN = 5;
const MAX_TOTAL = 50;
const LESSON_TEXT_MAX = 300;

async function getStored(): Promise<Lesson[]> {
  const { [STORAGE_KEY]: lessons } = await chrome.storage.local.get(STORAGE_KEY);
  return lessons ?? [];
}

async function saveStored(lessons: Lesson[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: lessons.slice(0, MAX_TOTAL) });
}

export async function getLessons(): Promise<Lesson[]> {
  return getStored();
}

/** Store new lessons for a domain+page type, deduped and capped. Returns the number added. */
export async function recordLessons(
  domain: string,
  pageType: string,
  texts: string[],
): Promise<number> {
  const lessons = await getStored();
  let added = 0;
  for (const raw of texts) {
    const text = raw.replace(/^[-*•\s]+/, "").trim().slice(0, LESSON_TEXT_MAX);
    if (!text) continue;
    if (lessons.some((l) => l.domain === domain && l.text === text)) continue;
    lessons.unshift({
      id: `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      domain,
      pageType,
      text,
      createdAt: Date.now(),
    });
    added++;
  }
  // Cap per domain, newest first.
  const perDomain = new Map<string, number>();
  const capped = lessons.filter((l) => {
    const n = perDomain.get(l.domain) ?? 0;
    if (n >= MAX_PER_DOMAIN) return false;
    perDomain.set(l.domain, n + 1);
    return true;
  });
  await saveStored(capped);
  return added;
}

/** Pure: pick the lessons relevant to this domain+page type, newest first. */
export function matchLessons(
  lessons: Lesson[],
  domain: string,
  pageType: string,
  limit = 3,
): Lesson[] {
  return lessons
    .filter((l) => l.domain === domain && (l.pageType === pageType || l.pageType === ""))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export async function clearLessons(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}