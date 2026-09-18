# PRY, explained end to end — for anyone, not just for engineers

This is the "teach it to someone out in the world" document. It walks through what
PRY is, how it actually works under the hood, why it is built the way it is, and
where it is going. It assumes almost no background. Every mechanism name in bold
matches a file under `src/`, so you can jump to the code when you want the depth.

---

## Part 0 — Read this first: what problem are we even solving?

In the last two years the big jump in "AI that does things for you" has been the
**computer-using agent**. Instead of just chatting, an AI program literally drives
your screen: it opens Gmail, reads your mail, fills forms, books tickets, clicks
around. OpenAI's Operator, Anthropic's *computer use*, Google's Project Mariner,
Microsoft's Copilot agents, and a wave of open-source agents all do this.

How does an AI "see" the screen? Almost all of them do the same thing: **they take a
screenshot of your screen and send that image to a huge model on a server**. The
server model looks at the picture and says "OK, the search box is here, the button
is here, type this here."

Here is the uncomfortable part nobody talks about enough: **your screen is the most
sensitive surface you own.** One screenshot can contain, all at once:

- the draft email you are writing,
- the OTP that just arrived in a text box,
- the customer list behind a dialog,
- a card number you are entering,
- **and your own face in a video-call tile.**

So every computer-using agent is, by default, a machine that **copies your entire
private screen to a foreign data centre on every single step**. That is the problem
PRY is built against.

PRY's answer is not "don't use agents." It is: **let the agent use your secrets
without ever seeing them** — because the sensitive parts are removed *inside your
own browser*, before any pixel or any character leaves. And then it **proves** it
did that, so you are not taking its word for it.

PRY was built for the **Smart India Hackathon 2026**, problem statement **26171:
"On-Device Visual Perception for Lightweight Browser Agents."** The name of the
problem tells you the intended shape of the answer: the "perception" — the looking,
the understanding of the screen — should happen **on-device**, and the agent should
stay "lightweight."

---

## Part 1 — What is PRY, in one breath?

**PRY is a browser extension (Chrome / Firefox, Manifest V3) that runs web tasks
for you, while redacting every piece of personal data — faces, IDs, card numbers,
emails, passwords — on your device, before anything reaches an AI model.** It is
the opposite of cloud-agent privacy: instead of "trust us, we delete your screenshots
afterwards," PRY simply **never sends the raw thing in the first place**.

The one-line version people remember:

> **The agent can use your secrets without ever seeing them, and it can prove that
> to you afterwards.**

---

## Part 2 — The parts of PRY (the map)

A Chrome extension can't be one big program; the browser splits it into isolated
"worlds" that talk over messages. PRY has **six cooperating pieces**. Nothing runs
on a server except the "brain" model the user picks — and the brain only ever sees
tokens and redacted pixels.

| Piece | Lives at | What it is |
|---|---|---|
| **Service worker** | `src/background/` | The orchestrator / controller. Runs the task loop, owns the vault of real values, generates fake-but-valid replacement numbers, writes the audit ledger, enforces the firewall. |
| **Content script + tripwire** | `src/content/` | A tiny script injected into each page. It *reads* the page's structure (the DOM) to know where secrets sit and how big they are on screen in pixels. A second copy runs in the "MAIN world" to watch the page's own network calls for leaks. |
| **Offscreen document** | `src/offscreen/` | A hidden page that is the **only place a canvas exists**. This is where the pixel work happens: screenshots are captured, faces are detected, rectangles get painted black / blurred / replaced, and the finished image is re-checked and *attacked*. |
| **Side panel** | `src/sidepanel/` | The user interface: type a task, watch a live transcript, review a Privacy Audit (before/after images, verification status, the ledger, egress byte counter). |
| **Options page** | `src/options/` | Settings: which AI provider, which model, and the privacy toggles (destroy faces on/off, mask credentials on/off, scan text inside images on/off, vision on/off). |
| **Deep Inspector** | `src/inspector/` | A forensic full-page view: original vs. redacted, every detection boxed and labelled with exactly what redaction it got. |

The key architectural fact in all of this: **the canvas — the thing that can touch
image bytes — lives only in the offscreen document, and no image data is ever stored
to disk.** Bitmaps exist in memory, get destroyed, and are garbage-collected. That is
deliberate process isolation.

---

## Part 3 — How a task flows, one step at a time

Let's trace what actually happens when you type a task and press **Run**.

