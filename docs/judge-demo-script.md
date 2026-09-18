# PRY — the live demo, scripted for the judge

This is the on-stage script. It is built to be **said out loud, not read to the room**.
Every expected line is the exact string that should be on screen. Where a claim is
bounded, the bound is in the script too — a judge who finds an over-claim has beat
you to it.

The full mechanics behind every talking point live in
[`docs/deep-explainer.md`](./deep-explainer.md) — read that once if you want the "why"
behind each line. This file is just the run.

---

## ⏱ Timing budget (aim: ~6 minutes)

| Time | Section |
|---|---|
| 0:00 – 0:45 | Opening pitch (memorise this) |
| 0:45 – 1:15 | The problem, stated precisely |
| 1:15 – 3:15 | The run of show (the 10 moves) |
| 3:15 – 4:00 | The two hardest questions demo'd live |
| 4:00 – 4:45 | Close on the test suite |
| 4:45 – 6:00 | Judge Q&A |

Rehearse the whole run once against the fixture page before you rehearse on stage.

---

## Part A — The opening pitch (45 seconds, memorised)

> Every AI agent that can "look at your screen" is sending your screen to somebody else's
> server. That is the whole product now: give a model your eyes. And your screen is the
> most sensitive surface you own — your inbox, your bank, your Aadhaar number, your face
> on a video call.
>
> PRY is a browser agent that keeps its eyes **on your machine**. It reads the page, decides
> what's sensitive, and removes it **before** any pixel or character leaves the browser:
> emails and account numbers become tokens the model can use but cannot read; faces are
> destroyed with an opaque fill, **not** blurred, because a blur is a filter you can run
> backwards; and every frame it's about to send is **attacked first** — PRY tries to undo
> its own redaction, and if it succeeds it destroys the frame and rebuilds it before it ships.
>
> Then it proves it. Every run writes a hash-chained audit ledger you can export and verify.
> The one-line version: **the agent can use your secrets without ever seeing them, and it
> can prove that to you afterwards.**

*(Stop. Let the line land. Then:)*

---

## Part B — The problem, stated precisely (30 seconds)

> An LLM can't see. So visual agents bolt eyes on: capture the screen, send the image to a
> multimodal model. The moment you do that, one photo carries **everything on screen at once**
> — the email you're drafting, the OTP that just arrived, the customer list behind the
> dialog, your own face in the corner. Text redaction alone is not enough, because a page
> can render text as pixels — an image, a canvas, a PDF viewer, a video frame — where no
> text matcher will ever find it.
>
> Three separate failures have to be closed, and most tools close one. **Text** the model is
> told about. **Pixels** the model is shown. And **proof** that both actually worked — with
> remediation when they didn't. PRY closes all three.

---

## Part C — The run of show (10 moves, ~2 minutes)

### 0. Prep — do this once, before you're on stage

1. **Build and load:** `npm run build`, then `chrome://extensions` → Developer mode →
   **Load unpacked** → select `dist/`. Re-load after any rebuild. `dist/` ships `models/`,
   so on-device models load from the extension itself with no download.
2. **Start the fixture server:** `npm run demo:serve`, then open
   **http://127.0.0.1:8787/pii-fixture.html** in a tab with the side panel docked beside it.
   This is the one easily-skipped, expensive-to-skip step: content scripts do **not** run on
   `file://`, and a page the extension can't see looks exactly like a broken product. Over
   loopback they always run. The server also answers `/collect`, the local sink used in move 9.
3. **Options → remote provider + key** (groq / nvidia / openai / anthropic / openrouter).
   Use a **remote** provider: with `ollama` the egress badge honestly reads `0 KB` and move 7
   then looks broken when it's working.
4. **Vision OFF, confirmations ON.** Vision is switched on deliberately in move 7.
5. **Confirm on-device models loaded:** run any task; the self-test line should read
   `On-device ML self-test: NER model loaded (...) · injection guard ... · BlazeFace loaded.`
   If it reports the regex fallback, the demo still runs honestly but shows the weaker path —
   re-check `dist/models/` and reload.
6. **Reset learning memory** (🧠 → reset) so earlier sessions' learned rules don't change the run.

### Move 1 — One panel, no code
*Say:* "One panel. Task in, transcript out, a privacy audit behind it."

### Move 2 — A clean page, honestly not a "clean bill"
Run on any ordinary page (the fixture has PII and so has plenty to verify): `what is on this page?`
*Expected:* a normal answer; in the audit the chip is `○ NOTHING TO VERIFY` — **not** a green
`✓ VERIFIED`.

