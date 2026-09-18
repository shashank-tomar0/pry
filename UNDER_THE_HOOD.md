# PRY Under the Hood

*Everything the project does, how it does it, which model does what, and what every
term means. Written to be read top to bottom; §16 is the dictionary if you only want
the vocabulary. Every number here is a constant in the code, named so you can find
it. Nothing in this file describes behaviour the code does not have — where the
project has a known gap, the gap is written down.*

Companion files: `PROJECT_EXPLAINED.md` (plain-words overview, read that first if
this feels heavy), `README.md` (the formal version with derivations and the full
threat model).

---

## 1. The one-paragraph summary

PRY is a Manifest V3 Chrome extension. Four JavaScript contexts cooperate:
a **content script** inside the page reads the DOM, a **service worker** runs the
agent loop and owns all the secrets, an **offscreen document** does every pixel
operation, and a **side panel** is the UI. A user types a task; the task text, the
page text and every screenshot are sanitized in-browser *before* any network call.
A remote LLM (the "planner") then chooses tool calls from that sanitized view, the
content script executes them, and the cycle repeats until the task ends. Everything
that happened is recorded in a hash-chained ledger, and every byte that left is
counted.

---

## 2. Every model, and where it runs

Two of the five never leave your machine, and they are the two that see raw data.

| # | Model | File / id | Runs in | Job | Default |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **BlazeFace short-range** (MediaPipe, TFLite) | `models/blazeface/face_detection_short_range.tflite` — ~224 KB | Offscreen document, `@mediapipe/tasks-vision` with `delegate: "GPU"` (WebGPU), WebAssembly SIMD fallback | Finds faces: over the whole frame, over ≤16 native-resolution tiles, and over ≤8 targeted probes | On, always |
| 2 | **Quantized BERT NER** | `models/ner/onnx/model_quantized.onnx` — ~104-108 MB, 8-bit (`dslim/bert-base-NER`) | Offscreen document, ONNX Runtime Web via `@huggingface/transformers`, Wasm SIMD multi-thread | Finds person names, organisations and places in page prose — the things no regex can find | On (`ml.ner`) |
| 3 | **Injection guard** (also BERT-class) | expected at `models/guard/onnx/model_quantized.onnx` — **not bundled** | Offscreen document | Would classify "text on the page that is addressed to an AI agent" | Wired up, checkbox on, but the file is absent, so the regex heuristic runs instead and the transcript says so |
| 4 | **Tesseract.js LSTM** | `tesseract.js` + `@tesseract.js-data/eng`, loaded from bundled `dist/vendor` | Offscreen document, WebAssembly | Two jobs: (a) *frame-text triage* — read the already-redacted frame and black-box any PII still legible; (b) *adversarial verification* — re-read the exact bytes that will ship and prove the redactions hold | Always for verification; triage only when `privacy.scanFrameText` is on (default **off**) |
| 5 | **The planner** (remote LLM) | provider-configurable. Shipped default `nvidia/nemotron-3.5-lightning-30b-a3b` via NVIDIA NIM | Remote API | Reads the sanitized page + task, returns structured tool calls | Needs a key; extension default provider is Ollama (local) |

### 2.1 Which planner model is actually used

`settings.provider` + `settings.models[provider]`, resolved in one place
(`src/background/providers/index.ts#createPlanner`), so every consumer — the run,
the lesson generator, the vision pass — gets the same model, and the panel prints
`Using <provider> <model>` on every run.

| Provider | Default model | "Fast planner mode" model (`fastPlanner: true`) |
| :--- | :--- | :--- |
| `ollama` (local, extension default) | `qwen2.5:1.5b` | `qwen2.5:3b` |
| `nvidia` (NVIDIA NIM) | `nvidia/nemotron-3.5-lightning-30b-a3b` | `meta/llama-3.1-8b-instruct` |
| `groq` | `openai/gpt-oss-20b` | `openai/gpt-oss-20b` |
| `anthropic` | `claude-opus-5` | `claude-haiku-4-5` |
| `openai` | `gpt-5.5` | `gpt-5.4-mini` |
| `openrouter` | `anthropic/claude-opus-5` | `openai/gpt-5.5` |

**The `nemotron` model in your screenshots is a reasoning model.** It streams its
chain-of-thought before any visible words, which is why the panel can say "waiting
for the planner — no tokens yet" for 20 seconds while the server is genuinely
working, and why per-turn latency is dominated by the provider rather than by
anything local. `fastPlanner` exists exactly for that trade: the provider's plainest
instruct model, faster first token, worse planning, stated as a trade rather than a
promise.

### 2.2 Optional vision (VLM) model

When `vision.enabled` is on, the **redacted** frame is sent to a vision-capable
model on the same provider key, and its text description is appended to the tool
result. `vision.model` empty means "that provider's default"
(`VISION_DEFAULT_MODELS` in `src/background/vision.ts`). The call has a 20 s
timeout (`VISION_TIMEOUT_MS`), the page context is truncated to 6 000 chars, its
returned bytes are counted into the egress badge, and — the important part — the
frame only leaves if `screenshotSendDecision()` says it may (§11).

### 2.3 Voice models (both remote, both off by default)

