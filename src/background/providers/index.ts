import type { Settings } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { PROVIDERS } from "../../shared/models";
import { createAnthropicPlanner } from "./anthropic";
import { createOpenAIPlanner } from "./openai";
import { createOllamaPlanner } from "./ollama";
import type { Planner } from "./types";
import { PlannerError } from "./types";

/**
 * Builds the planner for whichever provider the user has selected.
 *
 * A stored blank/whitespace model (e.g. saved from a cleared options field)
 * falls back to the provider's default rather than aborting the run mid-task
 * with "No model chosen" — the options page always has a usable default.
 *
 * "Fast planner mode" substitutes the provider's `fastModel` HERE, in the one
 * place a model is chosen, so every consumer gets it — the run, the lesson
 * generator, the vision pass — instead of each call site deciding for itself.
  * Nothing has to be re-labelled either: the planner's own label carries the  * model string, and the panel prints it (`Using NVIDIA openai/gpt-oss-20b`),
 * so a run can never quietly use a model other than the one it announced.
 *
 * Which adapter each provider gets is the whole of the routing below: Ollama has
 * its own native API, Anthropic its own SDK, and every OpenAI-compatible
 * endpoint (OpenAI, OpenRouter, Groq, NVIDIA) shares one implementation.
 */
/** The model a run would use for `provider` as configured, before fast mode. */
export function configuredModel(settings: Settings): string {
  const provider = settings.provider;
  return (
    (settings.models[provider] ?? "").trim() || DEFAULT_SETTINGS.models[provider] || ""
  );
}

/**
 * The provider's fast model, or null when it would not change anything.
 *
 * Null means "nothing to switch to": either the provider declares no fast model
 * or the configured model IS it. The run's automatic speed-up reads this instead
 * of assuming every provider has a faster option, and `createPlanner` uses the
 * same function, so the two can never disagree about what "fast" resolves to.
 */
export function fastModelFor(settings: Settings): string | null {
  const provider = settings.provider;
  const fast = PROVIDERS[provider]?.fastModel ?? "";
  if (!fast) return null;
  return fast === configuredModel(settings) ? null : fast;
}

export function createPlanner(settings: Settings): Planner {
  const provider = settings.provider;
  const apiKey = settings.apiKeys[provider] ?? "";
  const configured = configuredModel(settings);
  const model = settings.fastPlanner
    ? fastModelFor(settings) ?? configured
    : configured;

  if (!model) {
    throw new PlannerError(`No model chosen for ${provider}. Pick one in the extension options.`);
  }

  // Ollama runs locally — uses native API, no API key required.
  if (provider === "ollama") {
    return createOllamaPlanner(model);
  }

  if (!apiKey) {
    throw new PlannerError(
      `No API key set for ${provider}. Open the extension options and add one.`,
    );
  }

  if (provider === "anthropic") {
    return createAnthropicPlanner(apiKey, model);
  }

  // OpenAI, OpenRouter, Groq and NVIDIA are one adapter with a per-provider
  // spec table — see providers/openai.ts for why they are no longer four files.
  return createOpenAIPlanner(provider, apiKey, model);
}

export type { Planner };
export { PlannerError };
