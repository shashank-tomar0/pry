import type { ProviderId } from "../background/providers/types";
import type { Settings } from "../shared/types";
import { normaliseSettings } from "../shared/types";
import { PROVIDERS, PROVIDER_IDS, listModels } from "../shared/models";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// ─── DOM References ────────────────────────────────────────────────────────

const providerList = $("provider-list");
const apiKeyEl = $<HTMLInputElement>("apiKey");
const modelEl = $<HTMLInputElement>("model");
const modelList = $<HTMLDataListElement>("model-list");
const modelStatus = $("model-status");
const maxStepsEl = $<HTMLInputElement>("maxSteps");
const confirmRiskyEl = $<HTMLInputElement>("confirmRisky");

// ElevenLabs voice (hack branch).
const elApiKeyEl = $<HTMLInputElement>("elevenlabs-api-key");
const elVoiceIdEl = $<HTMLInputElement>("elevenlabs-voice-id");
const elSttEl = $<HTMLInputElement>("elevenlabs-stt-enabled");
const elTtsEl = $<HTMLInputElement>("elevenlabs-tts-enabled");

// On-device ML (Tier 0).
const mlNerEl = $<HTMLInputElement>("ml-ner");
const mlGuardEl = $<HTMLInputElement>("ml-guard");
const refreshBtn = $<HTMLButtonElement>("refresh-models");
const savedEl = $("saved");
const activeModelDisplay = $("active-model-display");
const activeProviderBadge = $("active-provider-badge");

// Privacy elements
const blurFacesEl = $<HTMLInputElement>("blurFaces");
const maskCredentialsEl = $<HTMLInputElement>("maskCredentials");
const tokenizePIIEl = $<HTMLInputElement>("tokenizePII");
const showRedactionLabelsEl = $<HTMLInputElement>("showRedactionLabels");

// Vision elements
const visionEnabledEl = $<HTMLInputElement>("visionEnabled");
const visionModelEl = $<HTMLInputElement>("visionModel");

// ─── State ─────────────────────────────────────────────────────────────────

let settings: Settings = normaliseSettings(undefined);
const fetched = new Map<ProviderId, string[]>();

// ─── Provider List Rendering ───────────────────────────────────────────────

function renderProviderList(): void {
  providerList.innerHTML = "";

  for (const id of PROVIDER_IDS) {
    const info = PROVIDERS[id];
    const isActive = settings.provider === id;
    const hasKey = Boolean(settings.apiKeys[id]);

    const item = document.createElement("div");
    item.className = `provider-item ${isActive ? "active" : ""}`;
    item.innerHTML = `
      <div class="provider-radio"></div>
      <div class="provider-info">
        <div class="provider-name">${info.label}</div>
        <div class="provider-model">${settings.models[id] ?? info.defaultModel}</div>
      </div>
      <div class="provider-badge ${hasKey ? "enabled" : "disabled"}">${hasKey ? "ENABLED" : "DISABLED"}</div>
    `;

    item.addEventListener("click", () => {
      captureFields();
      settings.provider = id;
      renderAll();
    });

    providerList.appendChild(item);
  }
}

// ─── Full Render ───────────────────────────────────────────────────────────

