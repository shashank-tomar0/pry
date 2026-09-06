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
import { parseArguments } from "./types";
import { describeOpenAIError } from "./errors";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * OpenAI keeps assistant prose and tool calls on one message, and expects each
 * tool result as its own `role: "tool"` message — so one canonical tool turn
 * fans out into several messages here.
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

const ENDPOINTS: Record<Exclude<ProviderId, "anthropic">, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  groq: "https://api.groq.com/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
};

/**
 * Serves both OpenAI and OpenRouter — OpenRouter exposes the same chat
 * completions surface, so only the base URL and a couple of headers differ.
 */
export function createOpenAIPlanner(
  provider: Exclude<ProviderId, "anthropic">,
  apiKey: string,
  model: string,
  customBaseURL?: string,
): Planner {
  const client = new OpenAI({
    apiKey,
    baseURL: customBaseURL ?? ENDPOINTS[provider],
    dangerouslyAllowBrowser: true,
    defaultHeaders:
      provider === "openrouter"
        ? // OpenRouter attributes traffic with these; both are optional.
          { "HTTP-Referer": "https://github.com/pry/pry-agent", "X-Title": "PRY Agent" }
        : undefined,
  });

  const labels: Record<Exclude<ProviderId, "anthropic">, string> = {
    openai: "OpenAI",
    openrouter: "OpenRouter",
    ollama: "Ollama (Local)",
    groq: "Groq",
    nvidia: "NVIDIA",
  };
  const label = labels[provider] ?? provider;

  return {
    label: `${label} ${model}`,

    async run({ system, messages, tools, signal, onText }: PlannerRequest): Promise<PlannerTurn> {
      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;

      try {
        stream = await client.chat.completions.create(
          {
            model,
            messages: toMessages(system, messages),
            tools: toTools(tools),
            stream: true,
            // OpenAI renamed this for reasoning models; OpenRouter takes the
            // original name and passes it through to whichever model is behind it.
            // Ollama uses max_tokens.
            ...(provider === "openai"
              ? { max_completion_tokens: 8000 }
              : { max_tokens: 8000 }),
          },
          { signal },
        );
      } catch (error) {
        throw describeOpenAIError(error, label);
      }

      let text = "";
      let refusal = "";
      let finishReason: string | null | undefined;

      // Tool calls stream in as deltas keyed by index — name arrives once, then
      // arguments accumulate across many chunks as raw JSON text.
      const partials = new Map<number, { id: string; name: string; args: string }>();

      try {
        for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
          const choice = chunk.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;
          if (delta?.content) {
            text += delta.content;
            onText(delta.content);
          }
          if (delta?.refusal) refusal += delta.refusal;

          for (const call of delta?.tool_calls ?? []) {
            const existing = partials.get(call.index) ?? { id: "", name: "", args: "" };
            if (call.id) existing.id = call.id;
            if (call.function?.name) existing.name = call.function.name;
            if (call.function?.arguments) existing.args += call.function.arguments;
            partials.set(call.index, existing);
          }
        }
      } catch (error) {
        throw describeOpenAIError(error, label);
      }

      const toolCalls = Array.from(partials.entries())
        .sort(([a], [b]) => a - b)
        .filter(([, call]) => call.name)
        .map(([index, call]) => ({
          // Some OpenAI-compatible backends omit ids; the id only has to be
          // unique within the turn for the tool result to match up.
          id: call.id || `call_${index}`,
          name: call.name,
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
