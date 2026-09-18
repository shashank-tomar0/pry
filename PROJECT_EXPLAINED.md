# PRY, Explained Simply

*This is a plain-words guide to the whole project. It does not replace `README.md`
(which is the formal, dense version with the maths); it is the one to read first if
you want to understand what the code does and why it is built this way. Nothing in
the project's structure was changed to write it.*

---

## 1. What this project is

PRY is a **Chrome extension that lets an AI agent drive your browser without ever
seeing your private data**.

You type a task ("open gmail and open the first email I received"). A remote AI
model decides the steps. But a normal agent would send it *your actual screen* —
your face, your emails, your card numbers — and that is a privacy disaster. PRY
sits in between. It looks at the page, finds the private things, destroys or
replaces them **inside your browser**, and only then sends anything out.

One sentence: **the AI gets a version of your screen with the secrets taken out,
and the real values stay on your machine.**

Built for Smart India Hackathon 2026, problem statement 26171 (*On-Device Visual
Perception for Lightweight Browser Agents*).

---

## 2. The rule the whole design follows

> Nothing private leaves the browser. Everything that goes out is either
> harmless, synthetic, or destroyed.

Each part of the code exists to make one half of that sentence true:

| Promise | How it is kept | Where |
| :--- | :--- | :--- |
| Faces are destroyed, not blurred | The face pixels are overwritten with solid black, never filtered | `src/offscreen/offscreen.ts` |
| Structured secrets stay *usable* | A card number becomes a different, fake number that still passes the checksum | `src/background/surrogates.ts` |
| Secrets in your own request stay hidden | Real values are swapped for tokens like `<CRED_1>` before the model reads the task, and swapped back only when an action types them | `src/background/tokenizer.ts` |
| What was hidden can be *proved* | Every step is written to a tamper-evident SHA-256 hash chain with an exportable Merkle root | `src/background/privacy-ledger.ts` |
| You can see what was sent | A live egress meter counts every byte that left, per turn | `src/background/wire-log.ts` |