function renderAll(): void {
  const provider = PROVIDERS[settings.provider];

  // Active planner display.
  activeModelDisplay.textContent = `${settings.models[settings.provider] ?? provider.defaultModel}`;
  activeProviderBadge.textContent = provider.label.toUpperCase();

  // Provider list.
  renderProviderList();

  // Show/hide Ollama test button.
  updateTestButton();

  // API key & model.
  apiKeyEl.value = settings.apiKeys[settings.provider] ?? "";
  apiKeyEl.placeholder = provider.keyHint;
  modelEl.value = settings.models[settings.provider] ?? provider.defaultModel;

  // Ollama needs no API key — hide the key section.
  const apiKeySection = apiKeyEl.closest(".section");
  if (apiKeySection) {
    (apiKeySection as HTMLElement).style.display = settings.provider === "ollama" ? "none" : "";
  }

  // Hint.
  const hint = $("provider-hint");
  if (settings.provider === "ollama") {
    hint.innerHTML = `No key needed — Ollama runs on <a href="http://localhost:11434" target="_blank" style="color: var(--color-teal);">localhost:11434</a>. Pull a model: <code>ollama pull qwen2.5:1.5b</code>`;
  } else {
    hint.innerHTML = `Get a key at <a href="${provider.keyUrl}" target="_blank" style="color: var(--accent);">${new URL(provider.keyUrl).host}</a>.`;
  }

  // Agent config.
  maxStepsEl.value = String(settings.maxSteps);
  confirmRiskyEl.checked = settings.confirmRisky;

  // ElevenLabs voice.
  elApiKeyEl.value = settings.elevenlabs.apiKey;
  elVoiceIdEl.value = settings.elevenlabs.voiceId;
  elSttEl.checked = settings.elevenlabs.sttEnabled;
  elTtsEl.checked = settings.elevenlabs.ttsEnabled;

  // On-device ML.
  mlNerEl.checked = settings.ml.ner;
  mlGuardEl.checked = settings.ml.guard;

  // Privacy.
  blurFacesEl.checked = settings.privacy.blurFaces;
  maskCredentialsEl.checked = settings.privacy.maskCredentials;
  tokenizePIIEl.checked = settings.privacy.tokenizePII;
  showRedactionLabelsEl.checked = settings.privacy.showRedactionLabels;

  // Vision.
  visionEnabledEl.checked = settings.vision.enabled;
  visionModelEl.value = settings.vision.model;

  // Model datalist.
  renderModelOptions();
}

function renderModelOptions(): void {
  const provider = PROVIDERS[settings.provider];
  // A fetched-but-empty list must fall back to the bundled suggestions:
  // `[] ?? suggested` would render NO models (an empty array is truthy).
  const fetchedList = fetched.get(settings.provider);
  const options = fetchedList && fetchedList.length > 0 ? fetchedList : provider.suggested;
  modelList.innerHTML = "";
  for (const id of options) {
    const option = document.createElement("option");
    option.value = id;
    modelList.appendChild(option);
  }
}

// ─── Capture Fields ────────────────────────────────────────────────────────

function captureFields(): void {
  settings.apiKeys[settings.provider] = apiKeyEl.value.trim();
  settings.models[settings.provider] = modelEl.value.trim();
  settings.vision.enabled = visionEnabledEl.checked;
  settings.vision.model = visionModelEl.value.trim();
  settings.privacy.blurFaces = blurFacesEl.checked;
  settings.privacy.maskCredentials = maskCredentialsEl.checked;
  settings.privacy.tokenizePII = tokenizePIIEl.checked;
  settings.privacy.showRedactionLabels = showRedactionLabelsEl.checked;
}

// ─── Event Listeners ───────────────────────────────────────────────────────

refreshBtn.addEventListener("click", async () => {
  const provider = settings.provider;
  refreshBtn.disabled = true;
  modelStatus.textContent = "Fetching…";
  modelStatus.className = "status-msg";

  try {
    const models = await listModels(provider, apiKeyEl.value.trim());
    if (models.length === 0) {
      throw new Error("Provider returned no chat models — showing bundled suggestions.");
    }
    fetched.set(provider, models);
    renderModelOptions();
    modelStatus.textContent = `${models.length} models available.`;
    modelStatus.className = "status-msg ok";
  } catch (error) {
    modelStatus.textContent = error instanceof Error ? error.message : "Could not fetch models.";
    modelStatus.className = "status-msg bad";
  } finally {
    refreshBtn.disabled = false;
  }
});

// ─── Test Ollama Connection ────────────────────────────────────────────────

const testOllamaBtn = $("test-ollama") as HTMLButtonElement;
const ollamaTestResult = $("ollama-test-result");

