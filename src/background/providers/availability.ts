/**
 * NVIDIA model availability checker.
 *
 * Pings the NVIDIA NIM API to check whether the configured model is still
 * available BEFORE the user runs a task, so a retired model is caught at
 * configuration time rather than mid-run.
 *
 * NVIDIA's free tier is shared GPU infrastructure with no SLA — the models list
 * endpoint is lightweight (no inference) and serves as a cheap liveness + model
 * catalogue check. We call it:
 *  1. On extension startup (background, fire-and-forget)
 *  2. When the user saves NVIDIA settings in Options
 *  3. Via the side panel's provider status badge (lazy, on first open)
 */

import type { ProviderId } from "./types";

export interface ModelAvailability {
  /** Whether the API was reachable at all. */
  reachable: boolean;
  /** HTTP status from the models endpoint, if reachable. */
  status: number | null;
  /** Models the API reports as available, if reachable. */
  availableModels: string[];
  /** Whether the currently configured model is in the available list. */
  configuredModelAvailable: boolean;
  /** When the check was performed (ms since epoch). */
  checkedAt: number;
  /** Error message if the check failed. */
  error: string | null;
}

const MODELS_CACHE_KEY = "pry-nvidia-models-check";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — model catalogue changes rarely

/**
 * Check whether a specific model is available on NVIDIA NIM.
 * Fire-and-forget safe: always resolves, never throws to the caller.
 */
export async function checkNvidiaModelAvailability(
  apiKey: string,
  model: string,
): Promise<ModelAvailability> {
  if (!apiKey || !model) {
    return {
      reachable: false,
      status: null,
      availableModels: [],
      configuredModelAvailable: false,
      checkedAt: Date.now(),
      error: "No API key or model configured",
    };
  }

  try {
    const response = await fetch(
      "https://integrate.api.nvidia.com/v1/models",
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        // Short timeout — we only need the models list, not inference.
        // AbortSignal.timeout may not exist in older Chrome builds, so fall
        // back to no signal (the caller treats a hang as unreachable).
        signal:
          typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(15_000)
            : undefined,
      },
    ).catch((err) => {
      // AbortSignal.timeout may not be available in all Chrome versions.
      // Fall back to manual timeout.
      return Promise.reject(err);
    });

    if (!response.ok) {
      return {
        reachable: false,
        status: response.status,
        availableModels: [],
        configuredModelAvailable: false,
        checkedAt: Date.now(),
        error: `NVIDIA API returned ${response.status}${response.status === 401 ? " — check your API key" : response.status === 403 ? " — access denied" : ""}`,
      };
    }

    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const availableModels = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id));

    return {
      reachable: true,
      status: response.status,
      availableModels,
      configuredModelAvailable: availableModels.includes(model),
      checkedAt: Date.now(),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("abort") || message.includes("timeout")) {
      return {
        reachable: false,
        status: null,
        availableModels: [],
        configuredModelAvailable: false,
        checkedAt: Date.now(),
        error: "NVIDIA API did not respond in time (network or server issue)",
      };
    }
    return {
      reachable: false,
      status: null,
      availableModels: [],
      configuredModelAvailable: false,
      checkedAt: Date.now(),
      error: `Could not reach NVIDIA: ${message}`,
    };
  }
}

/**
 * Get cached availability, refreshing if the cache is stale.
 * Designed to be called from the side panel on first open.
 */
export async function getNvidiaAvailability(
  apiKey: string,
  model: string,
): Promise<ModelAvailability> {
  // Try cache first
  const cached = await chrome.storage.local.get(MODELS_CACHE_KEY);
  const cachedData = (cached as Record<string, unknown>)[MODELS_CACHE_KEY] as {
    data: ModelAvailability;
    expiresAt: number;
  } | undefined;

  if (cachedData && cachedData.expiresAt > Date.now()) {
    return cachedData.data;
  }

  // Fresh check
  const result = await checkNvidiaModelAvailability(apiKey, model);

  // Cache the result
  await chrome.storage.local.set({
    [MODELS_CACHE_KEY]: {
      data: result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    },
  });

  return result;
}

/**
 * Invalidate the cached model availability. Call this after settings change.
 */
export async function invalidateNvidiaCache(): Promise<void> {
  await chrome.storage.local.remove(MODELS_CACHE_KEY);
}

/**
 * Check availability for any OpenAI-compatible provider.
 * Currently only NVIDIA has a meaningful model-retirement story, but the
 * interface is generic so Groq/OpenRouter can be added later.
 */
export async function checkProviderAvailability(
  provider: ProviderId,
  apiKey: string,
  model: string,
): Promise<ModelAvailability | null> {
  if (provider === "nvidia") {
    return getNvidiaAvailability(apiKey, model);
  }
  // Other providers: not implemented yet — return null so callers know
  // there's nothing to check.
  return null;
}