### Step 1 — Your task is sanitized before the AI even reads it

You type something like:

> "send an email to Priya Sharma about the invoice"

PRY's **tokenizer** (`src/background/tokenizer.ts`) scans your sentence, finds the
name "Priya Sharma", and replaces it with a **token**: `<PII_1>`.

It does **not** tell the model what `<PII_1>` is. It tells the model only a
*category*:

> `<PII_1> = a person, company or place name`

The real name "Priya Sharma" is stored in an in-memory **vault** — a plain map held
only in the service worker's RAM, **never written to disk**, cleared when the worker
is torn down.

Why do this? Because if the model is asked to "email Priya Sharma," it can carry out
the task ("address the message to the person named by `<PII_1>`") without ever
learning the name. Near the end, when the agent actually must type the name into the
"To:" box, PRY swaps the token back — **locally, in the browser, at the last
moment.** (This "resolve at execution" is the magic bit: see below.)

### Step 2 — The page is read through *two different pairs of eyes*

To know what's on the page, PRY looks at it two completely different ways, then
merges the results. The README calls these the **dual-mesh perception engine**.

**Mesh 1 — reading the structure (deterministic DOM analysis).** The content script
reads the page's DOM: every input field, its `type` attribute, ARIA labels, rendered
text. It asks: *is this a password box? a card box? an Aadhaar box?* It also extracts
text and matches it against high-precision regular expressions, and — crucially —
**validates the matches mathematically** before believing them (see Part 4). It measures
exactly where each sensitive thing sits on screen, in pixels, via
`getBoundingClientRect()`. This mesh is cheap and exact — but it is blind to anything
the page renders as a picture.

**Mesh 2 — reading the pixels (accelerated computer vision).** The offscreen document
takes the screenshot and runs real neural models on it (Part 5): **BlazeFace** finds
faces, an on-device **BERT** model finds person names in text that the DOM mesh might
have missed, and Chrome's own shape detector and a skin-colour pass back up the face
detection. This mesh sees what the DOM cannot: text baked into an image, a PDF
viewer, a video frame, a photograph.

**Fusion.** The service worker merges both meshes' findings, computes overlap
(Intersection-over-Union), and folds overlapping boxes into one region with a small
safety margin.

### Step 3 — Every secret is replaced or destroyed (redaction tiers)

Now PRY has a list of rectangles on screen, each tagged with a *kind* (face, card,
Aadhaar, email, phone, password field, name span). It does **not** redact them all
the same way, because not all redactions are equal. **One** decision table owns this
(`src/shared/region-paint.ts`) so that the code, the audit, and the on-screen label
can never disagree. The tiers:

| Tier | Applied to | Mechanism | Reversible? |
|---|---|---|---|
| **Opaque destroy** | faces; PII in page text | region overwritten with solid `#000000` | **No — zero original pixels survive** |
| **Surrogate inpaint** | confirmed credential/ID fields | real pixels discarded, a *fake-but-matching* value drawn in their place | No — the original was replaced, not filtered |
| **Soft box blur** | generic input fields, labels | a separable box average, computed in code | Yes in principle — *which is exactly why the next steps exist* |
| **Skip** | faces, when "destroy faces" is off | detected, reported, deliberately not painted | n/a — and honestly labelled `none` |

The face case is worth calling out, because it is the detail that shows PRY earns
its claims. **PRY never blurs a face — it destroys it with a solid fill.** Why?
A blur is a *low-pass filter*, and a low-pass filter is **mathematically invertible**.
Published work shows blurred faces can be re-identified by running the blur backwards
(deconvolution / super-resolution — the repo cites arXiv 2506.12344). So "blur the
face" is not a privacy control; it is a privacy *decor*. Destroying the pixels is.

### Step 4 — PRY reads back the exact bytes that are about to ship (verification)

After painting, PRY encodes the image (JPEG, because that is what actually gets sent),
then **decodes those exact bytes back** and re-checks every region at the pixel level
(`src/background/reocr-verification.ts`):

- is a destroyed region actually near-uniformly black? (merely "changed" is not enough
  for a face — a change is not the same as irreversibility)
- did a soft region actually change?
- did a "surrogate" region actually get repainted rather than left alone?
- was the region blank to begin with (nothing to leak)?

Then it composites the redacted regions into one strip and **re-reads them with OCR**
(real Tesseract, running locally). If any readable PII pattern survives inside a
region PRY chose to redact, that is a failing redaction.