testOllamaBtn.addEventListener("click", async () => {
  testOllamaBtn.disabled = true;
  ollamaTestResult.style.display = "block";
  ollamaTestResult.textContent = "Testing connection to localhost:11434...";
  ollamaTestResult.className = "status-msg";

  try {
    // Step 1: Test if Ollama is reachable.
    const tagsResponse = await fetch("http://localhost:11434/api/tags");
    if (!tagsResponse.ok) {
      throw new Error(`Ollama returned ${tagsResponse.status} on /api/tags`);
    }
    const tags = await tagsResponse.json() as { models?: { name: string }[] };
    const models = tags.models ?? [];
    ollamaTestResult.textContent = `✓ Ollama is running. ${models.length} model(s): ${models.map(m => m.name).join(", ")}`;
    ollamaTestResult.className = "status-msg ok";

    // Step 2: Test chat endpoint (the one the extension uses).
    try {
      const chatResponse = await fetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: models[0]?.name ?? "qwen2.5:1.5b",
          messages: [{ role: "user", content: "Say hi" }],
          stream: false,
        }),
      });

      if (chatResponse.status === 403) {
        ollamaTestResult.innerHTML =
          `⚠ Ollama is running but returned <b>403 Forbidden</b> on /api/chat.<br><br>` +
          `<b>Fix:</b> Stop Ollama, set the CORS env var, then restart:<br>` +
          `<code style="display:block;padding:8px;margin-top:6px;background:var(--color-paper-2);border:1px solid var(--color-ink);">` +
          `taskkill /F /IM ollama.exe<br>` +
          `set OLLAMA_ORIGINS=chrome-extension://*<br>` +
          `ollama serve</code>`;
        ollamaTestResult.className = "status-msg bad";
      } else if (chatResponse.ok) {
        ollamaTestResult.textContent = `✓ Full connection test passed. Ollama is ready to use!`;
        ollamaTestResult.className = "status-msg ok";
      } else {
        ollamaTestResult.textContent = `⚠ Chat endpoint returned ${chatResponse.status}. Ollama may need to be updated.`;
        ollamaTestResult.className = "status-msg bad";
      }
    } catch {
      // Chat endpoint might have CORS issues even if tags works.
      ollamaTestResult.innerHTML =
        `⚠ Cannot reach /api/chat. This is likely a CORS issue.<br><br>` +
        `<b>Fix:</b> Stop Ollama, set the CORS env var, then restart:<br>` +
        `<code style="display:block;padding:8px;margin-top:6px;background:var(--color-paper-2);border:1px solid var(--color-ink);">` +
        `taskkill /F /IM ollama.exe<br>` +
        `set OLLAMA_ORIGINS=chrome-extension://*<br>` +
        `ollama serve</code>`;
      ollamaTestResult.className = "status-msg bad";
    }
  } catch (error) {
    ollamaTestResult.innerHTML =
      `✗ Cannot connect to Ollama at localhost:11434.<br><br>` +
      `<b>Make sure Ollama is running:</b><br>` +
      `<code style="display:block;padding:8px;margin-top:6px;background:var(--color-paper-2);border:1px solid var(--color-ink);">` +
      `ollama serve</code>`;
    ollamaTestResult.className = "status-msg bad";
  } finally {
    testOllamaBtn.disabled = false;
  }
});

// Show/hide test button based on provider selection.
function updateTestButton(): void {
  testOllamaBtn.style.display = settings.provider === "ollama" ? "" : "none";
}

$("save").addEventListener("click", async () => {
  captureFields();
  settings.maxSteps = Math.min(200, Math.max(5, Number(maxStepsEl.value) || 40));
  settings.confirmRisky = confirmRiskyEl.checked;

  // ElevenLabs: enabling either voice feature without a key is silently
  // a no-op (the side panel checks the flag + key together), but warn so
  // users know nothing will happen.
  settings.elevenlabs.apiKey = elApiKeyEl.value.trim();
  settings.elevenlabs.voiceId = elVoiceIdEl.value.trim() || "21m00Tcm4TlvDq8ikWAM";
  settings.elevenlabs.sttEnabled = elSttEl.checked;
  settings.elevenlabs.ttsEnabled = elTtsEl.checked;
  settings.ml.ner = mlNerEl.checked;
  settings.ml.guard = mlGuardEl.checked;
  if ((settings.elevenlabs.sttEnabled || settings.elevenlabs.ttsEnabled)
      && !settings.elevenlabs.apiKey) {
    savedEl.className = "status-msg bad";
    savedEl.textContent = "ElevenLabs voice is enabled but no API key was provided.";
    return;
  }

  // Ollama needs no API key.
  if (!settings.apiKeys[settings.provider] && settings.provider !== "ollama") {
    savedEl.className = "status-msg bad";
    savedEl.textContent = `Add a ${PROVIDERS[settings.provider].label} key before saving.`;
    return;
  }

  await chrome.storage.local.set({ settings });
  savedEl.className = "status-msg ok";
  savedEl.textContent = "✓ SAVED";
  setTimeout(() => (savedEl.textContent = ""), 2000);
});

$("close").addEventListener("click", () => window.close());

// ─── Initialize ────────────────────────────────────────────────────────────

void (async () => {
  const stored = await chrome.storage.local.get("settings");
  settings = normaliseSettings(stored.settings);
  renderAll();
})();
