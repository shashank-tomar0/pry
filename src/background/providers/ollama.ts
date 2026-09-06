/**
 * Ollama Planner
 *
 * Uses Ollama's native /api/chat endpoint with:
 * - 60-second timeout per request (prevents hanging)
 * - Tool-calling fallback (retry without tools if model doesn't support them)
 * - Robust NDJSON streaming parser
 */

import type {
  ConvMessage,
  Planner,
  PlannerRequest,
  PlannerTurn,
  ToolSpec,
} from "./types";
import { PlannerError, parseArguments } from "./types";

// ─── Ollama API Types ─────────────────────────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream: boolean;
}

// ─── Message Conversion ────────────────────────────────────────────────────

function toOllamaMessages(
  system: string,
  messages: ConvMessage[],
): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const msg: OllamaMessage = {
        role: "assistant",
        content: message.text || "",
      };
      if (message.toolCalls.length > 0) {
        msg.tool_calls = message.toolCalls.map((call) => ({
          function: {
            name: call.name,
            arguments: JSON.stringify(call.input),
          },
        }));
      }
      out.push(msg);
      continue;
    }

    // Tool results → individual tool messages.
    for (const result of message.results) {
      out.push({
        role: "tool",
        content: result.isError ? `ERROR: ${result.content}` : result.content,
        tool_call_id: result.id,
      });
    }
  }

  return out;
}

function toOllamaTools(tools: ToolSpec[]): OllamaTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// ─── Streaming Parser ──────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 120_000;
const CHUNK_TIMEOUT_MS = 30_000;

async function streamChat(
  baseUrl: string,
  body: OllamaChatRequest,
  signal: AbortSignal,
  onText: (delta: string) => void,
): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Combine user abort with our timeout.
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort);

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PlannerError(
        `Ollama returned ${response.status}: ${text || response.statusText}`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new PlannerError("Ollama returned no response body.");

    let text = "";
    const partials = new Map<number, { id: string; name: string; args: string }>();
    let done = false;

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      let chunkTimer: ReturnType<typeof setTimeout> | undefined;
      while (!done) {
        // Add per-chunk timeout to detect stuck streams.
        const chunkPromise = reader.read();
        const timeoutPromise = new Promise<never>((_, reject) => {
          chunkTimer = setTimeout(() => reject(new Error("Stream chunk timeout")), CHUNK_TIMEOUT_MS);
        });

        const result = await Promise.race([chunkPromise, timeoutPromise]) as {
          value?: Uint8Array;
          done: boolean;
        };

        // Clear the timer — we got a chunk in time.
        if (chunkTimer !== undefined) clearTimeout(chunkTimer);
        chunkTimer = undefined;

        if (result.done) break;
        if (!result.value) continue;

        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          if (parsed.done) {
            done = true;
            break;
          }

          const delta = parsed.message;
          if (!delta) continue;

          if (delta.content) {
            text += delta.content;
            onText(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? partials.size;
              const existing = partials.get(index) ?? {
                id: `call_${index}`,
                name: "",
                args: "",
              };
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) {
                const rawArgs = tc.function.arguments;
                existing.args += typeof rawArgs === "object" ? JSON.stringify(rawArgs) : String(rawArgs);
              }
              partials.set(index, existing);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls = Array.from(partials.entries())
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        name: call.name,
        input: parseArguments(call.args),
      }));

    return { text, toolCalls };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

// ─── Planner Factory ───────────────────────────────────────────────────────

export function createOllamaPlanner(model: string): Planner {
  const baseUrl = "http://localhost:11434";

  return {
    label: `Ollama (Local) ${model}`,

    async run({
      system,
      messages,
      tools,
      signal,
      onText,
    }: PlannerRequest): Promise<PlannerTurn> {
      const ollamaMessages = toOllamaMessages(system, messages);

      // Try with tools first.
      let body: OllamaChatRequest = {
        model,
        messages: ollamaMessages,
        tools: toOllamaTools(tools),
        stream: true,
      };

      try {
        const result = await streamChat(baseUrl, body, signal, onText);
        return {
          text: result.text,
          toolCalls: result.toolCalls,
          stopReason: result.toolCalls.length > 0 ? "tool_use" : "end_turn",
        };
      } catch (error) {
        // If it's an abort, re-throw as-is.
        if (error instanceof Error && error.name === "AbortError") throw error;

        // If it's a PlannerError from HTTP status, check if we should retry without tools.
        if (error instanceof PlannerError) {
          const msg = error.message;

          // 403 — could be CORS or model not supporting tools. Retry without tools first.
          if (msg.includes("403")) {
            console.warn("[PRY] Ollama 403 with tools, retrying without tools.");
            try {
              const bodyNoTools: OllamaChatRequest = { ...body, tools: undefined };
              const result = await streamChat(baseUrl, bodyNoTools, signal, onText);
              return {
                text: result.text,
                toolCalls: result.toolCalls,
                stopReason: result.toolCalls.length > 0 ? "tool_use" : "end_turn",
              };
            } catch {
              // Still failing — probably a CORS issue. Show the hint.
              throw new PlannerError(
                `Ollama returned 403 Forbidden. This is likely a CORS issue.\n\n` +
                  `Fix: Stop Ollama, set env var, restart:\n` +
                  `  taskkill /F /IM ollama.exe\n` +
                  `  set OLLAMA_ORIGINS=chrome-extension://*\n` +
                  `  ollama serve`,
              );
            }
          }

          // Other HTTP errors — show with CORS hint.
          if (msg.includes("CORS")) {
            throw new PlannerError(
              `Ollama CORS error.\n\n` +
                `Fix: Stop Ollama, set env var, restart:\n` +
                `  taskkill /F /IM ollama.exe\n` +
                `  set OLLAMA_ORIGINS=chrome-extension://*\n` +
                `  ollama serve`,
            );
          }

          throw error;
        }

        // Stream timeout or connection error.
        if (error instanceof Error && error.message.includes("timeout")) {
          throw new PlannerError(
            `Ollama timed out after ${REQUEST_TIMEOUT_MS / 1000}s. ` +
              `The model "${model}" may be too slow. Try a smaller model or check if Ollama is running.`,
          );
        }

        // Connection refused.
        if (error instanceof TypeError && error.message.includes("fetch")) {
          throw new PlannerError(
            `Cannot connect to Ollama at ${baseUrl}. Is Ollama running?\n` +
              `Run: ollama serve`,
          );
        }

        throw error;
      }
    },
  };
}
