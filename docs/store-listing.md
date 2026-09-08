# PRY Agent — Chrome Web Store Listing Kit

Ready-to-paste copy plus the justifications the Chrome review team asks for.
Keep this file in sync with `src/manifest.json` whenever permissions change.

---

## Listing fields

**Name:** PRY Agent
**Short name:** PRY
**Category:** Productivity
**One-line summary (≤132 chars):**
Browser automation that redacts passwords, IDs, and personal data on-device before
any screenshot or page text reaches an AI model.

**Full description (rich text):**

> **PRY runs your browser tasks — and proves nothing sensitive left your device.**
>
> PRY is a privacy-first browser agent. You describe a task ("open Gmail and read
> the first email", "fill this form"), and PRY drives the tab for you. Before a
> single pixel or character is handed to an AI model, every page snapshot passes
> through an on-device privacy pipeline:
>
> - **PII detection & tokenization** — Aadhaar, PAN, card numbers, emails, phones,
>   passwords, API keys, and more are detected and replaced with opaque vault
>   tokens (`<CRED_1>`). Raw values live in memory only and resolve at the last
>   moment, inside your browser.
> - **Checksum-gated validation** — Verhoeff (Aadhaar) and Luhn (cards) kill
>   regex false positives, so lookalike order numbers are never over-redacted.
> - **Screenshot redaction with proof** — sensitive screen regions are masked or
>   blurred on-device, then the exact shipped image is re-OCR'd locally to verify
>   zero PII remains readable in the pixels.
> - **Egress tripwire** — the page's own requests are watched for PII-shaped
>   leaks; intercepts are aggregated into one live EGRESS WATCH entry with a
>   per-request radar log.
> - **Self-improving** — a local learning loop records every run, learns rules
>   from false positives and repeated successes, and keeps an immutable privacy
>   ledger.
>
> **Works with your model, not ours.** Bring any provider — Anthropic, OpenAI,
> OpenRouter, Groq, NVIDIA NIM, or fully local Ollama. With Ollama, zero bytes
> leave your machine (the toolbar badge shows honest egress: "0 KB").

**Screenshots (1280×800) — GENERATED, ready to upload:**
Generated mockups matching the real panel design live in `assets/store/`
(`node scripts/gen-store-assets.mjs` regenerates them):

1. `screenshot-1-in-action.png` — agent filling a payment form; card/Aadhaar
   fields shown redacted to `<CRED_1>`/`<ID_3>`; EGRESS badge + ZERO-LEAK footer.
2. `screenshot-2-dashboard.png` — self-improvement dashboard: learned rules,
   lessons, replay library, ledger stats.
3. `screenshot-3-options.png` — provider selection: Anthropic, OpenAI, Groq,
   NVIDIA NIM, local Ollama (0 KB egress).
4. `screenshot-4-audit.png` — privacy audit: raw capture vs. redacted shipped
   image, re-OCR verification.

For maximum conversion, replace these with real captures before or shortly
after launch (recipe in `docs/launch-kit.md` §A6).

**Promo tiles (generated):** `assets/store/tile-440x280.png` (small tile) and
`assets/store/marquee-1400x560.png` (marquee).

---

## Permission justifications (manifest = source of truth)

| Permission | Why it is required | Single-use note |
|---|---|---|
| `sidePanel` | Open the agent panel in the toolbar. | — |
| `tabs` | Read the active tab's URL/title to describe the task and navigate between tabs. | — |
| `scripting` | Inject the content script into pages when needed (tabs that predate install). | — |
| `activeTab` | Act on the tab the user is currently viewing. | — |
| `storage` | Save settings, API keys, session history, learned rules, ledger locally. | No cloud sync. |
| `offscreen` | Run the canvas/OCR privacy pipeline outside the service worker. | — |
| Host `<all_urls>` | The agent must be able to open and drive **any site the user asks it to** (Gmail, banking, government portals, …). | The extension only ever touches a page when the user submits a task for the active tab. It never scans in the background and never runs on `chrome://`, `edge://`, or the Web Store. |

---

## Data-disclosure copy (developer dashboard "Privacy" tab)

- **Does your product comply with the Chrome Web Store User Data Policy?** Yes.
- **Single purpose:** this extension performs user-requested browser automation
  with on-device PII redaction; it has one purpose and no secondary data use.
- **Data used:** none of the following are collected, sold, or used for
  unintended purposes: personally identifying information, health/financial/
  authentication/website-content data, or personal communications. All PII
  handling is performed on-device.
- **Remote code:** the extension executes only its own bundled code; no remote
  code is loaded. Web fonts are fetched from Google Fonts; if they fail, local
  fallbacks are used.
- **What leaves the device:** (1) the page **description** the agent reads and
  the user's **task text** — both already PII-tokenized — are sent only to the
  **user-selected** LLM provider **when a task is running**, over HTTPS. With
  Ollama nothing is sent at all. (2) An optional re-OCR/redaction pipeline is
  fully local. Screenshots are never sent raw.
- **API keys:** stored in `chrome.storage.local` (unencrypted at rest on the
  user's own disk, standard for extensions) and used only against the chosen
  provider's API.
- **Certification:** the extension has no remote content, no obfuscation, and
  its minified bundles correspond to the open source tree in this repository.

---

## Pre-submission checklist

1. `npm run verify` passes (223 assertions) and `npm run build` is clean.
2. `publish/pry-agent-1.0.0.zip` contains the full `dist/` contents (see
   `docs/launch-kit.md` §A2 for the packaging recipe).
3. `dist/` loaded unpacked: toolbar icon (logo), side panel opens, a real task
   runs end-to-end.
4. `icons/` contains the brand icon at 16/32/48/128 — all replaced, none left
   from previous branding.
5. No console errors in the service worker or side panel during a task.
6. README clone URL + provider list + testing description updated (done).
7. Privacy policy from `docs/PRIVACY_POLICY.md` hosted at a public URL and
   pasted into the listing (required — this extension handles PII). Live URLs:
   `https://pry.shashanktomar.dev/privacy.html` (once DNS points) or
   `https://shashank-tomar0.github.io/pry/privacy.html` (live now).
8. Version number bumped in `src/manifest.json` for each new upload.
