# PRY — the pitch, the demo, and the honest fine print

Everything here is written to be *said out loud*. Numbers come from the code and the
test suite in this repo, not from a slide deck. Where a claim is limited, the limit is
stated in the same breath — a judge who finds an over-claim for you has beaten you to it.

---

## 1. The pitch (60 seconds)

> Every AI agent that can "look at your screen" is sending your screen to somebody else's
> server. That is the whole product now: give a model your eyes. And your screen is the most
> sensitive surface you own — your inbox, your bank, your Aadhaar number, your face on a
> video call.
>
> PRY is a browser agent that keeps its eyes **on your machine**. It reads the page, decides
> what is sensitive, and it removes it **before** any pixel or any character leaves the
> browser: email addresses and account numbers become tokens the model can use but cannot
> read; faces are destroyed with an opaque fill, not blurred, because a blur is a filter you
> can run backwards; and every frame it is about to send is **attacked first** — PRY tries to
> undo its own redaction, and if it succeeds it destroys the frame and rebuilds it before it
> ships.
>
> Then it proves it. Every run writes a hash-chained audit ledger you can export and
> verify, and the panel tells you which regions were masked, with which technique, and what
> the audit found when it attacked its own output.
>
> The one-line version: **the agent can use your secrets without ever seeing them, and it
> can prove that to you afterwards.**

---

## 2. The problem, stated precisely

An LLM cannot see. So visual agents bolt eyes on: capture the screen, send the image to a
multimodal model. The moment you do that, one photo carries **everything on screen at
once** — the email you are drafting, the OTP that just arrived, the customer list behind the
dialog box, your own face in the corner. Text redaction alone is not enough, because a page
can render text as pixels (an image, a canvas, a PDF viewer, a video frame) where no text
matcher will ever find it.

Three separate failures have to be closed, and most tools close one:

