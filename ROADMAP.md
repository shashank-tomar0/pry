# Elite Architecture Audit + Roadmap

## Architecture Diagram vs Current Implementation

| Diagram Component | Status | Gap |
|---|---|---|
| **CAPTURE** (DOM tree + screenshot) | ✅ Built | Working |
| **DETECT PII** (DOM signals, pattern, ML) | ✅ Built | Missing ML face/OCR model |
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
- QR code detection (QR.js can detect, then blur the region)
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

## What Judges Will See

When all features are built:

1. **Privacy pipeline**: Every screenshot shows face blur + credential masking
2. **Token vault**: Sensitive values replaced with `<CRED_1>`, `<ORG_3>`
3. **Visual model**: Agent understands screen content (form/email/banking)
4. **Validation**: Agent rejects malicious commands from injected content
5. **Deterministic bypass**: Simple tasks complete in <1s without LLM
6. **Audit panel**: Full before/after comparison with detection chips