**Who waits for all of that, and who does not.** It costs 1.2 s on a normal screen and
up to 6.5 s on a tall one, and the honest question is not "is it important" — it always
is — but **does the AI actually read the result?**

- With **vision on**, the AI reads the frame (through the VLM's description of the
  redacted image), so the run waits for the whole chain before its next turn.
- With **vision off** — the default — not one byte of that frame reaches the model. The
  chain is *local evidence*: the ledger entry, the audit panel, your PII totals, and the
  leak findings. So it runs **alongside** the model's next turn and is folded in
  afterwards, labelled as the previous step's frame. The work is not skipped, hidden, or
  downgraded; it simply stops sitting in front of a network call that never wanted it.

And it can never wedge a run: every wait on that chain has a ceiling (15 s, more than
2× the measured worst case). A capture that stalls is given up on **out loud**, and it
still files its own ledger entry in the background.

### Step 5 — PRY *attacks its own output* (the adversarial pass)

This is the part almost no other tool has, and it is the thing that found real bugs
in this very repo while it was being built (`src/background/redaction-attack.ts`).

Two probes:

1. **Reconstruction probe.** A blur is invertible, so PRY tries to invert its own
   blur. It *sharpens* each soft-teired region (an unsharp mask — a crude deconvolution)
   and measures how much of the region's **edge energy** survived. The shipped blur
   leaves a residual around `0.05–0.26`; a deliberately weakened blur reads `0.29–0.97`;
   an opaque fill reads `0.00`. Above a calibrated threshold (`0.35`) PRY judges that
   region **recoverable** — and escalates it to full opaque before anything ships.
2. **Face coverage probe.** It re-runs face detection over the *finished* image. A face
   the first pass missed is not a weak mask — it is a **missing** mask. Any face that is
   not mostly covered by a destroyed region is a leakage event: it gets boxed, painted
   opaque, and re-verified.

**Escalation.** If either probe finds anything, PRY rebuilds the whole frame from the
original pixels with **every** region painted opaque, then verifies *that*. The rebuilt
frame is what ships. The record of *why* it rebuilt is kept **separate** from *what is
still leaked* — so a pass that attacks-and-cleans is visibly different from a pass that
attacks-nothing.

### Step 6 — The firewall that checks before anything leaves (egress)

**No screenshot reaches a model unless a small evidence object passes all its gates**
(`src/shared/screenshot-egress.ts`). The gates demand: the face scan completed, the text
scan completed, the capture geometry was verified, the final scan completed, policy was
enabled, **residual detections are zero**, and the mask verification succeeded. There is
exactly one callback that can receive raw image bytes, and blocked frames never reach it.
If a frame is withheld, the reason is narrated to the user — never silently dropped.

### Step 7 — The agent acts (perceive → plan → act → verify)

The *planner* (the remote model the user chose) receives: the tokenized task, a
redacted page description, and — only if vision is enabled — the verified redacted
frame. It returns a **structured action** (click element 12, type "x" into field 3,
scroll down). PRY's executor (`src/background/executor.ts`) validates it and talks to
the content script, which physically clicks and types. When an action needs a secret
value, the token is swapped back **locally at the last moment**. The tools are kept
deliberately small and boring — `read_page`, `click`, `click_text`, `type`, `select`,
`scroll`, `key`, `find_text`, `wait` — nothing that can reach outside the browser.

**How many turns a task takes** is decided by the user's *own words*, not by the shape of
the example PRY was shown. This sounds obvious and was not: the prompt hands the planner
1–2 stored **routes** from earlier successful runs on the same site, and the old wording —
"copy the route, never the values" — was followed literally. A task saying "open YT and
search harkirat singh" was shown the route `navigate → type → click_text` (recorded from
a *different* task that did want a video opened), the planner recited it back — "I need to
follow the route: navigate → type → click_text" — and then clicked a video, which is an
action the user never asked for on their live browser, plus two further turns deciding
whether the unrequested click had worked. The stored route's *last* step is how that older
task ended; it is not part of the route. So the hint block now says so explicitly, and the
prompt's own scope rule says a search is finished when the results are visible. On this
task that is the difference between 5 planner turns (~113 s) and 3 (~40 s).

