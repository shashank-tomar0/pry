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
