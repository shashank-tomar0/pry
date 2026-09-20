/**
 * Planner adapter for every OpenAI-compatible endpoint PRY supports.
 *
 * WHY ONE TABLE AND NOT FOUR FILES
 *
 * Groq and NVIDIA used to carry their own copy of this file — the same helpers,
 * the same stream loop, differing only in a base URL, a label, an output cap and
 * whether they parsed a `reasoning_content` field. That is one bug fixed as
 * many times as there are copies: Groq's reasoning-channel fix (chain-of-thought
 * routed to `onText`, where the panel paints it as the agent's ANSWER) had to be
 * copied into NVIDIA's file to reach it, and the next compatible provider would
 * have meant a fourth copy. Everything the copies differed by now lives in
 * `SPECS` as data, and the behaviour lives here once.
 *
 * The reasoning channel is deliberately uniform: every adapter that sees a
 * reasoning field forwards it to `onThought`, never `onText`. `onThought` is the
 * liveness signal that drives the wait ticker and feeds `liveness.reasoningChars`
 * — the number the deliberation cut reads — and it is never printed verbatim.
 */

import OpenAI from "openai";
import type {
  ConvMessage,
  Planner,
  PlannerRequest,
  PlannerTurn,
  ProviderId,
  StopReason,
  ToolSpec,
} from "./types";
import { normalizeToolName, parseArguments } from "./types";
import { describeOpenAIError } from "./errors";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Every provider this adapter serves. Ollama has its own native adapter. */
export type OpenAICompatibleProvider = Exclude<ProviderId, "anthropic" | "ollama">;

/**
 * What one OpenAI-compatible endpoint needs, as data.
 *
 * `maxTokensParam` is a real fork in the road rather than a style choice: OpenAI
 * renamed the output cap for its reasoning models and rejects the old name on
 * them, while every other compatible endpoint — and OpenRouter, which passes the
 * field through to whichever model is behind it — expects `max_tokens`.
 */
interface CompatibleSpec {
  /** Human name used in the planner's label and in every error it raises. */
  label: string;
  baseURL: string;
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /**
   * Output cap in tokens.
   *
   * Stated per provider because the free tiers are not interchangeable: a large
   * cap on a metered free tier is a request the provider can refuse outright,
   * which reads to the user as a broken model.
   */
  maxTokens: number;
  /** Extra request headers, where the endpoint asks to be attributed. */
  headers?: Record<string, string>;
}

const SPECS: Record<OpenAICompatibleProvider, CompatibleSpec> = {
  openai: {
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    maxTokensParam: "max_completion_tokens",
    maxTokens: 8000,
  },
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    maxTokensParam: "max_tokens",
    maxTokens: 8000,
    // OpenRouter asks for these to attribute traffic; both are optional, and
    // omitting them only costs the attribution.
    headers: { "HTTP-Referer": "https://github.com/pry/pry-agent", "X-Title": "PRY Agent" },
  },
  /** Free tier, ~280-1000 tokens/s, 40 requests/minute. */
  groq: {
    label: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    maxTokensParam: "max_tokens",
    maxTokens: 2048,
  },
  /** Free tier at integrate.api.nvidia.com; 410 Gone means a retired model. */
  nvidia: {
    label: "NVIDIA",
    baseURL: "https://integrate.api.nvidia.com/v1",
    maxTokensParam: "max_tokens",
    maxTokens: 2048,
  },
};

/**
 * Turn the canonical conversation into this API's message list.
 *
 * OpenAI keeps assistant prose and tool calls on one message, and expects each
 * tool result as its own `role: "tool"` message — so one canonical tool turn fans
 * out into several messages here.
 */
export function toMessages(system: string, messages: ConvMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text || null,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      });
      continue;
    }

    for (const result of message.results) {
      out.push({
        role: "tool",
        tool_call_id: result.id,
        // There is no is_error flag here, so the marker goes inline.
        content: result.isError ? `ERROR: ${result.content}` : result.content,
      });
    }
  }

  return out;
}

