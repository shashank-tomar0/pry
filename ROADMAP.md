# Elite Architecture Audit + Roadmap

## Architecture Diagram vs Current Implementation

| Diagram Component | Status | Gap |
|---|---|---|
| **CAPTURE** (DOM tree + screenshot) | ✅ Built | Working |
| **DETECT PII** (DOM signals, pattern, ML) | ✅ Built | BlazeFace shipped; NER/guard models optional (degrade cleanly) |
| **TEXT → TOKENIZE** (Aadhaar, PAN, names) | ✅ Built | Missing: tokenize user task too |
| **PIXEL → REDACT** (faces, signatures) | ✅ Built | Missing: signature/QR detection |
| **VAULT** (token ↔ value, memory only) | ✅ Built | Working |
| **SANITIZED CONTEXT** (tokens + redacted pixels) | ✅ Built | Still sends URLs (should be domain-only) |
| **Deterministic planner bypass** | ❌ Missing | No LLM skip for simple form fills |
| **LLM/VLM action planner** | ✅ Built | No client-side VLM yet |
| **VALIDATE + RESOLVE** | ⚠️ Partial | Missing: reject unknown IDs/tokens |
| **DO ACTION** | ✅ Built | Working |
| **VERIFY** (DOM diff, URL change) | ⚠️ Partial | Missing: proper DOM diff |
| **Task tokenization** | ❌ Missing | User request not tokenized in same vault |
| **Incremental re-perception** | ❌ Missing | Re-reads entire page every time |

## What Makes Us Elite (Not Just Functional)

### Tier 1: Core Architecture Gaps (Fix These First)

#### 1. Task Tokenization (FIX from diagram)
> "the request is tokenized too — same vault, same session — else the LLM can't match
> the name in the task to the sender on screen"

**Problem:** If user says "forward invoice from Sharma Traders", the LLM sees "Sharma Traders" in the task but the screen shows `<ORG_3>`. It can't match them.

**Fix:** Tokenize PII in the user's task using the same vault. The LLM sees:
```
Task: forward invoice from <ORG_3>
Page: ... element [7] = <ORG_3> ...
```

#### 2. VALIDATE + RESOLVE Layer (FIX 3 from diagram)
> "reject element IDs the client never sent, reject tokens the client never issued"

**Problem:** A hostile page or hallucinating model could reference element IDs or tokens we never created. Without validation, the executor runs untrusted commands.

**Fix:** Before executing any action:
- Check `element_id` exists in the latest snapshot
- Check any `<TOKEN_N>` in the action args exists in our vault
- Only resolve tokens at the last moment (already done, but add validation)

#### 3. Deterministic Planner Bypass
> "deterministic planner can do it? → form fill by label match, click by text match"

**Problem:** Every action goes through the LLM, even simple form fills that could be done deterministically. This wastes tokens and adds latency.

**Fix:** Before calling the LLM, check if the action can be resolved deterministically:
- If task is "fill name field with X" → find input near "name" label → type X directly
- If task is "click Submit" → find button with "Submit" text → click it
- Only escalate to LLM when deterministic resolution fails

### Tier 2: Visual Model Integration (Your Next Step)

#### 4. Client-Side VLM (On-Device Vision)
The problem statement requires: "a local Vision Transformer (ViT) or equivalent computer vision model 'reads' the user's screen"

**Options (ranked by feasibility):**

| Model | Size | Speed | What It Does |
|---|---|---|---|
| **ONNX MobileNet V3** | ~6MB | ~50ms | Screen content classification (form/email/social) |
| **BlazeFace via MediaPipe** | ~1MB | ~20ms | Proper face detection (replaces skin-color heuristic) |
| **PaddleOCR.js** | ~15MB | ~200ms | Text extraction from screenshots |
| **UI-TARS (ByteDance)** | ~2GB | ~2s | Full UI understanding (too heavy for browser) |
| **Custom ViT fine-tuned** | ~50MB | ~300ms | Screen element detection |