1. **Text** the model is told about (the page snapshot, the user's own request).
2. **Pixels** the model is shown (the screenshot).
3. **Proof** that 1 and 2 actually worked — and remediation when they did not.

PRY closes all three, and treats the third as a feature rather than a log line.

---

## 3. What PRY actually is

A Chrome extension (Manifest V3) with six cooperating pieces. Nothing runs on a server
except the planner model, and the planner never receives raw sensitive values.

| Piece | Where it lives | What it does |
| :--- | :--- | :--- |
| **Service worker** | `src/background/` | The orchestrator: runs the task loop, owns the token vault, assembles the egress evidence, writes the audit ledger. |
| **Content script + tripwire** | `src/content/` | Reads the page (DOM mesh), measures where every sensitive value sits in pixels, and observes outbound `fetch`/XHR/beacon payloads from the page itself. It reports what left and where it went; it cannot block a request. |
| **Offscreen document** | `src/offscreen/` | The only place a canvas exists: capture, paint the redactions, verify the shipped bytes, attack them, escalate. |
| **Side panel** | `src/sidepanel/` | The live transcript, the Privacy Audit panel (before/after images, verification chip, ledger), the self-improvement dashboard. |
| **Options** | `src/options/` | Provider keys, model choice, and the privacy toggles (face destruction, credential masking, frame-text OCR, vision). |
| **Deep Inspector** | `src/inspector/` | A full-page forensic view: original vs redacted, every detection boxed and labelled with its redaction tier. |

**How a run flows, end to end:**

```
user's task ──► tokenize (vault) ─────────────► planner (remote, sees tokens + category legend)
                    ▲                                        │
                    │                                        ▼
              resolve at execution ◄── tool call (<CRED_1> for "4112…") ──► content script acts
                                                                              │
page capture ──► measure sensitive regions (DOM) ──► paint tiers ──► verify pixels + OCR
                                                                          │
                                                       attack own output ├─ reconstruction probe
                                                                          ├─ face coverage re-probe
                                                                          ▼
                                                        escalate if anything recovered
                                                                          │
                                                        egress guard (deny by default) ──► vision model
                                                                          │
                                                        audit ledger (hash-chained) ◄──── panel
```

---

## 4. The eight mechanisms (the part that makes it different)

### 4.1 One vocabulary for text and pixels
The same matchers decide what is sensitive in the DOM and in a text string
(`src/shared/text-pii-patterns.ts`): email, Indian mobile, Aadhaar (Verhoeff-validated),
PAN, IFSC, SSN, card (Luhn-validated), passport, API keys, JWTs, and cue-labelled names.
Both channels import the same module, so a value the screenshot channel would black out is
also taken out of the user's own request before the planner reads it.

### 4.2 Redaction tiers, one decision table
`src/shared/region-paint.ts` owns the ONLY place that decides *how* a region is destroyed,
and it returns a **plan** rather than drawing: the painter executes the plan and the audit
takes its proof box from the same op, so the marker and the mask cannot disagree.

| Tier | Applied to | Mechanism | Reversible? |
| :--- | :--- | :--- | :--- |
| **Opaque** | Faces, PII spans in text | Solid `#000000` fill | No — zero original pixels survive |
| **Surrogate** | Credential / ID fields | Real pixels discarded, a synthetic checksum-valid stand-in painted | No — the original was replaced, not filtered |
| **Soft blur** | Generic inputs, labels | Separable box average, computed in code (never `ctx.filter`, which silently no-ops on some Chrome builds) | Yes in principle — which is why §4.4 exists |
| **Skip** | Faces when destruction is off | Reported, deliberately not painted | n/a — and counted as *not* redacted. The UI badge for this tier reads **`none`**, the honest word for it |

The tier is recorded where the paint decision is made and travels with the detection. No
viewer re-derives it, because a viewer with its own copy of the rule is a viewer that can
label an unpainted region as a redaction — which is what the inspector used to do.

### 4.3 Verification that reads pixels, not intentions
After painting, PRY decodes **the exact bytes that will ship** and re-checks every region:
is the mask actually black, did a soft region actually change, did the region hold content
worth protecting in the first place. Then it composites the redacted regions into one strip
and **re-reads them with OCR** — scoped to those regions, so PII that is legitimately
visible elsewhere on the page does not create a false alarm.

### 4.4 The adversarial pass — PRY attacks its own output
This is the part most tools do not have, and this repo found real bugs while building it.

- **Reconstruction probe.** A blur is a low-pass filter, and a low-pass filter is
  invertible. PRY sharpens each soft region and measures how much of the region's original
  edge energy is still there. Opaque fill: `0.00`. The blur PRY ships: `0.05–0.26`. A blur
  weakened to radius 2–3: `0.29–0.97`. Above `0.35` it is judged recoverable.
- **Face coverage re-probe.** The detector is re-run over the *shipped* frame. A face the
  first pass missed is not a weak mask, it is a missing one — it gets boxed, painted and
  re-verified.
- **Escalation.** Either probe finding something rebuilds the whole frame from the original
  pixels with every region opaque, then re-verifies. The escalated frame is what ships, and
  the record of *why* is kept separately from *what is still leaked*.

### 4.5 Tokenization with a category legend
Sensitive values in the user's request and in the page become `<CRED_1>`, `<ID_1>`,
`<PII_1>`. The planner is told what each token *stands for* ("a person, company or place
name") without its value, and the value is swapped in at the last moment before a tool
call executes. The panel shows the user exactly which words of **their own sentence** were
replaced, masked (`"Pr••••••••••"` → `<PII_1>`), because a redaction you cannot see is
indistinguishable from the agent misreading you.

### 4.6 Deny-by-default egress
No screenshot reaches a model unless the evidence object says: the face scan completed, the
text channel completed, the capture geometry was verified, the final scan completed, policy
was enabled, and **residual detections are zero**. There is exactly one function that
receives image bytes, and blocked frames never call it. A withheld frame is narrated to the
user with its reasons — never silently dropped.

### 4.7 The audit ledger
Every perception → redaction → verification cycle appends a SHA-256-chained entry. The panel
shows the chain verdict (📜 **Export Proof**) and the export downloads
`pry-audit-proof-<timestamp>.json` with the leaves and the Merkle root over the retained
window, so an auditor recomputes the root and detects any edited or reordered entry.

### 4.8 The tripwire
A MAIN-world script wraps `fetch`/`XMLHttpRequest` and logs any request carrying PII shapes
out of the page — including from page scripts PRY does not control. It is detection, not
prevention, and it says so.

---

## 5. Glossary — every term you will be asked about

| Term | Plain meaning |
| :--- | :--- |
| **MV3 / service worker** | Chrome's current extension platform. The background script is event-driven and can be killed at any time, which is why state lives in storage and work is chunked. |
| **Offscreen document** | An invisible page an MV3 extension may create to do DOM-only work (canvas). PRY's entire pixel pipeline lives here. |
| **DOM mesh** | Reading the page as structured data: elements, roles, values, visible text. Cheap and exact, but blind to anything rendered as an image. |
| **Pixel mesh** | Reading the page as pixels: faces, DOM-mapped regions, OCR of the frame. Sees what the DOM cannot. |
| **Fusion** | Merging both meshes' detections, de-duplicating overlapping regions, keeping the union. |
| **PII** | Personally identifiable information — anything that identifies a person: names, emails, phone numbers, government IDs, card numbers, account credentials, faces. |
| **Aadhaar / Verhoeff** | Indian national ID (12 digits). Verhoeff is a checksum algorithm that catches transposed digits; PRY uses it so a random 12-digit number is not mistaken for an Aadhaar. |
| **PAN / IFSC / Luhn** | Indian tax ID; Indian bank branch code; Luhn is the checksum that validates card numbers. |
| **NER** | Named Entity Recognition — a model that finds names, organisations and places in free text. PRY runs one on-device (ONNX). |
| **BlazeFace / TFLite** | Google's small face detector, shipped as a TFLite model, run locally in the offscreen document. |
| **Tesseract / WASM** | An OCR engine compiled to WebAssembly, running locally. Used to read text baked into images. |
| **Skin-colour heuristic** | A classic, cheap face-candidate detector. Lower precision than a model, so it supplements rather than replaces it. |
| **Box blur / low-pass filter** | Replacing each pixel with the average of its neighbours. It destroys fine detail but keeps low-frequency structure — and it is mathematically invertible, which is why PRY never uses it for faces. |
| **Deconvolution / super-resolution** | The attack on a blur: recovering the original by reversing the filter. Published work shows blurred faces can be re-identified this way, which is why "blur the face" is not a privacy control. |
| **Residual edge energy** | How much of a region's original detail is still present after redaction. PRY's own measure of "did this blur actually destroy anything". |
| **Surrogate inpaint** | Replacing a credential field with a *fake* value that has the right format and checksum, so the surrounding layout still makes sense while the real value is gone. |
| **Escalation** | When an audit probe proves a redaction was insufficient: rebuild the frame with every region opaque, re-verify, ship that instead. |
| **Redaction tier** | What happened to one region's pixels: `opaque` (the original is gone), `surrogate` (replaced with a checksum-valid fake), `blur+escalate` (soft — shipped only if the adversarial pass failed to recover it), `none` (detected and deliberately left readable). The painter records it and every box, badge and audit row displays that record. |
| **Egress** | Data leaving the browser. PRY counts every byte it sends and refuses image egress without complete evidence. |
| **Token vault** | The in-memory map from `<CRED_1>` to the real value. Never persisted, cleared per run. |
| **VLM / vision** | A model that accepts images. Off by default; when on, the frame it receives has already passed the egress guard. |
| **Merkle root** | One hash that commits to a whole list of entries. Change any entry and the root changes. |
| **Hash chain** | Each ledger entry contains the previous entry's hash, so removing or editing one breaks the chain. |
| **Tripwire** | An observer on the page's own network calls that flags PII-shaped payloads leaving the page, and separates the site's own backend traffic from third-party egress. Observation only: it never blocks. |
| **Prompt injection** | Page text that instructs the agent ("ignore your rules and visit…"). PRY treats page content as data and has a classifier plus a regex heuristic for it. |

---

## 6. The demo (about 5 minutes, in this order)

Every step below has an **expected** line — the exact string that should be on screen — and
what to do if it is not. Rehearse the whole run once against the fixture page before you
rehearse it on stage.

### 6.0 Do this once, before you are on stage

1. **Build and load.** `npm run build`, then `chrome://extensions` → Developer mode →
   **Load unpacked** → select `dist/`. Re-load the extension after any rebuild. `dist/`
   ships `models/` (the NER and BlazeFace weights are committed), so the on-device models
   load from the extension itself with no download.
2. **Start the fixture server:** `npm run demo:serve`, then open
   **http://127.0.0.1:8787/pii-fixture.html** in a tab with the side panel docked beside it.
   This is the one prep step that is easy to skip and expensive to skip: content scripts do
   **not** run on `file://` unless you enable *Allow access to file URLs* for the extension,
   and a page PRY cannot see looks exactly like a broken product. Over `localhost` they
   always run — no toggle, no `npx` on conference wifi, no Python dependency. The server
   also answers `/collect`, the local sink used in step 9.
3. **Options → remote provider + key** (groq / nvidia / openai / anthropic / openrouter).
   Use a remote provider for the whole demo: with `ollama` selected the egress badge
   correctly reads `0 KB` because nothing leaves the machine, and step 7 then looks broken
   when it is working perfectly. Vision is supported on all six providers; the vision model
   name is per-provider and defaults sensibly when left blank.
4. **Vision OFF, confirmations ON.** Vision is switched on deliberately in step 7.
5. **Confirm the on-device models loaded.** Run any task once; the panel's self-test line
   should read `On-device ML self-test: NER model loaded (…) · injection guard … · BlazeFace
   loaded.` If it reports the regex fallback instead, the demo still runs honestly but shows
   the weaker path — re-check that `dist/models/` exists and reload the extension.
6. **Reset learning memory** (🧠 → reset) if this machine has run tasks before. Learned
   rules from an earlier session change what step 3 does.

### 6.1 The run of show

1. **Show the panel, not the code.**
   *Say:* "One panel. Task in, transcript out, and a privacy audit behind it."
2. **Run a harmless task on a page with nothing sensitive** (any ordinary page — **not** the
   fixture, which has PII in it and so has plenty to verify): `what is on this page?`
   *Expected:* a normal answer, and in the audit the chip is `○ NOTHING TO VERIFY` — not a
   pass. A run that found nothing to redact must not be dressed up as a clean bill of
   health, which is why it is not a green `✓ VERIFIED`.
   *Say:* "Zero findings is not the same claim as zero risk, and the panel refuses to
   conflate them."
3. **The task is redacted before the model sees it.** Type
   `send an email to Priya Sharma about the invoice` and press **Run**, then press **STOP**
   as soon as the privacy line appears — the run is not the point, the tokenization is,
   and stopping means no compose window opens anywhere.
   *Expected, on the line after the task you typed:* `Task privacy: 1 value(s) replaced
   before the model saw your request — "Pr••••••••••" → <PII_1>. The token is swapped back
   automatically when an action types it, so the task still uses your real value.`
   *Then point at the Wire log (📡):* the planner's prompt carries
   `<PII_1> = a person, company or place name` and never the name.
   *Say:* "The model can address the message. It has never seen the name. And the tokenizer
   tells me which words of my own sentence it took — a redaction you cannot see is
   indistinguishable from the agent misreading you."
   *If the line does not appear:* the task had no addressing context, so nothing was
   tokenized. Retry as `send this to Priya Sharma` or `addressed to Priya Sharma`.
4. **Now the page that has secrets in it.** Switch to the fixture tab from prep
   (**http://127.0.0.1:8787/pii-fixture.html**) and run `scan this page for PII`. When it
   finishes, open **◉ Privacy Audit** in the panel.
   *Why this matters:* the audit is re-fetched when the panel opens, so this works in either
   order — but running the task *first* means the screenshots you point at belong to the run
   you just described.
   *Point at:* the before/after pair — the boxes are drawn from the rectangle that was
   painted, so a marker cannot drift off its own mask — and the **Detected Regions** list,
   where every row now carries the tier it received (`opaque` / `blur+escalate` /
   `surrogate` / `none`). A region PRY deliberately left readable is labelled `none`; the
   box is drawn on it because it is a *finding*, not a fix.
   *Say:* "Opaque means opaque: the original pixels are gone, not filtered. Faces are never
   blurred, because a blur can be run backwards — that is published, not our opinion."
5. **Open the Deep Inspector** (🔬) and toggle the redacted view.
   *Expected:* every box is outlined on the redacted image too, each labelled with the tier
   recorded by the painter. The badge is taken from that record, not recomputed by the
   viewer — the viewer used to keep its own copy of the rule, and its copy labelled a face
   that was never painted as `opaque`.
   *Say:* "The proof marker and the mask come from one decision, so the image cannot claim a
   redaction that was not applied."
6. **The adversarial pass.** In the audit, find the adversarial line.
   *Expected, live:* `Adversarial re-check: attacked the shipped pixels — no recoverable
   blur, no uncovered face.` That is the **pass** case and it is the one you will get on
   stage. The escalation case says `Adversarial re-check found N recoverable blur(s) … —
   remediated and re-verified`, sets the chip to `↻ ESCALATED + VERIFIED`, and lists what
   the first paint got wrong under *Rebuilt before sending*.
   *Say:* "Before this frame shipped, PRY tried to undo its own redaction — it sharpened
   every blurred region to see what came back, and re-ran face detection on the finished
   image to catch a face the first pass missed. If either probe succeeds the frame is
   rebuilt opaque."
   *Do not claim to show escalation live:* reaching that branch requires weakening PRY's own
   blur, which the probe now correctly refuses to flag. It is proven by the suite (step 10)
   and by a recorded run — say that rather than promising a branch the next click will not
   produce.
7. **Turn vision ON** (⚙ Options → *Enable Visual Observation* → Save) and run the task
   again. Watch the badge in the panel header.
   *Expected:* the badge leaves `EGRESS —` and shows real bytes, e.g. `1.2 KB EGRESS`.
   *Say:* "Only now do pixels leave, and every byte that does is counted right there. That
   frame passed a guard that refuses anything with a residual finding — when the guard
   refuses, you get a narrated refusal with reasons, never a silent drop."
8. **The ledger,** at the bottom of the same audit panel: state the chain verdict, then
   press **📜 Export Proof**.
   *Expected:* the chain badge reads `INTACT` (`INTACT*` means entries past the 500-entry cap
   were trimmed, so the oldest surviving link cannot be checked — say that plainly if you see
   it), and the export downloads `pry-audit-proof-<timestamp>.json` with the entries and the
   Merkle root over the retained window.
   *Say:* "Hash-chained in the browser. Recompute the root and a single edited entry shows
   up."
9. **The tripwire,** on the fixture page: press **Leak the values above** (leave the clean
   control for the follow-up).
   *Expected:* the request goes to a local collector on `127.0.0.1` that discards it, and the
   shield (🛡️) shows a row like
   `CREDIT_CARD POST 127.0.0.1 •••• •••• •••• 1111 20:01:45`. Then press **Clean request
   (control)** and point out that the radar stays empty — it flags payload *shapes*, not
   traffic.
   *Say:* "PRY does not control this page's scripts, and this one tried to leave with a card
   number. The value never left the machine — I aimed it at a local sink — but PRY inspected
   it before it was sent."
10. **Close on the test suite.** `npm run verify`.
    *Say:* "796 assertions over six suites. One bundles the real offscreen pipeline, drives
    it through its real message listener and asserts the reported box equals the black
    actually present in the shipped bytes. Another drives the real agent loop with only
    browser I/O and the model stubbed, and pins the evidence contract: what the planner is
    shown, what the ledger records, and that a capture which never returns ends the run
    instead of hanging it. This runs on CI on every push."

### 6.2 If something goes wrong on stage

| Symptom | What it means | What to do |
| :--- | :--- | :--- |
| Agent says it cannot see the page | The tab is `file://` (or `chrome://`, where no extension may run) | Switch to the `127.0.0.1:8787` fixture tab and rerun |
| `Screenshot withheld: …` in the transcript | The egress guard refused a frame — the guard working, not a crash | Read the reasons aloud; they name the channel (`PIXEL:` / `OCR:` / `RECONSTRUCTION:` / `FACE COVERAGE:`) |
| Audit panel looks empty | No run recorded in this service worker | Run one task with the panel open; the panel also re-fetches on open, so open it *after* the run |
| Egress badge stays at `0 KB` | The configured planner is local (`ollama`), or vision is still off | Switch to a remote provider and confirm the vision toggle saved |
| A second run behaves oddly | It learned from the first run | 🧠 → reset learning memory, then rerun |

---

## 7. Judge Q&A — the answers, including the awkward ones

**"Blurring is enough, isn't it?"** No, and this is the crux. A blur is a low-pass filter
with a known kernel; deconvolution and super-resolution recover the original. Faces are
destroyed with an opaque fill, and any blurred region that PRY's own reconstruction probe can
read is escalated to opaque before shipping.

**"How do you know the redaction worked?"** Three ways: pixel checks on the decoded shipped
bytes, an OCR re-read scoped to the redacted regions, and the adversarial probes in §4.4.
The panel states the scoped claim — "everything redacted here is verified in the shipped
image" — never "this frame contains no PII".

**"What about a face your detector missed?"** Real risk, and it is documented as a known
gap: detection is bounded by the three face channels (BlazeFace, Chrome's detector,
skin-colour). The adversarial pass re-runs the model detector on the *finished* frame and
escalates any face outside the destroyed regions, which closes the "missed during
redaction" case but cannot close "missed twice".

**"Couldn't the model just ask for the raw value?"** It never has it. Raw values are in an
in-memory vault; the planner sees tokens plus a category legend, and resolution happens
locally at execution.

**"What stops the page from exfiltrating?"** Nothing outright — the tripwire *detects* it
and reports it. Prevention would need request-level blocking, which is on the roadmap.

**"Why should I trust your numbers?"** Because the harness drives the real pipeline. The
offscreen integration test bundles the actual module, stubs only its browser dependencies,
and asserts the reported box is ≥90% black in the bytes it just produced.

---

## 8. Honest limits (say these before a judge finds them)

- **Detection recall is bounded.** A value no matcher and no model recognises is not
  redacted. Checked-shaped lookalikes (a number that fails Verhoeff/Luhn) are deliberately
  not treated as identity documents — except when the user's own words label them.
- **The reconstruction probe is a coarse guard, not a meter.** Measured across five content
  patterns, the shipped blur's residual tops out at `0.26` while a weakened radius-3 blur
  starts at `0.21` — the ranges touch. It reliably catches a blur that silently stopped
  working; it cannot resolve a marginal weakening.
- **Task-text redaction is a deliberate trade.** A name used as an ordinary object of a
  preposition in a non-messaging task ("go to Priya Sharma's profile") reaches the planner
  raw, because in a task that name *is* the instruction. Names are still tokenized when they
  are a message payload, and still redacted in every page and pixel channel.
- **The ledger trims at 500 entries,** and the export states the window the Merkle root
  covers. Per-entry inclusion proofs are not exported yet.
- **Frame-text OCR is off by default** and bounded (6 slices, 8 s each); a very tall page is
  triaged top-down and the shortfall is reported, not implied covered.
- **Nothing here is a compliance certificate.** It is evidence about specific regions.

---

## 9. What is verified today

```
npm run verify
  605  pipeline assertions   (detection, tokenization, ledger, egress, geometry, tiers,
                              voice privacy + mic-permission diagnostics, capture policy,
                              the run-scoping rules in the prompt, adversarial thresholds
                              calibrated against PRY's own blur)
   27  tripwire assertions
   11  OCR assertions         (real Tesseract over rendered fixtures)
   37  egress assertions      (the guard, driven by the real evidence producers)
   84  offscreen integration  (the real pipeline, real pixels, real message path,
                              including that the tier recorded for each region is the
                              tier it was painted with, and the OCR warm-up message)
   32  agent loop             (the REAL runTask loop with only browser I/O and the two
                              model endpoints stubbed: the frame-evidence contract, and
                              the per-turn payload budget — that no turn carries two page
                              reads, and that the request does not grow with step count)
```

Plus `npm run typecheck` and `npm run build`, all three run on every push by
`.github/workflows/verify.yml`.

---

## 10. What next (in the order that adds the most)

1. **Fix the residual/normal-source ambiguity end to end.** Residuals are now labelled with
   the channel that found them (`PIXEL:` / `OCR:` / `RECONSTRUCTION:` / `FACE COVERAGE:`),
   which is what makes the next occurrence diagnosable instead of a bare count.
2. **A residual & coverage panel.** The audit should show what was *not* covered — every
   detection miss and unredacted region — next to what was.
3. **Real deconvolution instead of a gradient probe.** Swap the heuristic for a learned
   reconstruction so recoverability is *measured*; the contract does not change, so this is
   a drop-in.
4. **Request-level blocking on the tripwire,** turning detection into prevention.
5. **Per-entry Merkle inclusion proofs** and an append-only checkpoint chain, removing the
   500-entry cap.
6. **Voice, fully wired.** STT (Scribe) and TTS (Flash) exist on this branch; pairing them
   with the transcript gives a hands-free agent that narrates its own redactions.
7. **A published red-team report.** The adversarial probes are the right instrument; the
   natural next artefact is a repeatable attack suite run against PRY itself.
