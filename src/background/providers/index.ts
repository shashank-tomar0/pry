import type { Settings } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { PROVIDERS } from "../../shared/models";
import { createAnthropicPlanner } from "./anthropic";
import { createOpenAIPlanner } from "./openai";
import { createOllamaPlanner } from "./ollama";
import { createGroqPlanner } from "./groq";
import { createNvidiaPlanner } from "./nvidia";
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
 * Nothing has to be re-labelled either: the planner's own label carries the
 * model string, and the panel prints it (`Using NVIDIA meta/llama-3.1-8b-instruct`),
 * so a run can never quietly use a model other than the one it announced.
 */
export function createPlanner(settings: Settings): Planner {
  const provider = settings.provider;
  const apiKey = settings.apiKeys[provider] ?? "";
  const configured =
    (settings.models[provider] ?? "").trim() || DEFAULT_SETTINGS.models[provider] || "";
  const model = settings.fastPlanner
    ? PROVIDERS[provider]?.fastModel || configured
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

  if (provider === "groq") {
    return createGroqPlanner(apiKey, model);
  }

  if (provider === "nvidia") {
    return createNvidiaPlanner(apiKey, model);
  }

  return provider === "anthropic"
    ? createAnthropicPlanner(apiKey, model)
    : createOpenAIPlanner(provider, apiKey, model);
}

export type { Planner };
export { PlannerError };