**Recommended approach:**
1. **BlazeFace** for face detection (replace skin-color hack)
2. **MobileNet V3** for screen content classification (know if it's a form, email, banking page)
3. The VLM "reads the screen" by combining DOM structure + screenshot classification

#### 5. Server-Side VLM Integration
The server (`server/vlm.ts`) already supports Anthropic/OpenAI vision. But it's not wired into the main agent loop.

**Fix:** When the client-side classifier detects a complex visual task (e.g., "read the CAPTCHA", "identify the graph"), send the redacted screenshot to the server VLM for visual understanding.

### Tier 3: Elite Features

#### 6. Incremental Re-Perception
> "re-perceive only the DOM subtrees that mutated — not the whole page"

**Problem:** After every action, we re-read the entire page (220+ elements). On complex pages this is slow and wastes LLM context.

**Fix:** Use MutationObserver to track which DOM nodes changed. Only re-perceive the changed subtrees.

#### 7. Parallel Tokenize + Redact
> "these are siblings, not sequential steps"

**Problem:** We tokenize THEN redact sequentially. They should run in parallel.

**Fix:** Use `Promise.all` for text tokenization and pixel redaction.

#### 8. DOM Diff Verification
> "VERIFY: DOM diff, URL change, error text"

**Problem:** After an action, we just re-perceive. We don't verify WHAT changed.

**Fix:** Compare before/after snapshots:
- Count of elements changed
- URL changed? (navigation happened)
- Error text appeared? (action failed)
- Form values changed? (typing worked)

#### 9. Signature/QR Detection
> "PIXEL-SHAPED → REDACT: faces, signatures, scanned ID cards, QR codes, handwriting"

**Problem:** We only detect faces. Signatures, QR codes, and scanned IDs are not detected.

**Fix:** Add template matching or lightweight CNN for:
- QR code detection (QR.js can detect, then destroy the region opaquely — QR
  payloads are their own identifier, so a blur here has the same weakness as a
  blurred face)
- Signature detection (edge detection + connected components)

#### 10. URL Sanitization
> "SANITIZED CONTEXT: domain only, no URL path"

**Problem:** We send full URLs in the DOM snapshot (e.g., `gmail.com/mail/u/0/#inbox/FMfcgzQXJWlKjnfBhRzWjXlKjnfBhRzW`). The path can contain sensitive data.

**Fix:** Strip URL path, keep only domain + first path segment.

## Implementation Order (Priority)

### Phase 1: Core Architecture (This Week)
1. ✅ ~~DOM-guided screenshot redaction~~ (DONE)
2. ✅ ~~Face detection~~ (DONE - skin-color, upgrade to BlazeFace later)
3. ✅ ~~PII detection on all input fields~~ (DONE)
4. 🔲 Task tokenization (tokenize user request in same vault)
5. 🔲 VALIDATE + RESOLVE (reject unknown IDs/tokens)
6. 🔲 URL sanitization (domain only)

### Phase 2: Visual Model (Next)
7. 🔲 BlazeFace integration (proper face detection)
8. 🔲 MobileNet V3 screen classification
9. 🔲 Server VLM integration (for complex visual tasks)

### Phase 3: Elite Features (After)
10. 🔲 Deterministic planner bypass
11. 🔲 Incremental re-perception
12. 🔲 DOM diff verification
13. 🔲 QR/signature detection
14. 🔲 Parallel tokenize + redact

## Testing Strategy

For each phase:
1. Build the feature
2. Load extension in Chrome
3. Test with a real task (e.g., "Open Gmail, compose email to test@gmail.com")
4. Check service worker console for pipeline logs
5. Verify Privacy Audit panel shows correct detections
6. Verify the action completes successfully

## On-Device NER Model Status (verified 2026-09-11)

**Running today (transformers.js token-classification, label-agnostic policy):**
`onnx-community/distilbert-NER` (PER/ORG/LOC). The loader (`src/ml/ner.ts`) keeps
any span whose model label names a PII class — ConLL PER/ORG/LOC, Piiranha-style
classes (EMAIL, PERSON_NAME, PHONE_NUMBER…), or GLiNER-style zero-shot labels
("name", "email address"…) — so swapping in a better token classifier needs zero
changes to the fusion layer. 311 assertions pin the policy.

**GLiNER is the Tier-1 target, and today it cannot run in the browser** (both
blockers verified against the live packages):
1. **No runtime.** transformers.js v4.2 (latest) has no GLiNER architecture —
   GLiNER's span-pair scoring head is not a standard token-classification head,
   and the only JS GLiNER runtime (`@lmoe/gliner-onnx`) depends on
   `onnxruntime-node`, which cannot run in the extension's offscreen document.
2. **Model size.** GLiNER-PII's quantized ONNX is 197 MB (fp16 333 MB) — ~4x the
   entire current package; the general `gliner_base` is similar order.

Unlock paths (pick when a real eval can gate it):
- **Precomputed label embeddings + onnxruntime-web**: GLiNER ONNX takes
  `labels_embeddings` as input — precompute the 60+ PII labels' embeddings once
  (a few hundred KB tensor) and run the main graph directly on onnxruntime-web
  (already vendored), bypassing transformers.js pipeline dispatch entirely.
- **Piiranha** (PII-specialized, 17 classes, 98%+ recall) is transformers.js-
  compatible but its quantized ONNX is 317 MB — out of package budget until
  distilling or a smaller PII-tuned checkpoint exists.
- **Port GLiNER's head into transformers.js** (upstream contribution) — then
  GLiNER-small (DeBERTa-small, ~25 MB q8) becomes the on-device PII brain.

## Irreversible Face Redaction (landed)

Faces used to be Gaussian-blurred. Blur is a low-pass filter, and super-
resolution deanonymization inverts it (arXiv 2506.12344 concludes blur should
not be used for face anonymization) — which made PRY's own Threat Vector 2 a
critique of PRY. Now:

- **Faces are destroyed**, not blurred: the region (expanded 15% past the
detector box, so the jaw and hairline go too) is overwritten with an opaque
`#000000` fill. No original pixel survives to be deconvolved.
- **The verifier enforces it.** `verifyRegions()` has a `DESTROYED_KINDS` rule
that rejects a face region which is merely *altered*; it must be near-uniformly
opaque (>= 90% covered). A future edit that reintroduces blur fails the check
rather than silently weakening the guarantee. The soft blur tier still exists
for non-identifying fields and is unchanged.
- **The adversarial auditor remediates.** When re-OCR reads PII out of any
soft-tier region, the auditor rebuilds the frame from the untouched original
pixels with *every* region opaque, re-encodes, and re-verifies — the escalated
image is what ships. The code now does what the docs always claimed.
- **Sampling can no longer hide content.** The verifier's pixel sampling uses a
row-phase-offset stride; a fixed stride that shares a factor with a region's
content period used to read periodic detail as a flat, "blank" region and skip
its redaction entirely.

To finish the story on the pixel side: signature and QR regions need the same
opaque treatment, and the audit view should distinguish "destroyed" from
"surrogate" from "soft-filtered" regions per frame.

## Known gaps found by the 2026-09-17 claim-vs-code audit

These are the places where something the project says and something the project
does still disagree. They are ordered by how likely a judge is to catch them.

1. **PII inside images is not detected at all.** Text painted into a photo, a
   `<canvas>` (PDF viewer, Google Docs), or a video frame is invisible to every
   detector, and the re-OCR pass only re-reads regions that were already
   redacted. A photographed ID card ships readable and the audit honestly shows
   zero detections for it. Fix: a whole-frame OCR triage pass (Tesseract, on a
   downscaled frame) that turns un-detected text into redaction candidates, plus
   a roadmap VLM sanity check.
2. **Surrogates are unkeyed.** The format-preserving mapping is a hash-derived
   Feistel-style construction, not FF3-1: anyone who sees a surrogate can
   brute-force the original over its digit space, and surrogates do ship when
   VLM vision is on. Fix: keyed FF3-1 with WebCrypto AES as the round function
   (needs an async surrogate path in the offscreen paint loop).
3. **Merkle inclusion paths are not exported.** `audit-proof.json` carries the
   root plus every leaf, so an auditor can recompute the root in O(N) and detect
   any edit — but there is no O(log N) sibling path for a single leaf.
4. **The vault is plain RAM, not encrypted or partitioned.** Token mappings live
   in a `Map` for the service worker's lifetime. AES-GCM at rest in memory and
   per-tab partitioning are the intended design.
5. **Face detection has no completeness guarantee.** BlazeFace is a short-range
   detector; the skin-colour pass that compensates is a colour heuristic, and
   supplementary additions are capped so a photo wall cannot blot the page. A
   missed face is silently missed, and the re-OCR verifier does not look for
   faces. Fix: a whole-frame face sweep at a second scale, and reporting the
   detector's channel mix per frame so a judge can see which channel fired.
6. **Text-PII pixel coverage is budget-bounded.** Region collection stops at
   1.5 s / 8 000 nodes / 200 regions and skips off-viewport matches, so a very
   heavy page redacts what it can reach, not everything. The on-screen receipt
   and the audit should say "budget reached" when that happens.
7. **Signature and QR regions** still need the opaque treatment (a QR code is a
   payload that survives any soft filter).
8. **The audit view should distinguish** destroyed / surrogate / soft-filtered
   regions per frame, so "redacted" cannot be misread as "irreversibly".

## What Judges Will See

When all features are built:

1. **Privacy pipeline**: Every screenshot shows opaque face destruction (not blur)
   + credential masking
2. **Token vault**: Sensitive values replaced with `<CRED_1>`, `<ORG_3>`
3. **Visual model**: Agent understands screen content (form/email/banking)
4. **Validation**: Agent rejects malicious commands from injected content
5. **Deterministic bypass**: Simple tasks complete in <1s without LLM
6. **Audit panel**: Full before/after comparison with detection chips
