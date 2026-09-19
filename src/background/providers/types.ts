/**
 * A provider-neutral view of one planning turn.
 *
 * Anthropic returns content blocks; OpenAI returns a message with a separate
 * tool_calls array. Rather than teach the agent loop both shapes, each adapter
 * normalises into the types below and the loop only ever sees these.
 */

export type ProviderId = "anthropic" | "openai" | "openrouter" | "ollama" | "groq" | "nvidia";

/** A tool definition, in the intersection both APIs accept. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /** Provider-issued id; results must be returned against it. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolOutcome {
  id: string;
  content: string;
  isError?: boolean;
}

/** The conversation, in the one shape both adapters can translate from. */
export type ConvMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolOutcome[] };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

/**
 * A boundary a planner request has crossed, measured where it is crossed.
 *
 * The run can already see when the first streamed delta arrives. It cannot see
 * the two moments BEFORE that from outside the adapter, and the distance between
 * them is the whole answer to "was that silence the network, or the model":
 *
 *   - `requested` — the request was handed to the transport;
 *   - `headers`   — the endpoint's response headers arrived, i.e. something
 *                   answered. A provider queue, a stalled socket and a model
 *                   thinking look IDENTICAL from here until this lands, because
 *                   a streaming request sends no body bytes until the model
 *                   produces its first token;
 *   - `output`    — the model's first byte of ANY kind arrived: prose, a
 *                   chain-of-thought delta, or a tool call.
 *
 * `output` is separate from the `onText`/`onThought` callbacks for a reason that
 * cost the wait policy its most common case: a turn that goes straight to a tool
 * call streams NO prose at all, so a first-token measurement taken from those
 * callbacks records nothing for exactly the turns a run is mostly made of. The
 * reported run's queueing endpoint was invisible to the speed-up decision for
 * that reason — the queue was measured on the one turn that happened to answer in
 * words, by which time the run was over.
 *
 * Reported by the adapters because only they sit on the transport. A planner
 * that reports none is simply described with the bound the run does have (time
 * to first streamed delta).
 */
export type PlannerMilestone = "requested" | "headers" | "output";

export interface PlannerTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  /** Set when the provider declined outright. */
  refusal?: string;
}

export interface PlannerRequest {
  system: string;
  messages: ConvMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  /** Called with each prose delta so the panel can stream. */
  onText: (delta: string) => void;
  /**
   * Called with each chain-of-thought delta when the provider streams one
   * (reasoning models). Never displayed verbatim — its arrival is the
   * liveness proof that drives the planner-wait ticker, so a cold-start turn
   * reads as "the model is reasoning", not as a frozen panel.
   */
  onThought?: (delta: string) => void;
  /**
   * Called when the request crosses a boundary the run cannot observe from
   * outside the adapter — see PlannerMilestone. `at` is a `performance.now()`
   * reading, so the caller can subtract it from its own clock readings.
   */
  onMilestone?: (milestone: PlannerMilestone, at: number) => void;
}

export interface Planner {
  readonly label: string;
  run(request: PlannerRequest): Promise<PlannerTurn>;
}

/** Raised with a message already fit to show the user. */
export class PlannerError extends Error {}

/**
 * Tool arguments arrive as a JSON string from OpenAI and as a parsed object
 * from Anthropic, and models occasionally emit malformed JSON either way.
 */
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
