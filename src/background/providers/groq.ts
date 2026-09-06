/**
 * Groq Planner
 *
 * Uses Groq's OpenAI-compatible /openai/v1 endpoint.
 * Groq is free-tier friendly with ultra-fast inference (280-1000 tps).
 *
 * Key models:
 *   - llama-3.3-70b-versatile (131K context, 280 tps)
 *   - llama-3.1-8b-instant (131K context, 560 tps)
 *   - openai/gpt-oss-20b (131K context, 1000 tps)
 */

import OpenAI from "openai";
import type {
  ConvMessage,
  Planner,
  PlannerRequest,
  PlannerTurn,
  StopReason,
  ToolSpec,
} from "./types";
import { parseArguments } from "./types";
import { describeOpenAIError } from "./errors";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

function toMessages(system: string, messages: ConvMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];

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

export function createGroqPlanner(apiKey: string, model: string): Planner {
  const client = new OpenAI({
    apiKey,
    baseURL: GROQ_BASE_URL,
    dangerouslyAllowBrowser: true,
  });

  return {
    label: `Groq ${model}`,

    async run({ system, messages, tools, signal, onText }: PlannerRequest): Promise<PlannerTurn> {
      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;

      try {
        stream = await client.chat.completions.create(
          {
            model,
            messages: toMessages(system, messages),
            tools: toTools(tools),
            stream: true,
            max_tokens: 2048,
          },
          { signal },
        );
      } catch (error) {
        throw describeOpenAIError(error, "Groq");
      }

      let text = "";
      let refusal = "";
      let finishReason: string | null | undefined;
      const partials = new Map<number, { id: string; name: string; args: string }>();

      try {
        for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
          const choice = chunk.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta as any;
          const reasoning = delta?.reasoning_content || delta?.reasoning;
          if (reasoning) {
            onText(reasoning);
          }
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
        throw describeOpenAIError(error, "Groq");
      }

      const toolCalls = Array.from(partials.entries())
        .sort(([a], [b]) => a - b)
        .filter(([, call]) => call.name)
        .map(([index, call]) => ({
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