And the honest half — what the project does **not** promise — is written down in
[§12 below](#12-what-it-honestly-does-not-do) instead of being hidden.

---

## 3. The five moving parts (and why they are separate)

Chrome's Manifest V3 security model forces this split. Each part can do things the
others cannot, and none of them can do everything.

| Part | Where it runs | What it does | Why it has to be its own thing |
| :--- | :--- | :--- | :--- |
| **Content script** (`src/content/`) | Inside the web page (isolated world) | Reads the page: text, form fields, buttons, element positions | Only this part can touch the DOM. The page's own JavaScript cannot see or tamper with it |
| **Service worker** (`src/background/`) | Extension background | The brain: runs the agent loop, holds the token vault, decides what ships, keeps the ledger | It is the only long-lived coordinator, and it owns the network calls |
| **Offscreen document** (`src/offscreen/`) | A hidden extension page | All pixel work: face detection, redaction painting, OCR re-reading | Service workers have **no canvas and no DOM**, so image work has to live in a document |
| **Side panel** (`src/sidepanel/`) | The visible panel | The chat, the buttons, the audit card, and the voice client | It is the user's window into a run; it holds no secrets of its own |
| **Egress tripwire** (`src/content/tripwire.ts`) | Inside the page, in the **MAIN** world | Watches the page's own `fetch`/`XHR`/`sendBeacon` calls and reports PII-shaped sends | Only MAIN-world code can see the page's real network calls — and it only *reports*, it never blocks | 

Data never sits still between them: images live in offscreen memory and are dropped
after use, and the token vault is a plain in-memory map that dies with the worker.

---

## 4. One run, end to end

This is the whole product in fourteen steps. The file named is where the step lives.

1. **You type the task.** The panel sends it to the service worker.
2. **Your own words are sanitized first.** Any secret *in the request* (a card
   number, an email, an API key) becomes a token like `<CRED_1>`, and the panel
   tells you: *"1 value replaced before the model saw your request."*
3. **The page is perceived.** The content script returns a snapshot: URL, title,
   main text, and up to 80 interactive elements with ids, plus the coordinates of
   everything that looks sensitive (password fields, card boxes, Aadhaar/PAN, the
   elements a detector read a value out of).
4. **Page text is tokenized and redacted.** Names, emails and numbers found by the
   regex + checksum matchers and by the on-device NER model become tokens for the
   planner and `[REDACTED]` (or a synthetic value) in what the planner reads.
5. **The first screenshot is captured** (if the user has that on).
6. **The frame goes through the pixel pipeline** — the big one, detailed in §6.
7. **A decision is made: does this frame ship?** `src/shared/screenshot-egress.ts`
   answers ship / withhold, and it must *give reasons* for a withhold. "We could
   not check it" is a reason to withhold, not to hope.
8. **The planner is called** (the remote model). It receives the tokenized text and,
   if vision is on, the redacted frame plus a description of it. It answers with
   structured tool calls: `navigate`, `click`, `click_text`, `type`, `scroll`,
   `read_page`, `find_text`…
9. **Every tool call is checked before it runs**: ids that the page never sent are
   rejected, risky actions can ask for your confirmation, and a `<TYPE_N>` token that
   failed to resolve is refused rather than typed literally.
10. **The action is executed** by the content script, and the result is re-tokenized
    so the raw value cannot ride back to the model in the action's own echo.
11. **The page is re-read** and re-sanitized, and the cycle repeats.
12. **Steps 6–11 loop** until the model answers without a tool call, the goal is
    already met, you press Stop, or the step cap is reached.
13. **The run ends with a summary:** redactions, vault tokens, frames, egress bytes,
    and a ledger entry. The audit card appears in the panel, and *INSPECT PROOF*
    opens the before/after inspector.
14. **The vault is cleared** when the run finishes.

Every run is bounded. The planner turn has a first-output budget (90 s), a
mid-stream silence budget (30 s), a deliberation cap and a 210 s ceiling; the frame
wait has its own 15 s budget; and the frame pipeline has a 6 s wall clock for its
text pass. §9 explains what happens when one of those fires, and what the run says
about it.

---

## 5. The two ways text is handled (this distinction matters a lot)

There are two different jobs, and confusing them is what caused some of the worst
bugs in this project's history.

**Tokenization — the value must survive as a usable value.**
`<CRED_1>` stands in for a real email or card number. The planner can still reason
("type the email here"), and when an action actually types `<CRED_1>`, the vault
swaps the real value back at the last moment. Tokens are tagged by kind: `<CRED_1>`
for credentials, `<PII_1>` for other personal data.

**Redaction — the value must be unreadable.**
In the page text the planner reads, a hidden value becomes synthetic (a valid-looking
fake) or `[REDACTED]`. In the *pixels*, it is painted or destroyed. The original
pixels of a destroyed region never exist in the shipped image at all.

**A rule learned the hard way:** in a *task*, a name is an instruction parameter, not
a payload. When the rule treated "search for harkirat singh" as if the name were an
addressee, it vaulted the name and the agent typed the token's own spelling into
YouTube's search box. The name is still protected everywhere in the page and still
detected on screen — but it rides to the planner raw when it *is* the thing you asked
to search for. An instruction the agent cannot read is not a protected instruction;
it is a broken one.

---

## 6. The pixel pipeline, stage by stage

This is the heart of the project — the part that makes screenshots safe. It runs in
the offscreen document, and it now measures itself:

```
decode  →  dom-regions  →  faces  →  frame-text-ocr  →  encode  →  verify
```

| Stage | What happens | How it goes wrong, and what was done about it |
| :--- | :--- | :--- |
| **decode** | The screenshot is turned into an offscreen canvas, and an untouched copy is kept for comparisons | — |
| **dom-regions** | Every region the DOM channel reported is painted according to its tier (§7) | The audit marker is derived from the rectangle that was *actually painted*, so a proof marker can never sit beside its mask |
| **faces** | Three channels run and their results fuse: BlazeFace over the whole frame, BlazeFace over native-resolution tiles, Chrome's own detector, and a skin-colour pass | A whole 1280×800 frame is scaled to 0.1 for the model's fixed ~128×128 input, so a 44 px face arrives at ~4 px and is gone before anything looks at it. Tiles fix that (~17 px). A thumbnail is also *proposed* by the skin-colour pass and then cropped at native resolution for the real detector to judge, so a small face is boxed by the model rather than by a colour histogram. Faces are **destroyed** (solid fill), never blurred |
| **frame-text-ocr** | The **already-redacted** frame is read back with on-device Tesseract, and whatever PII is still legible gets black-boxed | Running it *after* redaction makes it self-targeting: a value already covered is a black rectangle OCR cannot read, so anything it can still read is by definition what nothing else covered. It also receives the values the DOM could not place, so a value hiding inside an image can be found and destroyed instead of the frame being withheld |
| **encode** | Painted canvas → JPEG bytes | The bytes that are verified are the bytes that ship — no second encode afterwards |
| **verify** | The shipped bytes are attacked on purpose: every soft region is re-read by OCR and re-sharpened to see if it is recoverable, and the face detector is re-run over the shipped frame to catch faces the first pass missed | If anything survives, the frame is **rebuilt** from the original pixels with every region opaque, re-encoded and re-verified. An escalated frame is labelled `ESCALATED + VERIFIED`, never as a plain pass |

The stage timings are recorded in the frame's own result and, if a frame comes back
slower than the agent's 15 s wait budget, the run prints them once — naming the stage
that cost the time plus the remainder the stages do not account for. That measurement
replaced guesswork: the earlier budget had been picked before the face pass gained
tiles, verification and escalation.

The other half of the same fix was the OCR cold start. Tesseract takes ~10.5 s to
start, and its worker queues jobs internally without saying so, so the two OCR
consumers of a first capture used to race one start-up — and the loser's recovery
path killed the engine the winner was still using. One frame paid for two cold
starts and reported neither a result nor a failure. Recognitions are now queued, one
at a time, and each job's timeout starts when its job starts.

---

## 7. The three redaction tiers

Not everything gets the same treatment, because the tiers have different strengths:

| Tier | Used for | What it is | Recoverable? |
| :--- | :--- | :--- | :--- |
| **Opaque destroy** | Faces, PII spans in page text, unlocatable values found in the frame | The region is overwritten with `#000000` | No — no original pixel survives |
| **Surrogate inpaint** | Credential and ID fields | The region is cleared and repainted with a synthetic, checksum-valid value | No — the original is discarded, not filtered |
| **Soft box blur** | Generic input fields and credential labels | A box average, radius 6, capped at 40 | Weak by design. It is only ever accepted for non-identifying regions, and the adversarial verifier re-attacks it every frame |

Faces are never given the soft tier, because blur is exactly the case that
super-resolution attacks recover.

---

## 8. The models

Three run **on your machine** and two are remote. Nothing about the local three ever
leaves.

| Model | Runs where | Job |
| :--- | :--- | :--- |
| **BlazeFace short-range** (~224 KB) | Offscreen, WebGPU with a Wasm fallback | Finds faces — whole-frame, tiled, and on native-resolution probes |
| **Quantized BERT NER** (~104 MB, 8-bit) | Offscreen, ONNX Runtime Web | Finds names, organisations and places in page prose — things no regex can find |
| **Tesseract.js LSTM** | Offscreen, Wasm | The adversarial auditor: re-reads the shipped bytes, and triages text baked into images |
| **The planner** (default `nvidia/nemotron-3.5-lightning-30b-a3b` via NVIDIA NIM; OpenAI, Anthropic, Groq and Ollama adapters exist too) | Remote | Chooses the steps. It is the *only* place page meaning is interpreted |
| **ElevenLabs Scribe / Flash v2.5** | Remote, and only if you use voice | Dictation in, spoken replies out |

An optional fourth local model — an injection guard that would classify "text on the
page that is addressed to an AI agent" — is wired up but ships with **no checkpoint
bundled**, so the regex heuristic is what actually runs. The transcript says so
rather than implying a model is protecting you.

---

## 9. When things go wrong (the honesty rules)

Most of the work in this codebase is not "make it work" but "make it say the truth
when it fails". These are the rules the agent loop follows:

**If the model stalls or loops.** A turn is bounded by *silence*, not by wall clock,
because a reasoning model that is visibly making progress should be allowed to
finish. Silence is retried once. Reasoning that never converges is steered once with
"act on what you already have", then reported. Degeneration (a repetition loop) is
cut and **not** retried, because the same prompt buys the same garbage.

**If a frame is late.** After the first overrun, the run stops *paying* the 15 s wait
in front of every action: later frames are started and joined after the next turn
instead, labelled as one step old — and the panel says so once, because vision is a
setting you turned on and it must not stop being delivered behind your back.

**If a frame cannot be checked.** It is withheld, with the reason named in the
transcript. A frame nobody verified is not a frame that was clean.

**If the task is already done.** A task that is *nothing but a navigation* ("open yt")
has a checkable success state, and the loop checks the tab's URL at the top of every
step. When it matches, the run stops and reports the URL — it does not go looking for
work, and it does not click a video the task never asked for.

**If the final answer is not an answer.** Output that is punctuation soup, or that
narrates the agent's own loop ("this will be the last tool call for a while"), is
replaced with a notice and reported as a failure. It is never presented as the task's
result.

**If the page lies to the agent.** Text on the page that tries to instruct the agent
is detected and reported as page content, not followed.

---

## 10. The proof: the audit ledger

Every snapshot, detection, tokenization, redaction, verification and alert becomes an
entry in a SHA-256 hash chain. The chain is summarised into a Merkle root, and
*INSPECT PROOF* exports `audit-proof.json` containing the root and every leaf.

What that proves: the entries are in order and none was edited or removed — an
auditor recomputes the root from the leaves and detects any tampering.

What it does not prove yet: there is no per-leaf inclusion path, so you cannot hand a
single leaf to a third party and let them check it in `O(log N)`. That is a roadmap
item, and it is stated that way in the README too.

---

## 11. Voice

Dictation streams 16 kHz mono PCM16 over a WebSocket to ElevenLabs Scribe. The panel
sends it only when you tap the mic **twice** — tap to start, tap again to send, which
is exactly what the on-screen line says.

The privacy rule for voice lives in one function (`voice-core.toSpeakable()`): before
anything is spoken, vault tokens are replaced with the word "redacted", markdown is
flattened and length is capped. A token is a reason to **redact**, never a reason to
refuse — an earlier version refused to speak at all whenever a token appeared, and
that fire happened on almost every Gmail run because the tab title itself carries a
token.

---

## 12. What it honestly does not do

These are documented in the project rather than left for you to discover:

- **No completeness guarantee.** The badge says `✓ RE-OCR VERIFIED (N frames)` and
  means *"every region PRY painted is unreadable in the bytes that ship"*. It never
  means "this frame contains no PII". A face no channel found, or an email no pattern
  matched, is invisible to the verifier. Faces below roughly 12 px are reached by no
  channel at all.
- **Surrogates are not a cipher.** The fake values are derived from a hash, with no
  key. Anyone who sees a surrogate can brute-force the small digit space and recover
  the original. A keyed cipher (FF3-1 with WebCrypto) is on the roadmap; until then,
  anything that must not be recoverable should use the opaque tier.
- **The tripwire does not block.** It observes the page's outbound requests and
  reports PII-shaped egress, separating the page's own backend from third parties. It
  cannot stop a request — that would need a browser-enforced `declarativeNetRequest`
  rule, which is roadmap.
- **The vault is plain memory.** Token→value pairs are never written to
  `chrome.storage`, and they die when the service worker is torn down, but they are
  not encrypted and not partitioned per tab. An active worker's memory is the trust
  boundary.
- **Budgets are budgets.** A very heavy page gets redacted as far as the scan reaches
  (1.5 s / 8 000 nodes), a very tall frame is triaged top-down over at most six
  900 px slices, and a shortfall is logged rather than implied covered.
- **The planner is remote and fallible.** It receives tokenized text and a redacted
  frame — not the raw ones — but "no PII reached the model" is conditional on the
  detectors firing, and detectors have floors.

---

## 13. Will this be fast?

Two different costs, and only one of them is local:

- **Local pixel work:** ~1.2 s for a normal viewport, up to ~6.5 s at the six-tile
  triage cap. With vision off (the default) it is *started* and joined after the next
  planner turn, so it overlaps instead of adding.
- **The planner:** this is usually the slow half, and most of it is the provider.
  Reasoning models stream their thinking before any visible words, so the panel can
  sit at "waiting… no tokens yet" while the server is actually working; and a free
  tier queues the first request of a session. Switching to a non-reasoning model
  (for example Groq `openai/gpt-oss-20b`) or using the fast-planner option in Options
  moves this more than any client-side change can.

`npm run bench:latency` measures the local half with the shipped Tesseract stack and
the real tile geometry, and prints its cold-start number separately — that is what a
user pays on the first capture of a session.

---

## 14. Running, testing and building it

```bash
npm install          # once
npm run fetch-models # downloads the model weights (a Hugging Face token is optional)
npm run build        # writes 7 bundles into dist/
npm run typecheck    # tsc --noEmit
npm run verify       # the whole test suite (a couple of minutes — the OCR suite runs real Tesseract)
npm run bench:latency # per-capture pixel cost, tile geometry, cold start
```

Then load `dist/` as an unpacked extension in `chrome://extensions`
(Developer mode → *Load unpacked*), and **reload it after every rebuild** — an older
loaded build keeps reporting bugs that are already fixed.

The test suite is `1265` assertions across seven suites:

| Suite | Assertions | What it proves |
| :--- | :--- | :--- |
| `verify-pipeline.mjs` | 964 | The real shipped modules: detection, tokenization, redaction tiers, face fusion, region→image mapping, the frame-text channel, the ledger, the planner's judgement calls |
| `tripwire-test.mjs` | 31 | The MAIN-world egress observer, including that it never blocks |
| `ocr-test.mjs` | 11 | Real Tesseract on rendered images — the engine returns word boxes the triage can paint over |
| `screenshot-egress-test.mjs` | 41 | The ship/withhold decision, with evidence the pipeline actually produced |
| `offscreen-integration-test.mjs` | 98 | The offscreen document through its **real message listener** over **real pixels** — the reported box equals the black actually present in the shipped bytes |
| `agent-frame-audit-test.mjs` | 79 | The **real `runTask` loop** with only browser I/O and the two model endpoints stubbed |
| `voice-test.mjs` | 41 | The mic state machine, the Scribe wire shape, and the voice privacy transform |

The style of the tests is worth knowing: they prefer to drive the real module and
assert on real output (real pixels, real message path, real loop) over asserting that
a source file contains a string. Where a test *can* only pin source, it says why in
the comment above it.

---

## 15. A tiny glossary

| Word in the code | What it means in plain English |
| :--- | :--- |
| **Mesh 1 / Mesh 2** | The two perception channels: the DOM-based one, and the pixel-based one |
| **Tier-0** | The on-device model tier (NER, injection guard, BlazeFace) |
| **Token / vault** | `<CRED_1>` and its real value; the map holding them, in RAM only |
| **Surrogate** | A fake but format-valid replacement (a card number that still passes Luhn) |
| **Tier** (opaque / surrogate / soft) | How hard a region was destroyed |
| **Triage** | Reading a frame back with OCR to find text nothing else covered |
| **Escalation** | Rebuilding the whole frame opaque because the first paint was not enough |
| **Withheld** | The frame was not sent, and the reason was named |
| **Egress** | Bytes that left your machine |
| **DPR** | Device pixel ratio — CSS pixels vs real screen pixels, which every coordinate transform has to respect |
| **Stitched capture** | A full-page image made by scrolling and joining; it is treated differently from a viewport frame |
| **Tier-0 span / NER span** | A name or place the on-device model found in the page's text |

---

*If you want the formal version — the threat model, the Luhn/Verhoeff maths, the
Merkle construction, the full file tree and the per-channel detection limits — read
`README.md`. If you want to see the arguments for a design decision, read the
comment above it in the source; that is where they are written down.*