| Direction | Service | Wire details |
| :--- | :--- | :--- |
| Speech → text | ElevenLabs Scribe Realtime, model `scribe_v2_realtime` | The panel first POSTs `/v1/single-use-token/realtime_scribe` to mint a one-use token (the raw key is never put in a WebSocket URL), then opens `wss://api.elevenlabs.io/v1/speech-to-text/realtime` with `sample_rate=16000`. Audio is 16 kHz mono PCM16, sent as base64 chunks with `commit: false`, and the send is a final empty chunk with `commit: true` |
| Text → speech | ElevenLabs, model Flash v2.5 (`ttsRequestBody`) | `POST /v1/text-to-speech/{voice_id}/stream`, header `xi-api-key`, output format `pcm_16000` (16 kHz mono PCM), played back by the PCM→float converter. Default voice id `SAz9YHcvj6GT2YYXdXww` ("River"), a *premade* voice because library voices need a paid plan and fail with `402 paid_plan_required` |

---

## 3. What the extension ships set to (defaults)

From `DEFAULT_SETTINGS` (`src/shared/types.ts`):

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| `provider` | `ollama` | Local model, no key needed, nothing leaves the machine |
| `maxSteps` | 40 | Hard ceiling on planner turns |
| `confirmRisky` | `true` | Ask before irreversible-looking clicks/types |
| `fullPageCapture` | `false` | Scroll-and-stitch the whole page instead of the viewport |
| `fastPlanner` | `false` | Prefer the provider's plainest model |
| `vision.enabled` | `false` | No frame is described by a VLM unless you turn it on |
| `privacy.destroyFaces` | `true` | Faces overwritten with opaque black |
| `privacy.maskCredentials` | `true` | Credential fields cleared and repainted with synthetic values |
| `privacy.tokenizePII` | `true` | DOM values replaced by vault tokens for the planner |
| `privacy.showRedactionLabels` | `false` | Draw labels on the redacted image (demo mode) |
| `privacy.scanFrameText` | `false` | The Tesseract triage pass over the frame. Costs one OCR pass per capture |
| `elevenlabs.sttEnabled` / `ttsEnabled` | `false` | Voice is opt-in |
| `ml.ner` / `ml.guard` | `true` / `true` | On-device models; each degrades to its non-ML path if the file is missing |

**Note the combined default:** with `scanFrameText` off, text baked into images is
*not* searched for by default. Screenshot verification of redacted regions always
runs — that is a different pass and it is not optional.

---

## 4. How the four contexts talk to each other

All cross-context traffic is `chrome.runtime` messages with typed shapes
(`ContentRequest` in `src/shared/types.ts`). This is the complete set:

| Message | From → To | What it does |
| :--- | :--- | :--- |
| `snapshot` | Service worker → content | Read the page: URL, title, text, ≤80 interactive elements, sensitive regions, DPR, scroll |
| `act` | Service worker → content | Run one action (`click`, `type`, `scroll`, `key`, `select`, `click_text`, …) |
| `capture-screenshot` / `capture-and-act` | Service worker → content | Take the pixels (and optionally act first), so the capture and the action describe the same moment |
| `get-sensitive-regions` | Service worker → content | Coordinates of sensitive fields and values, plus a `failure` field when collection did not complete |
| `locate-spans` | Service worker → content | Given values, return the boxes of the rendered text nodes that contain them |
| `locate-elements` | Service worker → content | Boxes of detector *targets* that have no text node (aria-label, title, value), each echoing the value it was drawn for |
| `fullpage-begin` / `-scroll` / `-restore` | Service worker → content | Scroll, capture, stitch, restore, with sticky elements hidden while scrolling |
| `process-screenshot` | Service worker → offscreen | The frame + regions + privacy toggles + the values that could not be placed |
| `screenshot-processed` | Offscreen → service worker | The processed frame, its detections, its `stages` timings, its protection evidence, and whether a shipped frame may leave |
| `ml-ner` / `ml-guard` / `ml-self-test` / `warm-ocr` | Service worker → offscreen | On-device inference, the opening self-test, and warming Tesseract before the first capture |
| `privacy-audit` / `get-audit` / `ledger-*` | Service worker ↔ side panel | Live audit events and the pull that renders the audit card |

Everything is bounded: each round trip has a timeout, and a timeout is reported as a
failure with a reason, never as an empty success.

---

## 5. Under the hood: the agent loop

One run is `runTask(task, tabId, deps)` in `src/background/agent.ts`. Shape:

```
perceive (snapshot + sanitize + optional frame)
  ↓
for step in 0..maxSteps:
    check: aborted? bare-navigation goal already satisfied? loop detected?
    step 0 only: try the deterministic planner (no model call)
    call the planner  ← the remote model, streamed
    for each tool call:  resolve tokens → gate → execute → re-perceive → re-sanitize
    if the model answered without a tool call: that is the final answer, stop
```

### 5.1 The tools

Sixteen, from `src/background/tools.ts`: `read_page`, `click`, `click_text`, `type`,
`type_text`, `select`, `scroll`, `key`, `find_text`, `wait`, `navigate`, `go_back`,
`open_tab`, `list_tabs`, `switch_tab`, `close_tab`.

Two are worth calling out. `click_text` exists because inbox rows, search results,
cards and list items usually have **no element id** — the planner can click the exact
visible text instead. `read_page` returns the full element list, which is why the
loop detects a planner stuck re-reading the page and tells it to act instead.