*Say:* "Zero findings is not the same claim as zero risk, and the panel refuses to conflate them."

### Move 3 — Your task is redacted before the model reads it
Type `send an email to Priya Sharma about the invoice`, press **Run**, then **STOP** the
moment the privacy line appears — the run isn't the point, the tokenization is.
*Expected,* on the line after your task:

> `Task privacy: 1 value(s) replaced before the model saw your request — "Pr••••••••••" → <PII_1>.`

Open the Wire log (📡): the planner's prompt carries `<PII_1> = a person, company or place
name` — never the name.

*Say:* "The model can address the message. It has never seen the name. And the tokenizer
tells me which words of my own sentence it took — a redaction you can't see is indistinguishable
from the agent misreading you."
*Fix if missing:* the task had no addressing context — retry as `send this to Priya Sharma`.

### Move 4 — Now the page that has secrets in it
Switch to the fixture tab and run `scan this page for PII`. When it finishes, open **◉ Privacy Audit**.
For the **decoys**: the audit should **leave the order-ref and the Luhn-failing card visible** —
lookalikes are counted as measured false positives, not burned.

*Say:* "Section 3 of this page is deliberate: an order number and a card-shaped string that
fail the checksums. PRY leaves them readable — over-redaction is the failure you don't hear
about because nobody shows you the damage. Checksum-validated detection is what stops a real
tool from wrecking your form while a toy blacks out everything."

Point at the **Detected Regions** list, where every row carries the tier it received
(`opaque` / `surrogate` / `blur+escalate` / `none`).

*Say:* "Opaque means opaque: the original pixels are gone, not filtered. Faces are never
blurred, because a blur can be run backwards — that is published, not our opinion."

### Move 5 — The Deep Inspector, one decision
Open the Deep Inspector (🔬) and toggle the redacted view. Every box is outlined on the
*redacted* image too, labelled with the tier the painter recorded.

*Say:* "The proof marker and the mask come from **one** decision — the same rectangle and
the same tier — so the image cannot claim a redaction that wasn't applied. A viewer used to
keep its own copy of the rule, and its copy labelled a face that was never painted as opaque.
That drift is exactly what this closes."

### Move 6 — The adversarial pass (PRY attacks itself)
In the audit, find the adversarial line.
*Expected, the **pass** case:* `Adversarial re-check: attacked the shipped pixels — no
recoverable blur, no uncovered face.`
*The escalation case reads:* `Adversarial re-check found N recoverable blur(s) ... — remediated
and re-verified`, chip reads `↻ ESCALATED + VERIFIED`.

*Say:* "Before this frame shipped, PRY tried to undo its own redaction — it sharpened every
blurred region to see what came back, and it re-ran face detection on the finished image to
catch a face the first pass missed. If either probe succeeds, the frame is rebuilt opaque.
**Don't promise this branch live** — reaching it needs weakening PRY's own blur. It's proven
by the suite in move 10, and the pass case is what you'll get on stage. Say that, then move on."

### Move 7 — Turn the leash on: vision ON, watch egress
In ⚙ Options → enable *Visual Observation* → Save, rerun the task, and watch the badge.
*Expected:* the badge leaves `EGRESS —` and shows real bytes, e.g. `1.2 KB EGRESS`.

*Say:* "Only now do pixels leave, and every byte that does is counted right there. That frame
passed a guard that refuses anything with a residual finding — and when the guard refuses,
you get a narrated refusal with reasons, never a silent drop."

### Move 8 — The ledger
At the bottom of the audit: state the chain verdict, then press **📜 Export Proof**.
*Expected:* the chain badge reads `INTACT` (if it reads `INTACT*`, entries past the 500 cap
were trimmed — say that plainly), and `pry-audit-proof-<timestamp>.json` downloads.

*Say:* "Hash-chained in the browser. Each entry hashes the previous one, and a Merkle root
commits to the whole list. Recompute the root and a single edited entry shows up."

### Move 9 — The tripwire (the page can't leak either)
On the fixture page, press **Leak the values above** (the clean control is the follow-up).
*Expected:* the shield (🛡️) shows a row like
`CREDIT_CARD POST 127.0.0.1 •••• •••• •••• 1111 20:01:45`. Then press **Clean request (control)**
and point out the radar stays empty — it flags payload *shapes*, not traffic.

*Say:* "PRY doesn't control this page's scripts, and this one tried to leave with a card
number. The value never left the machine — I aimed it at a local sink that discards it — but
PRY inspected it before it was sent."

### Move 10 — Close on the test suite
`npm run verify`.
*Say:* "**796 assertions over six suites**, including a harness that bundles the **real**
offscreen pipeline, drives it through its real message listener over **real pixels**, and
asserts the reported box equals the black actually present in the shipped bytes. Typecheck
and build run on every push by CI."

---

## Part D — The two hardest questions, demo'd live

If you have room, *do* these rather than only describing them.

**D1 — "But isn't blur enough?"** *(answer, then show)*
*Answer in one breath:* "No — a blur is a low-pass filter with a known kernel, and
deconvolution / super-resolution recovers the original. This repo cites the published result
that blurred faces are re-identifiable. That's why faces are destroyed with an opaque fill,
never blurred."
*Show:* bring up the audit's adversarial line from move 6 and point at the numbers — opaque
reads `0.00` residual, the shipped blur reads `0.05–0.26`, a deliberately weakened blur reads
`0.29–0.97`, and the threshold at `0.35` sends anything recoverable to fully opaque. "The
probe is calibrated against PRY's **own** blur kernel — not a blur a test wrote to pass."

**D2 — "How do I know the redaction actually worked?"**
*Show:* "Three ways, and the panel states the scoped claim. Pixel checks on the exact incoming
bytes. An OCR re-read scoped to the redacted regions — so an email legitimately visible elsewhere
on the page does not false-alarm. And the two adversarial probes. The badge says exactly this:
*'everything redacted here is verified in the shipped image'* — never *'this frame contains no PII.'*"

---

## Part E — Honest limits (say these before a judge finds them)

- **Detection recall is bounded.** A value no matcher, no checksum, and no model recognises
  is not redacted. Checksum-failing lookalikes are deliberately left alone — that's move 4's
  decoy section.
- **The reconstruction probe is a coarse guard, not a meter.** It reliably catches a blur that
  stopped working; it cannot resolve a marginal weakening.
- **The green "verified" badge is scoped.** It covers the regions PRY chose to redact, not
  every PII on the page.
- **Task-text redaction is a trade.** "Go to Priya Sharma's profile" rides raw because that
  name *is* the instruction; names are still tokenized when they're message payloads and still
  redacted in every page/pixel channel.
- **Nothing here is a compliance certificate.** It's evidence, exported, about specific regions.

---

## Part F — Judge Q&A cheat sheet

**"What stops the page itself from exfiltrating?"** The tripwire detects and reports it
right now; request-level **blocking** is a roadmap item. Detection is what ships today, and
it says so.

**"Could the model just ask for the raw value?"** It never has it. Raw values live in an
in-memory vault the model can't see; it only ever sees tokens plus the category legend, and
resolution happens locally at execution.

**"Why should I trust your numbers?"** Because the harness drives the real pipeline — bundles
the actual offscreen module, stubs only browser APIs, and asserts the reported box is ≥90% black
in the bytes the real code just produced.

**"What about a face your detector missed?"** Real and documented: detection is bounded by the
three face channels. The adversarial pass re-runs detection on the finished frame and escalates
any face outside the destroyed regions — which closes "missed during redaction" but cannot close
"missed twice." That's on the honest-limits slide too.

**"Why is a surrogate weaker than an opaque fill?"** The surrogate generator is unkeyed, so
given a surrogate the small digit space could be brute-forced back. Anything that must be
unrecoverable is routed to opaque; a keyed cipher is on the roadmap. Saying this openly is
stronger than hiding it.

---

## Part G — If something goes wrong on stage

| Symptom | Meaning | Fix |
|---|---|---|
| Agent says it can't see the page | Tab is `file://` (or `chrome://`) | Switch to the `127.0.0.1:8787` fixture tab and rerun |
| `Screenshot withheld: ...` in transcript | The egress guard refused a frame — working, not crashing | Read the reasons aloud; they name the channel (`PIXEL:` / `OCR:` / `RECONSTRUCTION:` / `FACE COVERAGE:`) |
| Audit panel looks empty | No run recorded in this service worker | Run once with the panel open; it also re-fetches on open, so open it *after* the run |
| Egress badge stays `0 KB` | Local model (`ollama`) or vision still off | Switch to a remote provider; confirm the vision toggle saved |
| A second run behaves oddly | It learned from the first | 🧠 → reset learning memory, rerun |

---

## Part H — The one-line close (memorise it)

> The agent can use your secrets without ever seeing them — and it can prove that to you
> afterwards.