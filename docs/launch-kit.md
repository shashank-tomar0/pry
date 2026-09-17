# Launch Kit — PRY Team Local Setup

This document keeps the "run PRY locally, validate every capability, and never let
the docs drift off what was actually proven" checklist ground-truthed. It is prose
because it ages better than a script.

## Prerequisites

- Node 20+
- Chrome/Chromium with developer mode enabled (or any Chromium-based browser that
  will load unpacked extensions)
- ElevenLabs API key (`sk_…`)
- NVIDIA API key (`nvapi-…`) — or another LLM provider in the options
- HuggingFace token (`hf_…`) — optional for local dev; used to pull models from
  gated repos or when the NER checkpoint is large

## Project layout

- `src/` — the extension source
- `dist/` — built extension output (load this, not `src/`)
- `scripts/` — fetch + evaluation scripts
- `docs/` — launcher kit + audit notes (this document)
- `docs/launch-kit.md` — this file

## Build, test, evaluate

```bash
npm i                 # once
npm run build         # every time src/ changes
npm run verify        # the assertion suite; keep it green before demo
node scripts/eval-ner.mjs   # real-weights proof the bundled NER extracts names
node scripts/eval-guard.mjs # honest state of any guard checkpoint; greets nothing when no model is bundled
node scripts/ocr-test.mjs   # real Tesseract on rendered images: word boxes + frame-text triage
```

Load `dist/` as an unpacked extension, reload the extension, then verify the
Scribe dictation button, the first planner turn against an LLM provider, and the
self-test line all report healthy. Clear site data between runs that should see a
fresh bundle.

## Ship the downloadable build

```bash
npm run verify && npm run build   # green first
node scripts/package.mjs          # writes publish/pry-agent-1.0.0.zip (~125 MB)
gh release create v1.0.0 publish/pry-agent-1.0.0.zip --title "PRY 1.0.0" --notes "..."
```

The landing page's download button links to
`…/releases/latest/download/pry-agent-1.0.0.zip`, so the asset filename must stay
`pry-agent-1.0.0.zip`. Two rules keep this honest:

1. **Never commit the zip.** The full build is ~125 MB, over GitHub's 100 MB
   per-file limit — a push would be rejected — and a committed copy decays
   silently. That is exactly what happened before: the button served a 26-entry
   zip with no NER weights, no BlazeFace, no MediaPipe WASM and no ONNX Runtime,
   so a download had no on-device ML at all while the README described it.
   `publish/*.zip`, `landing/*.zip` and the root zip are gitignored; untrack them
   again with `git ls-files | grep '\.zip$'` if they ever reappear.
2. **Verify the artifact you are about to upload**, rather than trusting its
   name: the archive should list 80 entries and contain
   `models/ner/onnx/model_quantized.onnx` and
   `models/blazeface/face_detection_short_range.tflite`. Testing locally? Load
   `dist/` unpacked instead — that is always current.

## Keys for local testing (rotate after — never committed)

These API keys were used to prove the feature set end-to-end. The verifier must
pass with the elevenlabs key active for telemetry to be green. Rotate them before
any public release; never paste them back into version control.

- ElevenLabs: `<ELEVENLABS_KEY — see your password manager, rotate after testing>`
  (token mint returns `200`; STT dictation is live; TTS needs a premade voice on the
   free tier)
- NVIDIA: `<NVIDIA_KEY — see your password manager, rotate after testing>`
  (tool-calling verified — cold first turn ~55 s, warm ~3-7 s)
- HuggingFace: `<HF_TOKEN — see your password manager, rotate after testing>`
  (used to pull the NER weights and to score a guard/model candidate)

### ElevenLabs detail

The elevenlabs key is used for elevenlabs speech to text (STT) and elevenlabs tts (TTS).
STT is the dictation / voice-input path. TTS is the verbal-audit / spoken-narration
path.

After testing, rotate all three. Even though they are demonstration tokens, they
should not stay in any long-lived channel.

## Feature audit (proof column is live; notes column is current state)

Re-validate the full demo checklist end-to-end with the elevenlabs key active
before the next demo. The STT keyword is the honest probe: when scribe
eventually produces a transcript — or, on mute, when the button is
release-committed — that is the moment scribe becomes live if the token mint
worked.

