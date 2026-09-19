/**
 * Provider error descriptions.
 *
 * Models retire and free tiers change constantly (NVIDIA 410s EOL models,
 * Groq gates models behind enterprise). A raw SDK error blob shown mid-run
 * reads as a broken product, so every OpenAI-compatible adapter funnels its
 * errors through here and turns "model gone / key rejected / rate limited"
 * into an actionable sentence the user can fix in the options page.
 */

import OpenAI from "openai";
import { PlannerError } from "./types";

/**
 * Pure: decide whether a status + message means the chosen model id is
 * unavailable (unknown, retired, gated, or removed) rather than a generic
 * API failure. Exported so the headless harness can pin the mapping.
 */
export function modelUnavailableReason(
  status: number,
  message: string,
): string | null {
  if (status === 410) {
    // NVIDIA uses HTTP 410 Gone exclusively for retired/end-of-life models.
    return "that model has reached its end of life and is no longer served";
  }
  if (status === 404) {
    return "the model id was not found (or your key cannot access it)";
  }
  if (
    status === 400 &&
    /model/i.test(message) &&
    /(not found|not available|no longer|does not exist|invalid|not supported|unavailable|gated|access)/i.test(message)
  ) {
    return "that model id is not available for your key or tier";
  }
  return null;
}

/**
 * Whether a failure is the TRANSPORT rather than the provider, and what to say
 * about it.
 *
 * A connection that dies mid-answer arrives as whatever the socket layer threw —
 * `terminated` with a `SocketError` cause in undici, `fetch failed`, `other side
 * closed` — and before this mapping existed it reached the transcript as that
 * bare word. Two things were wrong with that. The user was shown a word that
 * names nothing they can act on, and `isRetryablePlannerError` saw no keyword it
 * recognised, so a dropped answer got NO retry even though the model HAD seen the
 * prompt — the opposite of the policy's intent for a genuine hiccup.
 *
 * Two deliberate exclusions: the run's own abort (a budget cut, or Stop) is not a
 * network fault and the run already knows what it did; and anything carrying an
 * HTTP status is the provider answering, not the transport failing.
 */
export function transportFailure(message: string, cause = ""): string | null {
  if (/abort/i.test(message)) return null;
  if (
    !/terminated|socket|econn|epipe|fetch failed|network|other side closed|premature close|und_err|connection (error|closed|reset|dropped)/i.test(
      `${message} ${cause}`,
    )
  ) {
    return null;
  }
  return (
    "network error: the connection dropped mid-answer — the request was accepted and the " +
    "response stopped arriving, so this is the transport rather than the model"
  );
}

/** Shorten a raw provider message so the transcript never floods with JSON. */
function shorten(message: string, max = 220): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`;
}

/**
 * Map an OpenAI-SDK-shaped error to a PlannerError the agent loop can show.
 * `label` is the human provider name ("Groq", "NVIDIA", "OpenAI", ...).
 */
export function describeOpenAIError(error: unknown, label: string): Error {
  const status = (error as { status?: number })?.status;
  const rawMessage =
    (error as { message?: string })?.message ?? (error as Error)?.message ?? String(error);

  if (error instanceof OpenAI.AuthenticationError) {
    return new PlannerError(
      `${label} rejected your API key. Open the extension options and check it.`,
    );
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new PlannerError(
      `${label} rate-limited this request (${status ?? "unknown"}). Wait a moment and retry — or switch to a smaller snapshot model in options.`,
    );
  }
  if (error instanceof OpenAI.NotFoundError) {
    return new PlannerError(
      `${label}: ${modelUnavailableReason(status ?? 404, rawMessage) ?? "the model id was not found"}. ` +
        `Open the extension options, press "Test Providers", and pick an available model.`,
    );
  }
  if (status === undefined) {
    // No HTTP status means no response ever described this failure — the socket
    // did, not the provider.
    const transport = transportFailure(rawMessage, (error as { cause?: { message?: string } })?.cause?.message ?? "");
    if (transport) return new PlannerError(`${label} ${transport}.`);
  }
  if (error instanceof OpenAI.APIError) {
    const reason = modelUnavailableReason(status ?? 0, rawMessage);
    if (reason) {
      return new PlannerError(
        `${label}: ${reason}. Open the extension options, press "Test Providers", and pick a currently available model.`,
      );
    }
    return new PlannerError(`${label} API error ${status ?? "unknown"}: ${shorten(rawMessage)}`);
  }

  if (status === 404 || status === 410 || (status === 400 && /model/i.test(rawMessage))) {
    return new PlannerError(
      `${label}: ${modelUnavailableReason(status ?? 0, rawMessage) ?? "the model id was not found"}. ` +
        `Open the extension options and pick another model.`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
