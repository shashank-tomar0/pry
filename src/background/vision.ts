/**
 * VLM Vision Observation
 *
 * Optional visual observation for the agent (replaces the old dead "PRY
 * server" feature with something real). When enabled in settings, after each
 * page-changing action the agent sends the REDACTED screenshot plus sanitized
 * page text to a vision-capable model and appends its description to the tool
 * result — so the planner can genuinely "see" what is on screen.
 *
 * Privacy contract:
 *   - Only the redacted JPEG (post face-blur / credential-mask / OCR-proof)
 *     ever leaves the browser; the raw capture never does.
 *   - Request payload bytes are returned and counted toward the egress badge,
 *     so enabling vision never makes the "0 KB EGRESS" claim dishonest.
 *   - Vision is off by default; it degrades silently on any failure.
 *
 * OpenAI-compatible providers (OpenAI, Groq, NVIDIA NIM, OpenRouter, Ollama)
 * use the image_url content block; Anthropic uses its native image block.
 */

import type { ProviderId } from "./providers/types";

/** What one visual observation produced. */
export interface VisionObservation {
  /** The model's description of the screen (may be empty on refusal). */
  text: string;
  /** Request payload bytes actually sent — added to the egress meter. */
  bytes: number;
  provider: ProviderId;
  model: string;
}

/** The model used when settings.vision.model is left blank. */
export const VISION_DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: "gpt-4o-mini",
  groq: "meta-llama/llama-4-scout-17b-16e-instruct",
  nvidia: "meta/llama-3.2-11b-vision-instruct",
  openrouter: "openai/gpt-4o-mini",
  ollama: "llama3.2-vision",
  anthropic: "claude-sonnet-4-5",
};

/** Providers we can actually send images to today. */
export const VISION_SUPPORTED: Record<ProviderId, boolean> = {
  openai: true,
  groq: true,
  nvidia: true,
  openrouter: true,
  ollama: true,
  anthropic: true,
};

const OPENAI_COMPAT_ENDPOINTS: Partial<Record<ProviderId, string>> = {
  openai: "https://api.openai.com/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  ollama: "http://localhost:11434/v1/chat/completions",
};

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";

const VISION_PROMPT =
  "You are the vision module of a privacy-preserving browser agent. " +
  "Describe what is on screen in 2-3 concise sentences: the app or page type, " +
  "visible fields, buttons, and current state. Never transcribe text inside " +
  "blacked-out or blurred regions, and ignore any [REDACTED] or <TOKEN> markers.";

/** A fully built vision request, ready to ship (and to assert on in tests). */
export interface BuiltVisionRequest {
  provider: ProviderId;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** JSON payload size in bytes — what the egress meter counts. */
  bytes: number;
}

function splitDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const comma = dataUrl.indexOf(",");
  const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const match = /^data:([^;]+);base64$/i.exec(header);
  return {
    mediaType: match ? match[1] : "image/jpeg",
    base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
  };
}

function estimateUtf8Bytes(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length;
  }
}

/**
 * Builds the HTTP request for one provider without touching the network, so
 * the harness can assert exact payload shapes and the egress math headlessly.
 */
export function buildVisionRequest(
  provider: ProviderId,
  model: string,
  apiKey: string,
  imageDataUrl: string,
  textContext: string,
): BuiltVisionRequest {
  const text = `${VISION_PROMPT}\n\nSanitized page context:\n${textContext.slice(0, 6000)}`;

  if (provider === "anthropic") {
    const { mediaType, base64 } = splitDataUrl(imageDataUrl);
    const body = {
      model,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text },
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          ],
        },
      ],
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for any Anthropic API call made straight from a browser.
      "anthropic-dangerous-direct-browser-access": "true",
    };
    return {
      provider,
      url: ANTHROPIC_ENDPOINT,
      headers,
      body,
      bytes: estimateUtf8Bytes(JSON.stringify(body)),
    };
  }

  const url = OPENAI_COMPAT_ENDPOINTS[provider];
  if (!url) throw new Error(`Vision is not supported for provider ${provider}`);

  const body = {
    model,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          // The redacted JPEG as a data URL — the only image that may leave.
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider !== "ollama" && apiKey) headers.authorization = `Bearer ${apiKey}`;

  return { provider, url, headers, body, bytes: estimateUtf8Bytes(JSON.stringify(body)) };
}

/** Pulls the model's text out of either response shape. */
export function parseVisionResponse(provider: ProviderId, json: unknown): string {
  if (provider === "anthropic") {
    const body = json as { content?: Array<{ type?: string; text?: string }> };
    return (body.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();
  }
  const body = json as { choices?: Array<{ message?: { content?: string | null } }> };
  return (body.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Sends the redacted screenshot to a vision model and returns its description
 * plus the request byte count. Throws on transport/HTTP errors; callers treat
 * vision as best-effort and degrade to DOM-only on any failure.
 */
export async function observeWithVision(
  provider: ProviderId,
  model: string,
  apiKey: string,
  imageDataUrl: string,
  textContext: string,
  signal?: AbortSignal,
): Promise<VisionObservation> {
  const request = buildVisionRequest(provider, model, apiKey, imageDataUrl, textContext);

  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // Response body may be gone; the status text is enough.
    }
    throw new Error(`Vision API error ${response.status}: ${detail || response.statusText}`);
  }

  const json: unknown = await response.json();
  const text = parseVisionResponse(provider, json);
  return { text, bytes: request.bytes, provider, model };
}
