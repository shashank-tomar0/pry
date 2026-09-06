/**
 * NVIDIA NIM Planner
 *
 * Uses NVIDIA's OpenAI-compatible endpoint at integrate.api.nvidia.com.
 * Free tier: 40 RPM, 100+ models including 70B+ for free.
 * No credit card required. Sign up at build.nvidia.com.
 *
 * Key models:
 *   - meta/llama-3.3-70b-instruct (70B, free)
 *   - meta/llama-3.1-70b-instruct (70B, free)
 *   - deepseek-ai/deepseek-v4-pro (frontier, free)
 *   - qwen/qwq-32b (32B, free)
 *   - nvidia/llama-3.3-nemotron-super-49b-v1.5 (49B, free)
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

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

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

export function createNvidiaPlanner(apiKey: string, model: string): Planner {
  const client = new OpenAI({
    apiKey,
    baseURL: NVIDIA_BASE_URL,
    dangerouslyAllowBrowser: true,
  });

  return {
    label: `NVIDIA ${model}`,

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
        throw describeOpenAIError(error, "NVIDIA");
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
        throw describeOpenAIError(error, "NVIDIA");
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
