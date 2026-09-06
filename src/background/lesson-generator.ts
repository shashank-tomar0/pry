/**
 * Lesson Generator — the semantic half of reflection.
 *
 * reflection.ts mints structured template rules; this pass asks the planner
 * itself to explain, in natural language, what went wrong and what the next
 * run should do differently. Lessons are stored (lessons.ts) and injected
 * into future runs for the same domain + page type (Reflexion-style).
 *
 * Runs only on failed runs (or runs with measured false positives), so the
 * extra LLM call is rare. Its request bytes are counted toward the honest
 * egress badge by the caller.
 */

import type { Planner } from "./providers/types";
import type { RunExperience } from "./experience-memory";

const LESSON_SYSTEM =
  "You are the reflection module of a privacy-preserving browser agent. " +
  "You read a transcript of a completed run and write short, actionable " +
  "lessons for the next run on the same site. Be specific and imperative: " +
  "name the exact thing to do or check. Never restate the task, never " +
  "mention raw personal data. Output only the lessons, one per line, " +
  "at most 3, each under 40 words.";

export async function generateLessons(
  planner: Planner,
  experience: RunExperience,
): Promise<string[]> {
  const actions = experience.actions
    .map((a) => `- ${a.tool} ${a.success ? "ok" : `FAILED (${a.cause ?? "unknown"})`}`)
    .join("\n");

  const prompt =
    `Task: ${experience.task.slice(0, 300)}\n` +
    `Site: ${experience.domain} (${experience.pageType})\n` +
    `Outcome: ${experience.taskSuccess ? "success" : "failure"}\n` +
    `Actions:\n${actions}\n\n` +
    `Write up to 3 lessons for the next run on ${experience.domain}.`;

  let text = "";
  const turn = await planner.run({
    system: LESSON_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    tools: [],
    signal: new AbortController().signal,
    onText: (delta: string) => {
      text += delta;
    },
  });

  return turn.text
    .split("\n")
    .map((l) => l.replace(/^[-*•\s\d.]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}