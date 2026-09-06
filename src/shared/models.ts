import type { ProviderId } from "../background/providers/types";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Where the user goes to get a key. */
  keyUrl: string;
  keyHint: string;
  /** Starting points only — the options page can refresh this list live. */
  suggested: string[];
  defaultModel: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    suggested: [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-4-8",
      "claude-fable-5",
    ],
    defaultModel: "claude-opus-5",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    // Verified against a live catalogue, but vendors ship constantly — the
    // Refresh button in the options page is the authority, not this list.
    suggested: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.1", "gpt-5"],
    defaultModel: "gpt-5.5",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-v1-…",
    suggested: [
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.5",
      "google/gemini-3.1-pro-preview",
      "x-ai/grok-4.6",
      "deepseek/deepseek-v4-pro",
    ],
    defaultModel: "anthropic/claude-opus-5",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (Local)",
    keyUrl: "https://ollama.com/download",
    keyHint: "No key needed — runs locally",
    suggested: [
      "qwen2.5:1.5b",
      "qwen2.5:3b",
      "qwen2.5:7b",
      "llama3.2:1b",
      "llama3.2:3b",
      "llama3.1:8b",
      "mistral:7b",
      "codellama:7b",
      "phi3:3.8b",
      "gemma2:9b",
    ],
    defaultModel: "qwen2.5:1.5b",
  },
  groq: {
    id: "groq",
    label: "Groq",
    keyUrl: "https://console.groq.com/keys",
    keyHint: "gsk_...",
    suggested: [
      "openai/gpt-oss-20b",
      "openai/gpt-oss-120b",
      "qwen/qwen3.6-27b",
      "qwen/qwen3.8-27b",
    ],
    defaultModel: "openai/gpt-oss-20b",
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    keyUrl: "https://build.nvidia.com",
    keyHint: "nvapi-...",
    suggested: [
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-nano-30b-a3b",
      "deepseek-ai/deepseek-v4-pro-0813",
      "qwen/qwq-32b",
      "meta/llama-3.1-8b-instruct",
    ],
    defaultModel: "nvidia/nemotron-3.5-lightning-30b-a3b",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/**
 * Fetches the models a provider currently offers. The bundled suggestions go
 * stale as vendors ship; this is how the user gets the real list.
 *
 * Uses plain fetch rather than the SDKs so the options page stays small.
 */
export async function listModels(
  provider: ProviderId,
  apiKey: string,
): Promise<string[]> {
  if (provider === "ollama") {
    // Ollama runs locally — fetch the list of pulled models.
    const baseUrl = "http://localhost:11434";
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) throw new Error(`Ollama returned ${response.status} — is Ollama running?`);
    const body = (await response.json()) as { models?: { name?: string }[] };
    const models = (body.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
    if (models.length === 0) throw new Error("No models pulled. Run: ollama pull qwen2.5:1.5b");
    return models.sort();
  }

  if (provider === "openrouter") {
    // OpenRouter's catalogue is public — no key needed.
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)).sort();
  }

  if (provider === "groq") {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`Groq returned ${response.status}`);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
      .filter((id) => /^(llama|openai\/gpt|qwen\/qwen|mixtral|gemma)/.test(id))
      .sort();
  }

  if (provider === "nvidia") {
    const response = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`NVIDIA returned ${response.status}`);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
      // Only include chat/text models, not embedding or safety models.
      .filter((id) => /^(meta|deepseek|qwen|nvidia\/(nemotron|llama|deepseek)|mistralai|openai\/gpt)/.test(id))
      .sort();
  }

  if (!apiKey) throw new Error("Enter an API key first.");

  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
      // Embeddings, audio, and image models cannot drive an agent loop.
      .filter((id) => /^(gpt|o\d|chatgpt)/.test(id))
      .sort();
  }

  const response = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for any Anthropic API call made straight from a browser.
      "anthropic-dangerous-direct-browser-access": "true",
    },
  });
  if (!response.ok) throw new Error(`Anthropic returned ${response.status}`);
  const body = (await response.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}
