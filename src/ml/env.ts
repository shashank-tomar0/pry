/**
 * transformers.js environment for the extension.
 *
 * Every model is served from the package itself (dist/models, vendored by
 * scripts/fetch-models.mjs + build.mjs). No remote fetch is ever attempted —
 * the "nothing leaves except what you approved" claim extends to the model
 * files. ONNX Runtime's wasm binaries are vendored alongside.
 *
 * Called once from the offscreen document before any pipeline is created.
 */

import { env } from "@huggingface/transformers";

let configured = false;

export function configureMlEnv(): void {
  if (configured) return;
  configured = true;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = chrome.runtime.getURL("models/");
  // onnxruntime-web resolves its .wasm/.mjs relatives from this directory
  // (vendored from node_modules by build.mjs).
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/");
  }
}
