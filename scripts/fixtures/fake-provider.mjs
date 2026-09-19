/**
 * A fake OpenAI-compatible endpoint that can be told to misbehave.
 *
 * WHY AN ENDPOINT AND NOT ANOTHER STUB PLANNER
 *
 * Every other fault in the run's wait policy can be produced by a stub planner,
 * because a stub can lie about its own timings. The faults this file exists for
 * cannot: "the endpoint never sent response headers", "it accepted the request
 * and then sent no body" and "the socket died mid-answer" are all facts about the
 * TRANSPORT, and the run reads them from where they actually happen — the
 * `fetch` boundary inside the adapter (PlannerMilestone) and the throws that come
 * out of it. A stub claiming `headers: never` tests the policy's arithmetic; only
 * a real socket tests that the adapter observes and reports the thing the policy
 * acts on.
 *
 * So this speaks just enough of `POST /v1/chat/completions` with `stream: true`
 * for the real OpenAI-compatible adapter to parse it, and each `mode` is one way
 * a real endpoint is observed to fail:
 *
 *   ok      answer normally (the control)
 *   queue   accept the request, then hold it before the first token
 *   stall   accept the request (headers out), then send no body at all
 *   drop    stream a couple of deltas, then destroy the socket mid-answer
 *   deaf    never acknowledge the request at all — no response headers, ever
 *
 * `modes` maps a model id to a mode, or to an array of modes applied per request
 * to that model (so "the first turn works and the second one stalls" is data).
 * Every request is recorded, which is how a test proves WHICH model an endpoint
 * was asked for — the difference between a run that re-routed and one that only
 * said it did.
 */
import { createServer } from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Turn scripts: a tool-call turn, then a final answer. */
export const DEFAULT_TURNS = [
  { text: "", toolCall: { name: "read_page", args: {} } },
  { text: "The page says: Example Domain.", toolCall: null },
];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/**
 * Start the endpoint. Returns the base URL to hand to an adapter, the request
 * log, and a close that also tears down sockets a mode deliberately left open.
 */
export async function startFakeProvider({
  /** model id → mode, or an array of modes consumed one per request. */
  modes = {},
  /** Used for any model with no entry. */
  defaultMode = "ok",
  /** How long `queue` holds the request before the first token. */
  queueMs = 1_200,
  /** How long `drop` streams before destroying the socket. */
  dropMs = 60,
  turns = DEFAULT_TURNS,
} = {}) {
  /** Every request the endpoint was asked to answer, oldest first. */
  const requests = [];

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // A malformed body is not what these modes are about; the model id is
      // then empty, which falls through to `defaultMode`.
    }
    const model = String(body?.model ?? "");
    const seen = requests.filter((r) => r.model === model).length;
    const spec = modes[model] ?? defaultMode;
    const mode = Array.isArray(spec) ? spec[Math.min(seen, spec.length - 1)] : spec;
    requests.push({ model, mode, at: Date.now(), body });

    const id = `chatcmpl-fake-${requests.length}`;
    const send = (delta, finishReason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    const done = () => res.write("data: [DONE]\n\n");

    // ─── The failures, in the order the transport sees them ───
    if (mode === "deaf") {
      // No writeHead, no headers, no body. A client sees a request that was
      // made and never acknowledged — indistinguishable from a stalled socket
      // or a provider holding it, which is the point.
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Headers out NOW, before any body: this is the boundary the adapter
    // reports, and a mode that delayed it would be testing something else.
    res.flushHeaders();

    if (mode === "stall") {
      // Accepted, then silent. The socket stays open and healthy, so nothing
      // below this line ever runs and the client cannot tell this from a model
      // that is thinking.
      return;
    }

    if (mode === "queue") {
      await sleep(queueMs);
    }

    if (mode === "drop") {
      send({ role: "assistant", content: "Reading" });
      await sleep(dropMs);
      send({ role: "assistant", content: " the page" });
      await sleep(dropMs);
      // Mid-answer, with no finish_reason and no [DONE]: what a dropped
      // connection looks like to the reader that was still awaiting it.
      res.socket?.destroy();
      return;
    }

    // ─── ok / queue: the scripted turn, streamed ───
    const turn = turns[Math.min(seen, turns.length - 1)];
    if (turn.toolCall) {
      send({
        role: "assistant",
        content: turn.text || null,
        tool_calls: [
          {
            index: 0,
            id: `call_${requests.length}`,
            type: "function",
            function: { name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.args ?? {}) },
          },
        ],
      });
      send({}, "tool_calls");
    } else {
      for (const word of turn.text.split(/(?<=\s)/)) {
        send({ role: "assistant", content: word });
        await sleep(2);
      }
      send({}, "stop");
    }
    done();
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    /** Model ids asked for, in order — the record of who answered what. */
    models: () => requests.map((r) => r.model),
    close: async () => {
      // A mode may have left a socket open on purpose; close() must not wait
      // for a client that is never going to get an answer.
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