### 5.2 Before a tool call runs

1. **Token resolution.** Any `<TYPE_N>` in the arguments is swapped for the real
   value from the vault *at this moment* (never earlier — the model never holds it).
2. **Post-resolve guard.** If token syntax survives resolution (a vault mismatch, a
   corrupted token), the action is refused rather than typed literally — otherwise a
   literal `<CRED_1>` could be emailed to a literally-invalid address.
3. **Route guard.** Clicking an app-switcher control (`Google apps`, `waffle`, a 3×3
   grid) is refused with the working route, because its popup lives in a
   cross-origin frame that no content script can read — the click can never be
   completed by any following action.
4. **The safety gate** (`src/background/safety.ts`) returns one of three verdicts:
   - `refuse` — editing a page's stored credential, sending a value pattern that
     looks like a real secret, an action on an element whose name marks it as
     credential-bearing, a restricted URL;
   - `confirm` — an irreversible-looking action when `confirmRisky` is on (the panel
     asks, and a "no" is returned to the model as a refusal it must not retry);
   - `allow`.
5. **Stale-id validation.** Element ids are only valid against the exact snapshot the
   planner was shown. A stale id triggers a fresh snapshot instead of clicking
   whatever now sits at that index.

### 5.3 What bounds a turn

From the constants in `agent.ts`:

