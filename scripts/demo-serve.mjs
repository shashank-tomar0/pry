#!/usr/bin/env node
/**
 * Demo fixture server — one command, no dependencies, nothing off-machine.
 *
 * WHY THIS EXISTS
 *
 * The demo used to depend on whichever way of opening `test/pages/*.html` the
 * presenter happened to remember:
 *
 *   - `file://` needs "Allow access to file URLs" toggled per extension load,
 *     and content scripts silently do nothing without it. The stage symptom is
 *     an agent that cannot see the page, which looks like a broken product.
 *   - `npx serve` downloads a package on stage, over conference wifi.
 *   - `python -m http.server` assumes Python is installed and on PATH.
 *
 * `http://localhost` matches `<all_urls>`, so content scripts always run: no
 * toggle, no install, no network. Node is already required to build.
 *
 * It also answers `/collect`, which is what makes the egress tripwire
 * demonstrable: the fixture posts a card number to a LOCAL endpoint, the
 * tripwire fires on the request before it is sent, and the bytes that reach
 * "the collector" never leave the machine. The server records the key names it
 * received and discards the values, so the walkthrough can show interception
 * without printing synthetic PII back into the terminal.
 *
 * Usage: npm run demo:serve  (PORT=9000 npm run demo:serve to move it)
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../test/pages/", import.meta.url));
// `??` is not enough here: an EMPTY PORT (exported as "" by some shells and CI
// environments) is not nullish, and Number("") is 0 — which binds a random free
// port. The printed URLs then pointed at the wrong place and the tripwire demo
// posted to a dead port, while everything looked like it had started fine.
const PORT = Number(process.env.PORT) || 8787;
const HOST = "127.0.0.1";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/** Requests seen by the local collector, newest first. Key names only. */
const collected = [];

function cors(res) {
  // The fixture may be opened from file:// as a fallback, so the collector
  // accepts cross-origin posts.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

/** Resolve a URL path inside ROOT, or null if it escapes. */
function resolvePath(urlPath) {
  const clean = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const rel = clean === "" ? "pii-fixture.html" : clean;
  const full = normalize(join(ROOT, rel));
  return full.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) ? full : null;
}

const server = createServer(async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // Exact match, not a prefix: "/collect" is a prefix of "/collected", so a
  // prefix test routed the read-back endpoint into the collector and answered
  // 204 for a page the walkthrough expects to show JSON.
  const pathname = (req.url ?? "/").split("?")[0];

  // The pretend exfiltration target. Records the shape of what arrived, never
  // the values, then discards it.
  if (pathname === "/collect") {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes <= 64 * 1024) chunks.push(chunk);
    }
    let keys = [];
    if (chunks.length > 0) {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(body);
        keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
      } catch {
        keys = ["(non-JSON body)"];
      }
    }
    collected.unshift({ at: new Date().toISOString(), method: req.method, bytes, keys });
    if (collected.length > 20) collected.length = 20;
    console.log(
      `[demo] POST /collect — ${bytes}B received, keys: ${keys.join(", ") || "(none)"} — discarded, never forwarded`,
    );
    res.writeHead(204).end();
    return;
  }

  // Read-back for the walkthrough: proves the request arrived, without echoing
  // the values.
  if (pathname === "/collected") {
    res.writeHead(200, { "content-type": CONTENT_TYPES[".json"] });
    res.end(JSON.stringify({ note: "values discarded; key names only", collected }, null, 2));
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end("Method not allowed");
    return;
  }

  const file = resolvePath(pathname);
  if (!file) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": CONTENT_TYPES[".html"] });
    res.end(
      `<h1>404</h1><p>No such fixture: ${req.url}</p>` +
        `<p>Available: <a href="/pii-fixture.html">/pii-fixture.html</a></p>`,
    );
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[demo] ${HOST}:${PORT} is already in use — something else is serving on it.\n` +
        `[demo] Start on another port: PORT=8788 npm run demo:serve`,
    );
  } else {
    console.error(`[demo] server error: ${err.message}`);
  }
  process.exit(1);
});

// Loopback only: this serves synthetic PII-shaped fixtures and a fake collector,
// and must never be reachable from the network.
server.listen(PORT, HOST, () => {
  // Report the port actually bound, not the one we asked for — a lie in this
  // line sends the presenter to the wrong URL with no error anywhere.
  const bound = server.address();
  const port = typeof bound === "object" && bound ? bound.port : PORT;
  console.log(`
[demo] PRY fixture server — http://${HOST}:${port}
[demo]   fixture page    → http://${HOST}:${port}/pii-fixture.html
[demo]   open those URLs to replay the walkthrough; synthetic values only.
[demo]   /collect is a local sink for the tripwire demo — it discards what it
[demo]   receives (key names only) and forwards nothing.
[demo] Ctrl-C to stop.
`);
});
