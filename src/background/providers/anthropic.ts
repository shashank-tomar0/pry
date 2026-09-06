import Anthropic from "@anthropic-ai/sdk";
import type {
  ConvMessage,
  Planner,
  PlannerRequest,
  PlannerTurn,
  StopReason,
  ToolSpec,
} from "./types";
import { PlannerError, parseArguments } from "./types";

export function toMessages(messages: ConvMessage[]): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    if (message.role === "user") {
      return { role: "user", content: message.content };
    }

    if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      // An assistant turn cannot be empty.
      if (content.length === 0) content.push({ type: "text", text: "(no output)" });
      return { role: "assistant", content };
    }

    return {
      role: "user",
      content: message.results.map(
        (result): Anthropic.ToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: result.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        }),
      ),
    };
  });
}

function toTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));
}

function toStopReason(raw: string | null): StopReason {
  if (raw === "tool_use") return "tool_use";
  if (raw === "max_tokens") return "max_tokens";
  if (raw === "refusal") return "refusal";
  return "end_turn";
}

export function createAnthropicPlanner(apiKey: string, model: string): Planner {
  const client = new Anthropic({
    apiKey,
    // The extension is the client; there is no server of ours to proxy through.
    dangerouslyAllowBrowser: true,
  });

  return {
    label: `Anthropic ${model}`,

    async run({ system, messages, tools, signal, onText }: PlannerRequest): Promise<PlannerTurn> {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 8000,
          system,
          tools: toTools(tools),
          messages: toMessages(messages),
        },
        { signal },
      );

      stream.on("text", onText);

      let response: Anthropic.Message;
      try {
        response = await stream.finalMessage();
      } catch (error) {
        throw describe(error);
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      const toolCalls = response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: parseArguments(block.input),
        }));

      return {
        text,
        toolCalls,
        stopReason: toStopReason(response.stop_reason),
        refusal:
          response.stop_reason === "refusal"
            ? (response.stop_details?.category ?? "unspecified")
            : undefined,
      };
    },
  };
}

function describe(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new PlannerError("Anthropic rejected your API key. Check it in the extension options.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new PlannerError("Anthropic rate-limited this request. Wait a moment and retry.");
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new PlannerError(
      "Anthropic does not recognise that model id. Pick another one in the extension options.",
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new PlannerError(`Anthropic API error ${error.status}: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