**How a turn is bounded** is worth knowing, because the user feels it. Each planner turn
is bounded by *silence*, not by a stopwatch: 60 s (90 s cold) for the very first token, 30 s
of quiet after output started, 210 s absolute. Two model-side failures get their own rule,
because "slow" and "wrong" are different problems:

- **Deliberation** — the model reasons past 12 000 characters or 90 s without taking an
action. It is told once to act with what it already has, then reported honestly.
- **Degeneration** — the model has collapsed into a **repetition loop** ("can make it one
  big things. can make it."). Deltas keep arriving, so *no silence window can see this*;
only repetition can. The guard measures the short-cycle repeat rate of the streamed words
  (plus a repeated 40-word block for long-period loops) and stops the turn in seconds. The
  live run that motivated it took **100 seconds** on `nvidia/nemotron-3.5-lightning-30b-a3b`
  and ended by presenting the loop to the user as the answer. A loop is never retried and
  never replayed in the next turn's history — and the same text is clamped to 1 200
  characters before replay in general, since the model's own monologue comes back to it
  every turn and is paid for every turn.

Every cut names its reason on screen. Nothing is ever stopped silently.

**And what a turn costs** is `{ system, tools, messages }`, ~24 KB measured — 9.9 KB of
system prompt, 4.5 KB of tool schemas, and ~10 KB of conversation. The first two are
byte-identical on every turn (a provider with prefix caching can skip re-reading them),
so the thing to keep flat is the conversation, and two pruning rules do that: stale reads
are dropped from older tool results, and once an action produces a *fresher* read, the
page read the run opened with is dropped too. That second rule is new and was a real leak:
it sat in the first message, which the tool-result prune never walked, so every turn after
the first carried **two** full page reads — one current and one stale — and the run's own
payload grew by a page read per step. A read at the content script's caps is ~9 KB, which
was ~48% of the conversation (27% of the whole request) on every turn. It is only dropped
when a fresher read genuinely exists: a read-only action renders nothing, and there the
opening read is still the planner's only view of the page.

### Step 8 — Everything is recorded in an un-editable ledger

Each perception → redaction → verification cycle appends a **SHA-256-hashed** entry to a
chain (`src/background/privacy-ledger.ts`): detection, tokenization, redaction, action,
verification. Each entry contains the hash of the previous one, so **editing or removing
any entry breaks the chain**. The panel shows the chain verdict (📜 Export Proof), and the
user can download `pry-audit-proof-*.json` with the leaves and a **Merkle root** over
the retained entries — a single hash that commits to the whole list. Change any entry
and the root changes.

---

## Part 4 — The "domain-elite" detail: checksums so you don't over-redact

This is the part that separates a real solution from a toy. A naive redactor blacks out
*anything that looks like a number*. But consider: someone viewing a page gets an order
number `4532 0150 1234 5674` — that **looks** like a card number. If PRY blacked out
every number-shaped string, it would destroy the user's ability to use the page.

PRY solves this with **mathematical checksums** (`src/shared/checksums.ts`):

- **Credit cards** use the **Luhn** checksum. The last digit of a real card is computed
  from the others; random 16-digit order numbers fail Luhn ~90% of the time. PRY only
  treats a string as a card if it passes Luhn.
- **Aadhaar numbers** use the **Verhoeff** algorithm — a stronger check that also
  catches transposed digits. PRY also rejects numbers starting 0 or 1 (UIDAI never
  issues them). Only genuine Aadhaar-shaped numbers pass.

So PRY turns regex hits into **validated detections**, and treats lookalikes as
*measured false positives* instead of burning them. This is the "domain elite" layer —
it knows the Indian identity-document space (Aadhaar, PAN, IFSC, +91 phone numbers)
because the problem is from an Indian national context.

### Surrogates: the fake-but-valid replacements

When PRY inpainits a credential field with a "surrogate" (`src/background/surrogates.ts`),
it does not just draw `<REDACTED>`. It draws a **synthetic number of the same length and
format that passes the checksum** — a card body whose Luhn digit is correct, an Aadhaar
whose Verhoeff digit is correct, a PAN-shaped string, a plausible email. Why? Because
the surrounding form the model is looking at still needs to make sense: if the field is a
16-digit card box, the model can reason about "a 16-digit value in the card box" even
though the value is fake and the real one is gone.

**Honesty note (stated in the code itself):** this surrogate generator is *unkeyed* —
it is a digest, not an encryption cipher (it is deliberately **not** NIST FF3-1). Given a
surrogate, the small remaining digit space can be brute-forced back. So anything that
absolutely must be unrecoverable belongs on the **opaque** path, not the surrogate path.
A keyed cipher is on the roadmap.

---

## Part 5 — The on-device models (real ML, running in your browser)

PRY's "perception" is not smoke and mirrors — it ships real, local ML. All of it runs on
your machine (WebGPU / WebAssembly), so **zero perceptual data leaves the device**:

- **BlazeFace** (`models/blazeface/`, ~224 KB TFLite): a single-shot face detector from
  MediaPipe, which runs on a WebGPU delegate with a CPU/WASM fallback. This is the primary
  face channel.
- **Quantized BERT NER** (`models/ner/`, ~108 MB ONNX): `dslim/bert-base-NER` quantized to
  8-bit integers, run via `@huggingface/transformers` + `onnxruntime-web` (WebAssembly
  SIMD). It finds person/organisation/location *names* in free-text prose — the things no
  regex can pin down. It is the recall layer; the regex/checksum layer is the precision
  layer.
- **Tesseract.js (WebAssembly LSTM)**: the OCR engine. Used both for the "read text baked
  into images" channel and for the adversarial re-OCR verifier.
- **Chrome Shape Detection API + a skin-colour pass**: backup face channels, so a face the
  model misses on its own still gets caught. The skin-colour heuristic is deliberately a
  *supplement*, not a replacement (its false-positive rate would over-redact on plain
  photos).

The models are **bundled** in `dist/`, so they load from the extension itself with no
download, and everything that can fail does so gracefully — if the model is missing, PRY
falls back to regex-only and *says so* rather than pretending.

---

## Part 6 — The egress tripwire: watching the page, not just the agent

A page you visit is not necessarily your friend — its own scripts may try to exfiltrate
data. PRY runs a **tripwire** in the page's *MAIN execution world* (`src/content/tripwire.ts`),
which wraps `fetch`, `XMLHttpRequest`, and `navigator.sendBeacon` to inspect outbound
payloads for card numbers, Aadhaar, PAN, and emails — using the **same** checksum-validated
logic — and it smartly **allowlists PRY's own surrogates** so it never reports its own
redaction work as a leak. Hits are aggregated into one live "EGRESS WATCH" entry with a
per-request radar log.

Honest scope: the tripwire *detects* and reports; it does not yet block (request-level
blocking is a roadmap item). It also correctly does *not* flag **your** normal traffic —
it flags payload *shapes* carrying identity data toward third-party endpoints.

---

## Part 7 — Voice and the "hands-free" path

PRY has a voice layer (built, partially wired):

- **Speech-to-text** streams 16 kHz PCM16 microphone audio to the user's STT provider
  (ElevenLabs Scribe) while a button is held. **Dictation is off by default** and fully
  opt-in; audio is never written to disk.
- **Text-to-speech** reads answers aloud via ElevenLabs Flash.
- The voice output has a **vocal privacy boundary**: any vault token is spoken as
  "redacted," so the speaker never accidentally says a secret out loud — and the token is
  never a reason to go *silent*. A guard that refused to speak whenever a token appeared
  meant any answer quoting one back (a tab title alone can carry `<CRED_1>`) produced an
  error line instead of audio; redaction is now the only behaviour, and the count of
  tokens read as "redacted" is reported so it cannot be mistaken for the model's words.

The privacy policy is explicit about the one honest caveat: a spoken secret is transcribed
*before* tokenization, so dictation of a card number would carry it to the STT provider.
That is why dictation is opt-in and off by default — if you do not want to send a value to
your speech provider, type it.

---

## Part 8 — What is *actually* verified, and the honest limits

PRY's culture is unusually honest about its own bounds — the README states them *before*
a judge can find them. This matters: an over-claim that a judge catches is a credibility
kill; a stated limit is evidence you know what you're doing.

**What is verified today** (`npm run verify`): **796 assertions across six suites** —
605 pipeline (detection, tokenization, ledger, egress, geometry, tiers, adversarial
thresholds calibrated against PRY's real blur), 27 tripwire, 11 OCR (real Tesseract over
rendered images), 37 egress, and **84 offscreen integration** that bundles the *real*
offscreen pipeline, drives it through its real message listener over real pixels, and
asserts the reported box equals the black actually present in the shipped bytes. Typecheck
and build also run on every push via CI.

**Stated limitations (each is a real row in the README, not a hypothetical):**

- **Detection recall is bounded.** A value no matcher, no checksum, and no model recognises
  is not redacted. Checked-shaped lookalikes that fail a checksum are deliberately left alone.
- **The green "verified" badge means something specific.** It means *"everything PRY chose
  to redact is unrecoverable in the bytes that ship."* It does **not** mean *"this frame
  contains no PII."* The panel says exactly this. Detection completeness is bounded by the
  three face channels, the regex/checksum matchers, and the on-device NER — with documented
  failure modes (a missed face is not detected; the re-OCR verifier does not look for faces;
  a frame taller than the OCR slice budget is triaged top-down and the shortfall is reported).
- **The reconstruction probe is a coarse guard, not a meter.** The shipped-blur and
  weakened-blur residual ranges touch, so it reliably catches a blur that *stopped working*
  but cannot resolve a marginal weakening.
- **Task-text redaction is a deliberate trade.** A name used as an ordinary object of a
  preposition in a non-messaging task ("go to Priya Sharma's profile") rides to the planner
  raw, because in a task that name *is* the instruction — a token the agent cannot read is a
  broken instruction. Names are still tokenized when they are message *payloads* and still
  redacted in every page/pixel channel.
- **The ledger trims at 500 entries**, and per-entry Merkle inclusion proofs are not exported
  yet (the root + leaves are).
- **Nothing here is a compliance certificate.** It is evidence about specific regions.

---

## Part 9 — The landscape: why this is ahead of the field

Let me place PRY in the wider world, because that is what a judge will probe.

### The mainstream agents all send your screen to the cloud

Every headline computer-using agent right now — OpenAI Operator, Anthropic computer use,
Google Project Mariner, Microsoft Copilot agents — operates by **capturing the screen and
sending the image to a cloud model**. Google's Mariner even ran as a Chrome **extension**
using Gemini, and explicitly described itself as "understanding the contents of your screen."
Project Mariner was **discontinued in May 2026**; that is worth knowing, because it means the
agent-as-extension idea was real but the privacy wall question was left unresolved. These
products' *privacy model* is "trust us, we purge screenshots after the run." That is a trust
claim, not a control.

### The "Guarding the user" line of research agrees with PRY

The papers named inside the repo — and the broader computer-security literature on LLM
agents (e.g. the prompt-injection / task-hijacking and data-leakage threat lines) — flag
exactly the attacks PRY defends against:

- **Screenshot leakage**: a single screen-capture is a bulk exfiltration of everything
  visible, including biometrics (your face) and credentials, even when the *agent* is the
  very thing you asked to help.
- **De-anonymisable blurring**: the published result (arXiv 2506.12344) that blurred faces
  can be re-identified. PRY takes this literally and refuses to blur biometrics.
- **Prompt injection / task hijacking**: page text that tricks an agent into ignoring
  instructions or leaking content. PRY treats page content strictly as *data*, has a local
  injection classifier + regex heuristic, and keeps a deny-by-default egress wall as a
  structural backstop.

### Where PRY genuinely differs from the packing

Across the existing privacy-tooling field, most solutions close **one** of three gaps;
PRY closes all three and treats proof as the product:

1. **Text** the model is told about (page snapshot + your own request) → tokenized with a
   category legend.
2. **Pixels** the model is shown (the screenshot) → detected and destroyed / replaced
   on-device, then verified against the exact shipped bytes.
3. **Proof** that 1 and 2 worked, and **remediation** when they did not → the adversarial
   attack pass, the escalation-to-opaque, and the hash-chained Merkle ledger.

It is also **BYOM (bring your own model)** — you pick the provider, down to **fully local
Ollama**, where literally zero bytes leave the machine (the toolbar badge honestly reads
`0 KB`). And it ships a **learning loop** (experience memory, reflection, learned rules) so
it gets better on real pages over time — a self-improving privacy wrapper rather than a
static mask.

---

## Part 10 — Future scope: what comes next, in the order that adds the most

The roadmap lives in `docs/pitch.md` §10 and the architecture far notes more. Merged and
prioritised by leverage:

1. **Math with a real key: replace the unkeyed surrogate generator with a keyed FF3-1
   cipher** (WebCrypto AES as the round function). This removes the one known-weak path —
   a surrogate a vision model sees could theoretically be brute-forced back. Everything else
   already routes to opaque.
2. **Real deconvolution / learned reconstruction** instead of the gradient probe, so
   "recoverable?" becomes *measured* rather than heuristic — same contract, drop-in.
3. **Request-level blocking on the tripwire** — turning detection into prevention (the
   "couldn't the page just exfiltrate?" answer closes completely).
4. **Per-entry Merkle inclusion proofs + an append-only checkpoint chain**, lifting the
   500-entry cap so you can hand a third party a single-leaf proof.
5. **Voice fully wired**: STT + TTS exists on this branch; pairing them with the transcript
   gives a hands-free agent that *narrates its own redactions* out loud.
6. **Face de-identification to the identity level**: PRY currently proves a face passed
   *detection* coverage; carrying a face-embedding model would let it prove a face is no
   longer *identifiable*. (The strongest honest statement today is "a detector can no longer
   find it," and it says so.)
7. **A published red-team report** — the adversarial probes are the right instrument; the
   natural next artefact is a repeatable attack suite run against PRY itself, so others can
   reproduce the guarantees.
8. **Wider model + runtime support** (the GLiNER swap is already designed for: the NER label
   layer is label-agnostic, so as soon as a WASM-compatible GLiNER runtime lands, PRY can
   swap a lighter, stronger NER in without touching the rest).
9. **Firefox parity** (the README says "Chrome and Firefox"; MV3 Firefox behaviour differs
   and is partial today).
10. **Exposing the evidence to auditors** — the whole design (a strict in-browser boundary
    plus an exportable, re-computable Merkle root) is aimed at enterprises that must prove
    to regulators that PII never reached a model.

---

## Part 11 — The vocabulary cheat sheet (so you can speak it)

| Word | Plain meaning |
|---|---|
| **PII** | Personally identifiable information — anything that identifies a person: name, email, phone, government ID, card number, credentials, face. |
| **MV3 / service worker** | The current Chrome extension platform; the background script is event-driven and can be killed anytime, which is why PRY keeps state in storage and chunks work. |
| **Offscreen document** | An invisible page an MV3 extension may create to do DOM/canvas work. PRY's entire pixel pipeline lives here. |
| **DOM mesh / pixel mesh** | Reading the page as structured data vs. reading it as pixels. PRY does both and fuses them. |
| **Token / vault** | A `<CRED_1>` placeholder that stands for a real value held only in browser memory (the vault). Resolved locally at the last moment. |
| **Checksum (Luhn / Verhoeff)** | A mathematical way to validate card numbers (Luhn) and Aadhaar (Verhoeff) so PRY doesn't redact random look-alike numbers. |
| **Redaction tier** | What actually happened to a region's pixels: `opaque` (destroyed), `surrogate` (replaced with a fake-but-valid value), `blur+escalate` (soft — shipped only if the attack failed to recover it), `none` (detected and deliberately left). |
| **Adversarial pass** | PRY trying to undo its own redaction (sharpen the blur, re-detect faces) and escalating to fully opaque if it succeeds. |
| **Egress** | Data leaving the browser. PRY counts every byte it sends and refuses image egress without complete evidence. |
| **Merkle root / hash chain** | A single hash that commits to a whole list (Merkle), and a chain where each entry contains the previous entry's hash (tamper-evidence). |
| **Tripwire** | A watch on the page's *own* network calls that flags PII-shaped leaks leaving the page. |

---

## Part 12 — The sixty-second summary (say this out loud)

> Every AI agent that can "look at your screen" is sending your screen to somebody else's
> server. That is the whole product now: give a model your eyes. And your screen is the most
> sensitive surface you own — your inbox, your bank, your Aadhaar number, your face on a
> video call.
>
> PRY is a browser agent that keeps its eyes **on your machine**. It reads the page, decides
> what's sensitive, and removes it **before** any pixel or character leaves the browser:
> emails and account numbers become tokens the model can use but cannot read; faces are
> destroyed with an opaque fill, not blurred, because a blur is a filter you can run
> backwards; and every frame it is about to send is **attacked first** — PRY tries to undo
> its own redaction, and if it succeeds it destroys the frame and rebuilds it before it
> ships.
>
> Then it proves it. Every run writes a hash-chained audit ledger you can export and verify,
> and the panel tells you which regions were masked, with which technique, and what the
> audit found when it attacked its own output.
>
> The one-line version: **the agent can use your secrets without ever seeing them, and it
> can prove that to you afterwards.**