| Capability | Proof | Notes |
|------------|-------|-------|
| Scribe hold-to-talk STT | Token mint returns `200` with a working key; the dictation button appears and produces a final transcript when committed | FreeScreeps is the path that piggybacks on the Scribe pipeline; the audio capture path is wired through the Scribe helper |
| On-device NER (token-classification) | `node scripts/eval-ner.mjs` passes against the real weights — whole spans come out without fragments | The model loads from `models/ner/`, does real inference, and the self-test now lists what it would actually redact |
| Vision pipeline (if enabled) | Vision provider reachable; the screenshot path calls it | Validate with a task that depends on seeing the redacted screenshot |
| Scribe token mint for real-time STT | Mint endpoint returns `200` and the token is accepted | The “Scribe Token Mint” step is what powers the FreeScreeps dictation |
| Offscreen document ML bridge | ML bridge + offscreen document plumbing verified end-to-end in `npm run verify` | Where the V2 offscreen wizardry lives; keep it in the verify suite |
| ElevenLabs TTS verbal-audit narration | Free-tier premade voice reachable; the narration path produces samples | Validates with a read-page narration when TTS is enabled |
| On-device ML (Tier 0): BlazeFace, NER, injection guard | Self-test lists which Tier-0 models are loaded; verify suite asserts bridge + offscreen plumbing | The self-test is the honest “is the brain working?” line |
| Egress meter / wirelog / tripwire | Wirelog + tripwire aggregator verified in `npm run verify` (every outbound request and PII leak shape is audited) | Prerequisites for the “live egress tripwire radar” demo |
| Privacy ledger + audit screenshots | Privacy ledger verified in `npm run verify`; the detected-vs-boxed reconciliation and OCR triage policy are pinned in Scenario AL/AM | "Regions Redacted" counts painted pixel regions; the transcript's text-channel line counts tokenized/replaced values — two channels, two meanings. A detected value that could not be located on screen is reported (masked), never silently assumed covered |
| Acting on rows with no element id (`click_text`) | Scenario AN pins the matcher, the tool's exposure to the planner, its routing to the page, and the safety gate (blind click refused, irreversible text still confirmed) | The Gmail run failed here: 80 element slots went to sidebar/toolbar/tabs, so no message row was in the page read and the planner re-read until the loop guard fired. Rows, results, cards and menu entries are now clickable by their visible text; the first loop detection injects that advice instead of ending the run |
| Text inside images / canvas / video (OCR triage) | `node scripts/ocr-test.mjs` proves real Tesseract returns per-word boxes for an email rendered into an image, and that boxing them hides it from a re-read (6 OCR assertions) | On by default (`privacy.scanFrameText`). Runs on the already-redacted frame, so it can only find what no other channel covered. Costs one local OCR pass per capture; a very tall frame is triaged over at most 6 slices and reports PARTIAL rather than implying full coverage |

### Scribe lifecycle states (free-tier, with a working key)

These are the visible states the STT path can be in when the elevenlabs key is
active and STT is enabled.

| State | What it means | When it is healthy |
|-------|---------------|---------------------|
| `idle` | No Scribe session is open | Normal when muted |
| `connecting` | Mic open, socket connecting, waiting on the token mint | Brief; moves to `listening` quickly when the mint succeeds |
| `listening` | Frames are being pushed to the open socket | Healthy when frames are flowing |
| `error` | Something failed (401 key, bad network, token mint rejected, session closed) | Transient if it then recovers |
| `commit` | Muted token commit sent | Should produce a final transcript |

The STT keyword `scribe eventually produces a transcript` is the true probe:
it only becomes live when the token mint actually worked. On a mute, the
releases still speak in the footer as `release` commits — the mute mechanic is
independent of the token mint success.

## OpenRouter + alternative LLM provider notes

Use the standard OpenAI-compatible provider shapes for LLM planner providers.
If a provider is wired as OpenAI-compatible, the OpenAI SDK client can be reused;
only the base URL and auth header differ. The plan in the v2-dev log is to unify
the LLM provider helpers around a shared OpenAI-compatible client where they
already speak that protocol.

| Provider | Shape expected by the helper | Model id example |
|----------|-----------------------------|------------------|
| NVIDIA NIM | `{ model, messages, tools, stream, max_tokens }` via OpenAI SDK client | `nvidia/nemotron-3.5-lightning-30b-a3b` |
| Anthropic | system + history messages via Anthropic SDK | the model selected in options |
| OpenAI | messages + tools via OpenAI SDK | the model selected in options |
| OpenRouter | messages + tools with `Authorization: Bearer …` for OpenRouter | the model selected in options |
| Ollama | local, no key needed; messages + tools via the Ollama SDK | the model selected in options |

## Security notes

- Never commit keys. The release build must not ship key material in the bundle.
- The elevenlabs key is used for elevenlabs speech to text (STT) and elevenlabs tts (TTS). It is active only during local testing; rotate it away before a public release.
- Rotate rotated keys promptly; the demo keys above are demonstration tokens only.
- The HuggingFace token is used only by `scripts/fetch-models.mjs` and `scripts/eval-guard.mjs`; if those scripts run as part of a CI gate, keep the token out of the artifact.
- Never paste key material back into version control.