| Boundary | Value | Catches |
| :--- | :--- | :--- |
| First output | `FIRST_OUTPUT_TIMEOUT_MS` = 90 s, **the same for every turn** (it used to be 60 s on later turns, which put the smaller budget on the larger prompt) | A provider that never sends a token. Reported once, **not** retried |
| Retry budget | `RETRY_FIRST_OUTPUT_MS` = 20 s | The only question a retry answers: was that silence a hiccup? |
| Mid-stream silence | `STREAM_IDLE_TIMEOUT_MS` = 30 s | A dropped connection *after* output started (reasoning models delta continuously, so 30 s of total silence is a dead link) |
| Deliberation | `MAX_REASONING_CHARS` = 12 000 or `MAX_REASONING_MS` = 90 s, with `MIN_REASONING_CHARS_FOR_TIME_CUT` = 1 000 so a slow-but-productive turn is left alone | A model analysing instead of acting. Steered once ("act on what you already have"), then reported |
| Degeneration | `DEGENERATION_WINDOW_CHARS` = 4 000; repeat ratio ≥ `DEGENERATION_REPEAT_RATIO` = 0.5 over 4-grams (`DEGENERATION_GRAM`), only counting repeats within `DEGENERATION_CYCLE_MAX_WORDS` = 16 words; or a `DEGENERATION_BLOCK_WORDS` = 40-word block repeated `DEGENERATION_BLOCK_OCCURRENCES` = 3 times | A **repetition loop**. Deltas keep arriving, so no silence window can see it — measured live at 100 s of "can make it one big things." Cut in seconds, never retried, and never replayed as history |
| Word salad | `DEGENERATION_SALAD_SCRIPTS` = 3 non-Latin scripts **and** either `SALAD_SCRIPT_SWITCH_RATE` = 0.06 switching or (`DEGENERATION_MIN_WORDS` = 120 words with punctuation density ≥ `DEGENERATION_SALAD_PUNCT_DENSITY` = 0.25) — with a `SALAD_CHURN_WORDS` = 60-word floor for the churn rule | Glitch text presented as an answer. Two independent signals, both required, because either alone flagged legitimate output |
| Loop detection | A repeated action, or three turns in a row that only looked at the page | "read_page" forever. One nudge with concrete advice, then the run stops and says the page may need manual input |
| Step cap | `settings.maxSteps` (default 40) | A confused agent spinning |
| Turn ceiling | `MAX_TURN_MS` = 210 s | Pathological streams (below MV3's 5-minute service-worker limit) |
| History clamp | `MAX_HISTORY_TEXT_CHARS` = 1 200 (`clampAssistantTextForHistory`) | A monologue paid for again on every later turn |

### 5.4 The two answer guards

- **Not language** → the streamed card is replaced, an error is emitted, and the run
  says it will not present that as the result.
- **Loop narration** (`finalAnswerComplaint`) → an answer that talks about its own
  tool protocol ("this will be the last tool call for a while", "no response yet")
  is refused the same way. Deliberately narrow: it knows the loop's own vocabulary
  rather than judging writing quality, and past-tense talk about tools actually used
  ("I used click_text to open it") passes.

### 5.5 The stop-on-satisfied-goal rule

`bareNavigationGoal(task)` (`src/background/deterministic.ts`) recognises a task that
is *only* a navigation — one verb (`open`, `go to`, `goto`, `visit`, `navigate to`,
`launch`, `show me`) followed by exactly one token — and resolves that token to the
hosts that would satisfy it:

```
"open yt"                        → youtube.com
"open gmail" / "go to gmail"     → mail.google.com, gmail.com
"open youtube.com"               → youtube.com (a literal host is its own goal)
"open yt and search for iit"     → null (a second step exists)
"open the first video"           → null (a step, not a site)
"open settings"                  → null (not a site, so it cannot be verified)
```

The loop tests the tab's URL at the top of every step. Exact host match only — a
subdomain is deliberately *not* the site, because a false positive abandons your task
while a false negative just runs the loop the way it worked before.

### 5.6 The prompt

Two system prompts exist: `SYSTEM_PROMPT` (remote) and `SYSTEM_PROMPT_LOCAL` (small
local models). Both describe the tool surface, the token vocabulary, and the rules
that matter: use tokens where they belong but never the token's own spelling as a
search query; act only on what the task asks for; a search is finished when its
results are visible; if you already have everything the task asked for, answer
instead of looking again. The page read is truncated per snapshot to `MAX_TEXT` =
6 000 chars, `MAX_ELEMENTS` = 80 elements, `MAX_NAME` = 60 chars per element name.
Stale page reads are pruned from history, so the request the provider is charged does
not grow with step count.

---

## 6. Under the hood: perception, channel by channel

### 6.1 Mesh 1 — the DOM (content script, `src/content/perceive.ts`)

Finds: rendered text nodes, form fields, password inputs, ARIA attributes, images
with avatar-ish alt text, and the elements a detector read a value out of.

How: high-precision regexes plus **mathematical checksums** (§15), context from a
field's own label, and the on-device NER model fused on top. Values are matched
against the real page text and anything not literally present is dropped
(`fuseDetections`, `detector-v2.ts`) — otherwise a span scored on page 1 would be
reported again on page 3 as a live detection.

Caps: `REGION_SCAN_BUDGET_MS` = 1 500 ms, `REGION_SCAN_MAX_NODES` = 8 000,
`REGION_MAX_RESULTS` = 200 regions. A scan that hits a cap reports a shortfall
instead of implying completeness, and whether it *reached the end of the document* is
recorded — because "we did not find it" only means something if the walk finished.

### 6.2 Mesh 2 — pixels (offscreen document)

Five channels contribute, and they **add** rather than replace each other:

| Channel | What it is | Why it exists |
| :--- | :--- | :--- |
| BlazeFace, whole frame | One detector call on the original pixels | Catches normal-sized faces |
| BlazeFace, tiled | The same detector over ≤`FACE_TILE_MAX` = 16 overlapping crops (`FACE_TILE_OVERLAP` = 0.25, aiming at `FACE_TILE_TARGET_PX` = 320, refused when the gain is below `FACE_TILE_MIN_GAIN` = 2) | The model's input is a fixed ~128×128, so a 1280×800 frame scales to 0.1 and a 44 px face arrives at ~4 px. Crops put the same face at ~17 px |
| Chrome's built-in `FaceDetector` | The platform shape detector | A second, independent model opinion. Gated by `shouldRunSecondaryFaceDetector`: always when nothing was found, otherwise only when a skin-colour candidate is not already covered (this used to be suppressed by a single BlazeFace hit, so a large portrait hid a small face) |
| Skin-colour pass | Threshold + connected blobs, 4 px sampling grid, floor ~14 px | The cheap channel that *sees* small faces. It is noisy, so its boxes are used two ways: painted as a supplement (≤`MAX_SKIN_FACE_ADDITIONS` = 16 per frame) and, more importantly, as **proposals** |
| Targeted probes | ≤`FACE_PROBE_MAX` = 8 native-resolution crops, ≤`FACE_PROBE_MAX_SIDE_PX` = 192, cropped around skin blobs that no model box explains | A 96 px crop scales at 1.33, so a thumbnail face reaches the model *larger* than life and what comes back is the model's box rather than a colour histogram's |

Duplicate reports (overlapping tiles, a probe and the full-frame pass) are collapsed
by `dedupeFaceBoxes` using coverage thresholds (`FACE_TILE_DUPLICATE_COVERAGE` = 0.5,
`FACE_DUPLICATE_COVERAGE` = 0.3), keeping the largest report. Tiling is refused for
exactly two cases: a frame that already fits one crop, and a **stitched full-page
capture** (declared by the caller, because the document cannot tell a stitched image
from a very tall viewport).

**Faces are destroyed, never blurred** — an opaque fill, because blur is invertible
and faces are the biometric case.

### 6.3 Frame-text triage (opt-in)

`triageFrameText` + `shared/ocr-pii-triage.ts`: the **already-redacted** frame is cut
into ≤`TRIAGE_MAX_TILES` = 6 slices of `TRIAGE_TILE_HEIGHT` = 900 px, each OCR'd under
`TRIAGE_TILE_TIMEOUT_MS` = 8 s inside a `TRIAGE_TOTAL_BUDGET_MS` = 6 s wall clock for
the whole pass. A slice with no mid-tone pixels is skipped (whitespace costs nothing).
What survives is matched against the shared PII patterns, the NER spans, and the
values the DOM could not place; matches are black-boxed. Only words above
`MIN_LINE_CONFIDENCE` = 30 count, boxes already >`COVERED_BOX_RATIO` = 0.5 covered are
dropped, and at most `MAX_TRIAGE_BOXES` = 40 new boxes are painted.

Two design points: because it reads *after* redaction it is self-targeting (an
already-redacted value is a black rectangle OCR cannot read, so anything legible is by
definition what nothing else covered); and clearance for an unplaced value requires
the value to be **found and painted** (`legible >= requested` and `stillLegible === 0`)
— an OCR miss is not proof of absence. For those clearance-bearing values only,
matching is tolerant (case, separators and classic glyph confusions folded away,
~1 character in 6 allowed — `MIN_FUZZY_SPAN_CHARS` = 4), so `Hark1rat Singh` in the
pixels clears a requested `Harkirat Singh`.

---

## 7. Under the hood: the pixel pipeline, stage by stage

In `src/offscreen/offscreen.ts`, one frame runs:

| Stage | Work | Constants |
| :--- | :--- | :--- |
| `decode` | Fetch the data URL → blob → `ImageBitmap` → canvas; keep an untouched copy for comparisons | — |
| `dom-regions` | Paint every region the DOM channel reported, according to its tier (§9) | `REGION_PAINT_PADDING_CSS_PX` = 4 |
| `faces` | The five channels of §6.2, deduped, then painted opaque | tile/probe constants above |
| `frame-text-ocr` | Optional triage pass (§6.3) | 6 s budget |
| `encode` | Canvas → JPEG at quality 0.92 → data URL. The bytes that are verified are the bytes that ship | — |
| `verify` | Re-read the shipped bytes (§8) and, if needed, rebuild the frame opaque and re-verify | — |

Every stage is timed and the numbers travel with the frame (`stages`). If the frame
comes back over the agent's 15 s wait budget, the run prints the breakdown once,
naming the stage that cost the time and the remainder the stages do not account for.
That is a measurement taken **in the browser**, because every test harness runs the
pipeline against stubs.

**The OCR queue.** Tesseract's worker queues jobs internally without saying so, and
each caller used to race its own timeout — so on a cold worker the two OCR consumers
of a first capture raced one ~10.5 s start-up, the loser's deadline expired with
nothing to show, and its recovery path terminated the engine the winner was still
using. One frame, two cold starts, neither a result nor a failure. Recognitions are
now queued (`ocr.ts#enqueue`), one at a time, and each job's deadline is created
inside its own slot. A timeout therefore means the worker is genuinely wedged, which
is what makes terminating it safe for everyone else.

---

## 8. Under the hood: proof that the redaction worked

`src/background/reocr-verification.ts` + the escalation block in `offscreen.ts`:

1. **Rebuild the strip.** Every redacted region is cropped from the *post-JPEG*
   image — the bytes that will actually ship — and composited into one strip. A
   surrogate region is excluded: its synthetic stand-in matches the very patterns the
   scan looks for (the synthetic card `4111 8703 3161 1545` matches "card number"
   *and* "Aadhaar"), so scanning it produced phantom leaks and rebuilt frames for no
   reason. What keeps that honest is the pixel check, which would still see an
   unpainted region.
2. **OCR the strip.** Any PII pattern still readable inside a region is a proven leak.
3. **Pixel-check every region.** A face must come back near-uniformly opaque
   (`DESTROYED_BLACK_RATIO` = 0.9 of the region reads as the fill). "Changed" is not
   "irreversible", so a slightly darkened face **fails**.
4. **Attack the shipped bytes** (`src/background/redaction-attack.ts`):
   - *Reconstruction:* each soft region is sharpened (`UNSHARP_RADIUS_PX` = 3,
     `UNSHARP_AMOUNT` = 1.0) and the **residual** edge energy is measured. Opaque
     reads 0.00, the shipped blur reads 0.05-0.26, a weakened blur reads 0.29-0.97;
     ≥ `RECONSTRUCTION_THRESHOLD` = 0.35 escalates. Residual and not "how much did
     sharpening bring back", because iterated unsharp *manufactures* energy at a mask
     edge. `MIN_ORIGINAL_ENERGY` = 8 skips regions with nothing to measure.
   - *Face coverage:* the model detector is re-run over the shipped frame. A face that
     the destroyed regions cover less than half of is a coverage failure, not a weak
     mask, so it joins the rebuild list. The skin-colour channel is deliberately
     excluded from this probe — its false positives would escalate innocent regions.
5. **Escalate and remediate.** If anything survived, the frame is rebuilt from the
   untouched original pixels with every region opaque, re-encoded and re-verified.
   The escalated frame is what ships, and it is labelled `ESCALATED + VERIFIED` — never
   as a plain pass.
6. **Classify what is left.** Every residual names its channel (`PIXEL:`, `OCR:`,
   `RECONSTRUCTION:`, `FACE COVERAGE:`), and "still present in the bytes that ship"
   (`leakedPatterns`, which must reach zero) is kept strictly separate from "what
   triggered the rebuild" (`escalationReasons`). Conflating them is how a frame stayed
   withheld forever.

Sampling note: the verifier strides with a row-phase offset, because a fixed stride
that shares a factor with the content's period can land on one phase and read a
region as perfectly flat.

---

## 9. Under the hood: the three tiers and the coordinate mapping

Tier choice is one function (`tierForKind`, `src/shared/region-paint.ts`), so the
painter, the verifier and the inspector cannot disagree:

| Kind | Tier | What is drawn |
| :--- | :--- | :--- |
| `face`, `*_text` spans (PII in page text), triage boxes | **opaque** | Solid `#000000` (`OPAQUE_FILL`) |
| `credential`, ID fields | **surrogate** | Region cleared to white, bordered, repainted with a synthetic checksum-valid value (`SURROGATE_FILL` / `_BORDER` / `_TEXT_FILL`) |
| `credential_label`, `input_field` | **soft** | Separable box average, `BLUR_RADIUS_CSS_PX` = 6, radius capped at 40 device px |

Turn off `maskCredentials` and every remaining tier degrades to blur (the opposite of
what someone unchecking "mask credentials" asked for would be a surprise).

**Coordinates.** DOM rectangles are CSS pixels; the image is device pixels. The
transform is `region-mapping.ts`:

```
device = (css + scrollOffset) × scale        // scale = DPR, or tile scale for stitched captures
```

A stitched full-page capture additionally folds the tile scale and every region's
scroll offset in, and each painted box is clamped to the image and padded by 4 CSS px.
The painted rectangle — not the raw detector box — is what the audit marker and the
box in the panel are derived from, so a proof marker can never sit beside its mask.

Geometry is also reconciled rather than required to be identical: regions are measured
*after* the pixels were taken (a message round trip plus the DOM scan), so a page that
scrolls in that window is corrected by the known shift instead of failing the capture
(`reconcileCaptureShift`). Matching scroll exactly was how a tab doing hundreds of DOM
updates per click lost its vision channel.

---

## 10. Under the hood: text sanitization

`src/background/tokenizer.ts`. Token shape is `<TYPE_N>`:
`TOKEN_RE = /^<[A-Z]+_\d+>$/`, and a bare `CRED_1` (markup eaten by the model) is
repaired by `repairTokenConcatenation` with `BARE_TOKEN = /([A-Z]{2,6})_(\d{1,4})/`.

| Kind | Token prefix |
| :--- | :--- |
| `face` | `<FACE_n>` |
| `credential` | `<CRED_n>` |
| `id_number` | `<ID_n>` |
| `api_key` | `<KEY_n>` |
| `pii_text` | `<PII_n>` |
| `image_text` (read out of pixels, never a token source) | `<IMG_n>` |

A legend accompanies the tokens (`buildTokenLegend`) so the planner is told what each
one stands for *without its value* — a token's spelling carries no meaning.

**What gets tokenized:** secrets in the user's own request, DOM values from the
detector channels, and names when they are the **payload** of a message ("send an
email to Priya Sharma", "addressed to Acme Corporation"). Names used as the ordinary
object of a preposition in a non-messaging task ride raw, because in a task the name
*is* the instruction parameter: `"i want to open harkirat singh yt channel"` used to
vault the whole tail of the sentence and hand the planner `<PII_1>` where its search
target belonged — so the agent typed the token's own spelling into the search box. A
name run is capped at `MAX_NAME_WORDS` = 3 words, entries must pass a name-character
test (`NAME_WORD`), and a blocklist of non-name starters keeps ordinary prose out.

Token ↔ value pairs live in a plain in-memory `Map` for the life of the service
worker. Nothing is written to `chrome.storage`, and MV3 tearing the worker down is
what clears them. It is not encrypted and not partitioned per tab — the README states
that as the trust boundary rather than implying otherwise.

---

## 11. Under the hood: what may leave, and what is counted

### 11.1 The ship / withhold contract

`ScreenshotProtection` is the evidence object, written by the process that can witness
each fact (`shared/screenshot-protection.ts`): the offscreen document reports its own
face scan and final scan; the service worker adds text-channel coverage and geometry
validity. Evidence that is absent fails **closed** (`missingProtection`).

`screenshotSendDecision(frame)` (`shared/screenshot-egress.ts`) then returns
`allowed` plus reasons. A frame is withheld when:

| Reason | Meaning |
| :--- | :--- |
| `Protection evidence missing` | Nobody produced the evidence object |
| `Required protection disabled` | Faces or credential masking switched off |
| `Face scan incomplete` / `Text scan incomplete` / `Final image scan incomplete` | The scan did not finish — "we could not check" withholds |
| `Capture mapping unverified` | The region→image mapping could not be confirmed for this image |
| `Residual sensitive content detected` (+ named details) | The verifier found something readable in the shipped bytes |
| `Invalid screenshot encoding` | Not a PNG/JPEG data URL |

Deliberately **not** part of the contract: frame-text triage coverage. Triage is
documented additive and best-effort, so it is reported in the audit and never blocks.

### 11.2 The egress meter and the tripwire

- `wire-log.ts` records what each planner turn was charged (`recordWire`,
  `scanForLeaks`, `tokensIn`, capped at `MAX_RECORDS` = 24), and the panel's badge adds
  the VLM's returned bytes. The badge is a report, not an estimate: the panel prints
  the model actually used and the bytes actually sent.
- `content/tripwire.ts` hooks the page's own `fetch`/`XMLHttpRequest`/
  `sendBeacon` in the MAIN world, inspects URLs and bodies for PII shapes, separates
  **same-site** traffic (a site posting to its own backend) from **third-party**
  egress, and records alerts in the ledger. **It never blocks, delays or rewrites a
  request** — every hook calls through unchanged and fails open. Blocking would need a
  browser-enforced `declarativeNetRequest` rule, which is roadmap.

---

## 12. Under the hood: the ledger

`src/background/privacy-ledger.ts`:

- Storage key `pry-privacy-ledger`, retained window `MAX_ENTRIES` = 500.
- Each entry: `seq`, `timestamp`, `type`, `data`, `prevHash` → `SHA-256` → its own
  hash. The chain is a hash chain, so any edit or reorder is detectable.
- Entry types cover snapshots, detections, tokenization, redactions, verifications
  and actions, plus egress alerts.
- `computeMerkleRoot()` folds the retained entries' hashes pairwise
  (`SHA-256(left ‖ right)`) into one root.
- `audit-proof.json` (via *INSPECT PROOF*) exports the root, the chain-validity
  verdict and every leaf.

Proves: the entries are in order and unaltered, and an auditor can recompute the root
in `O(N)`. Does not prove (yet): a per-leaf sibling path, so there is no `O(log N)`
inclusion proof to hand a third party for a single entry.

---

## 13. Under the hood: voice

**Microphone.** The side panel calls `getUserMedia` itself, which is why the manifest
declares `audioCapture` — without it Chrome hides the device list from the extension
and the failure surfaces as `NotFoundError`, a hardware-sounding error for a manifest
problem. When the mic fails, the panel names the real cause (missing permission, no
device, blocked prompt, device busy) by checking
`chrome.runtime.getManifest().permissions`, so it cannot be wrong about which case it
is.

**The button is a toggle, not push-to-talk.** `voice-core.micToggleAction()` decides
`start` / `stop` / `unavailable`, and the panel's own line says so:
*"Voice: dictation ready. Tap the mic button to start recording, then tap it again to
send."* It is a constant (`MIC_READY_ANNOUNCEMENT`) pinned by tests, so the copy cannot
drift from the button again.

**Speaking safely.** `voice-core.toSpeakable()` is the single gate: vault tokens are
replaced with the spoken word "redacted", markdown is flattened, length is capped. A
token is a reason to **redact, never a reason to refuse** — the previous version
checked for a token first and returned "Refusing to speak: raw vault token in
assistant text", which fired on almost every Gmail run because the tab title alone
carries a token. The number of substitutions is reported so it is never mistaken for
the model's own wording.

---

## 14. Under the hood: the learning layer

Four small stores, all in `chrome.storage`, all about *this user's* sites — no secrets,
only structure and outcomes:

| Store | File | What it keeps |
| :--- | :--- | :--- |
| Experience memory | `experience-memory.ts` | One `RunExperience` per run (domain, page type, actions with latency/success, PII kinds found, outcome, user corrections). Stats per site and per page type |
| Lessons | `lessons.ts` | Short, matched advice written from finished runs (`matchLessons` scores them against the current task and page) |
| Learned rules | `learned-rules.ts` | Rules derived by reflection: strategy rules, false-positive suppressions, and `recommendsLLMOnly` (a page type where the deterministic planner has failed before). `buildSuppressionKeys` turns false-positive filters into keys the detector consults |
| Trajectories | `trajectories.ts` | Routes that worked ("navigate → type" for a search), rendered into the prompt as *routes that worked here before* — with the caveat that the length of a stored route is not the length of your task |

This is what the transcript line *"Learning: applying 2 stored rule(s) for
www.youtube.com (1 false-positive filter, 0 strategy rules)"* is: rules specific to
that site, plus a note about what the detector suppressed there.

---

## 15. The maths, in plain words

**Luhn (card numbers).** Sum the digits right-to-left, doubling every second digit and
subtracting 9 when the double exceeds 9; a valid number's total ends in 0. Used twice:
to *validate* a candidate before redacting it, and to *generate* the check digit of a
synthetic card so a form still accepts it.

**Verhoeff (Aadhaar).** A checksum built on the symmetries of a regular pentagon
(the dihedral group `D5`), using a multiplication table `d(j,k)`, a permutation table
`p(i,j)` and an inverse table `inv(j)`. It detects more transposition errors than
Luhn, which is why it is the Aadhaar check.

**Format-preserving surrogates.** `src/background/surrogates.ts` derives each digit
from an **FNV-1a digest** of the raw value, keeps the length and the 4-digit card BIN
prefix, and recomputes the trailing checksum. Aadhaar surrogates are built on the
prefix `99990123456` (the module's own "synthetic test space" marker) plus a valid
Verhoeff check digit.
**This is deterministic pseudonymization with no key — not FF3-1 and not a cipher.**
Anyone holding a surrogate can brute-force the small digit space offline and recover
the original. A keyed FF3-1 (WebCrypto AES as the round function) is roadmap; until
then, use the opaque tier for anything that must not be recoverable.

**Box blur, separable.** A box average is two 1-D sliding-window passes (horizontal
then vertical), so the cost is `O(w·h)` regardless of radius. It is computed
explicitly rather than with `ctx.filter = "blur(...)"`, which silently no-ops on some
Chrome builds — a redaction that appears to happen and does not.

**IoU fusion.** Overlapping or adjacent boxes from different channels are merged into
one envelope, so a face found twice is painted once and a card number split across two
spans becomes one mask.

**Merkle root.** Pair up leaf hashes and hash each pair, repeat until one hash
remains. Comparing roots proves the whole set is unchanged; finding *which* entry was
altered is what per-leaf paths would add (not shipped).

---

## 16. Every term, in plain words

**Agent loop** — the code that alternates "ask the model what to do" and "do it".
`runTask` in `agent.ts`.

**Bare navigation goal** — a task that is only a navigation ("open yt"), so success is
checkable (is the tab on that site?) and the run may stop.

**Box filter / box blur** — the soft tier: average the pixels in a square window.
Cheap, `O(w·h)`, and recoverable in principle, which is why it is never used for faces.

**Checksum** — the last digit of a card/Aadhaar that is determined by the others.
Luhn for cards, Verhoeff for Aadhaar. Used to validate real values and to make
synthetic ones look real.

**Content script** — extension code that runs inside the page and can read the DOM.

**Degeneration** — the model collapsing into a repetition loop. Detected by repetition
ratios, not by duration (a thorough model is slow too).

**Detector / channel** — one way of finding sensitive things. The project has text
channels (regex, contextual, NER) and pixel channels (faces, OCR triage).

**DPR (device pixel ratio)** — how many real screen pixels one CSS pixel occupies
(2 on a retina display). Every coordinate transform has to account for it.

**Egress** — anything that left your machine. Counted live and shown as a badge.

**Escalation** — rebuilding the frame from the originals with every region opaque,
because the first paint was not proven sufficient.

**Frame** — one screenshot, processed: capture → redact → verify → record.

**Frame wait budget (`FRAME_AUDIT_WAIT_MS`, 15 s)** — how long the loop will wait for a
frame. A frame's stages add up to more than this on heavy pages, which is why after the
first overrun the run stops *paying* the wait and joins frames later instead.

**Gate** — the safety check that decides allow / confirm / refuse before an action
runs.

**IoU (intersection over union)** — how much two boxes overlap. Used to fuse channels
and to decide whether a detector found the same thing twice.

**Kill switch / policy flags** — `PrivacySettings`. Turning faces or masking off
withholds frames from egress rather than shipping them unredacted.

**Leaked pattern** — a value the verifier could still read in the bytes that ship.
Must be zero for a frame to send.

**Mesh 1 / Mesh 2** — the DOM channel and the pixel channel.

**Merkle root** — one hash summarising all ledger entries.

**Opaque tier** — solid black fill. Zero information survives.

**Planner** — the remote LLM that chooses tool calls. Receives tokenized text and, if
vision is on, the redacted frame.

**Probe (face)** — a small native-resolution crop taken around a skin-colour blob that
no model box explains, so the real detector can judge it at a usable scale.

**Protection evidence** — the object proving the scans ran. Absent evidence withholds
the frame (fail closed).

**Redaction vs tokenization** — redaction makes a value unreadable; tokenization keeps
it usable behind a placeholder. Two different jobs (§10, and `PROJECT_EXPLAINED.md` §5).

**Residual** — what is still readable after redaction, attributed to the channel that
found it (`PIXEL:`, `OCR:`, `RECONSTRUCTION:`, `FACE COVERAGE:`).

**Side panel** — the visible UI: task box, transcript, audit card, voice controls.

**Skin-colour pass** — a cheap colour/blob detector. Noisy, so it is used as a
*proposal* source for the real model and as a supplement, never as the answer.

**Snapshot** — the page read: URL, title, text, elements with ids, sensitive regions,
DPR, scroll.

**Soft tier** — the blur tier. Accepted only for non-identifying regions.

**Stitched capture** — a full-page image built by scrolling and joining viewport
pictures. Faces are not tiled on it, by decision, because page length would set every
crop size.

**Surrogate** — a fake but format-valid replacement value.

**Tier** — the strength applied to a region: opaque, surrogate, soft.

**Tier-0** — the on-device model tier (NER, injection guard, BlazeFace): everything
that runs locally before any remote call.

**Triage** — reading a frame back with OCR to find text nothing else covered.

**Tripwire** — the MAIN-world observer of the page's own outbound requests. It reports
PII-shaped egress and classifies same-site vs third-party. It does not block.

**Turn** — one planner call plus the actions it asked for.

**Vault** — the in-memory map of token → real value. Cleared when the run ends or the
worker dies; never persisted, never encrypted.

**Vision (VLM)** — the optional step that sends the *redacted* frame to a vision model
and appends its description to the tool result. Off by default.

**Withheld** — a frame that was not sent, with the reason named in the transcript.

---

## 17. Where things live, and how to run it

```
src/background/    the loop, the vault, the detectors, the ledger, the providers
src/content/       DOM perception and action, plus the MAIN-world tripwire
src/offscreen/     all pixel work: faces, painting, OCR, verification
src/sidepanel/     the panel, the audit card, the voice client
src/inspector/     the before/after proof viewer
src/options/       settings (provider, keys, model, toggles)
src/ml/            the on-device model loaders (NER, guard, env paths)
src/shared/        pure policy with no browser dependency: types, patterns,
                   face fusion, region mapping, checksums, egress rules
scripts/           the verification suite (npm run verify) and model tooling
models/            bundled weights: blazeface/, ner/, (guard/ is absent by design)
```

```bash
npm install            # once
npm run fetch-models   # download weights (Hugging Face token optional)
npm run build          # 7 bundles into dist/
npm run typecheck      # tsc --noEmit
npm run verify         # 1265 assertions across 7 suites
npm run bench:latency  # per-capture pixel cost, face-tile geometry, OCR cold start
```

Then load `dist/` via `chrome://extensions` → Developer mode → *Load unpacked*, and
**reload the extension after every rebuild** — an older loaded build keeps reporting
bugs that were already fixed.

---

*If a statement here ever disagrees with the code, the code is right and this file is
the bug. The constants are all named so you can grep them.*