function toTools(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function toStopReason(raw: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (raw === "tool_calls" || hasToolCalls) return "tool_use";
  if (raw === "length") return "max_tokens";
  if (raw === "content_filter") return "refusal";
  return "end_turn";
}

export function createOpenAIPlanner(
  provider: OpenAICompatibleProvider,
  apiKey: string,
  model: string,
  customBaseURL?: string,
): Planner {
  const spec = SPECS[provider];

  const client = new OpenAI({
    apiKey,
    baseURL: customBaseURL ?? spec.baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: spec.headers,
  });

  return {
    label: `${spec.label} ${model}`,

    async run({
      system,
      messages,
      tools,
      signal,
      onText,
      onThought,
      onMilestone,
    }: PlannerRequest): Promise<PlannerTurn> {
      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;

      onMilestone?.("requested", performance.now());
      try {
        stream = await client.chat.completions.create(
          {
            model,
            messages: toMessages(system, messages),
            tools: toTools(tools),
            stream: true,
            [spec.maxTokensParam]: spec.maxTokens,
          } as OpenAI.Chat.Completions.ChatCompletionCreateParams,
          { signal },
        );
      } catch (error) {
        throw describeOpenAIError(error, spec.label);
      }
      // The promise resolving means the endpoint sent response headers: it
      // answered. Nothing about how LONG the model will take is known yet — a
      // streaming request sends no body bytes until the model produces a token —
      // so this is the one measurement that separates a queue from a think.
      onMilestone?.("headers", performance.now());

      let text = "";
      let refusal = "";
      let finishReason: string | null | undefined;
      /** Reported once, on the first byte of any kind — see PlannerMilestone. */
      let outputReported = false;

      // Tool calls stream in as deltas keyed by index — name arrives once, then
      // arguments accumulate across many chunks as raw JSON text.
      const partials = new Map<number, { id: string; name: string; args: string }>();

      try {
        for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
          const choice = chunk.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta as {
            content?: string;
            refusal?: string;
            reasoning_content?: string;
            reasoning?: string;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };

          // The model produced something. Reported before the channel split
          // because a turn that goes straight to a tool call sends no content at
          // all, and that turn still took time the wait policy needs to measure.
          if (
            !outputReported &&
            (delta.content || delta.refusal || delta.tool_calls?.length || delta.reasoning_content || delta.reasoning)
          ) {
            outputReported = true;
            onMilestone?.("output", performance.now());
          }

          // A reasoning model's chain-of-thought arrives in its own field
          // (`reasoning_content` on NIM/Groq, `reasoning` on OpenRouter's
          // pass-through) and belongs on the REASONING channel. Sent to `onText`
          // it would be painted as the agent's answer AND leave
          // `liveness.reasoningChars` at zero, which silently disables the
          // deliberation cut.
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (reasoning) onThought?.(String(reasoning));

          if (delta.content) {
            text += delta.content;
            onText(delta.content);
          }
          if (delta.refusal) refusal += delta.refusal;

          for (const call of delta.tool_calls ?? []) {
            const existing = partials.get(call.index) ?? { id: "", name: "", args: "" };
            if (call.id) existing.id = call.id;
            if (call.function?.name) existing.name = call.function.name;
            if (call.function?.arguments) existing.args += call.function.arguments;
            partials.set(call.index, existing);
          }
        }
      } catch (error) {
        throw describeOpenAIError(error, spec.label);
      }

      const toolCalls = Array.from(partials.entries())
        .sort(([a], [b]) => a - b)
        .filter(([, call]) => call.name)
        .map(([index, call]) => ({
          // Some OpenAI-compatible backends omit ids; the id only has to be
          // unique within the turn for the tool result to match up.
          id: call.id || `call_${index}`,
          // Streamed names can carry the model's channel markers
          // (normalizeToolName) — repaired here so a formatting leak executes
          // instead of dying as "Unknown tool" in the executor.
          name: normalizeToolName(call.name, tools.map((t) => t.name)),
          input: parseArguments(call.args),
        }));

      if (refusal) {
        return { text: refusal, toolCalls: [], stopReason: "refusal", refusal };
      }

      return {
        text,
        toolCalls,
        stopReason: toStopReason(finishReason, toolCalls.length > 0),
      };
    },
  };
}
