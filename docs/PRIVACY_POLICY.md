# PRY Agent — Privacy Policy

_Effective date: September 8, 2026_

This privacy policy describes how the **PRY Agent** Chrome extension ("PRY", "we",
"the extension") handles data. PRY is a privacy-preserving browser automation tool:
it performs tasks you describe, while detecting, tokenizing, and redacting
personally identifiable information (PII) **on your device** before anything
reaches an AI model.

**Short version:** PRY does not sell, rent, share, or advertise your data. It has
no analytics, no tracking, no third-party SDKs, and no remote code. Everything
that can stay on your machine stays on your machine. The only data that ever
leaves your device is the task you typed and a PII-redacted page description —
sent only to an LLM provider **you** choose, only while a task is running, and
only over HTTPS.

---

## 1. Data processed on your device (never leaves it)

The following data is processed locally, inside your browser, and is **never
transmitted**:

- **Page content the agent reads.** PRY reads the DOM of the active tab while
  executing a task you submitted. This is only done on demand — never in the
  background, never on `chrome://`, `edge://`, or Web Store pages, and never
  without you submitting a task for that page.
- **Screenshots.** When visual perception is enabled, PRY captures the visible
  tab, detects sensitive regions (credential fields, faces, ID-like text), and
  redacts them — blurred, masked, or replaced with synthetic surrogates — all in
  an offscreen document on your machine. The redacted image is then re-OCR'd
  locally (bundled Tesseract) to verify no PII remains readable in the pixels.
  **Raw screenshots are never sent to any server.**
- **PII detection results.** Detected values (card numbers, Aadhaar, PAN, emails,
  phone numbers, API keys, etc.) are replaced with opaque vault tokens
  (`<CRED_1>`, `<ID_2>`) held in memory. Raw values exist only in your browser's
  memory and are resolved at the last moment, inside your browser, when an action
  needs them.

## 2. Data stored locally on your device

Stored in `chrome.storage.local` (your own disk, not cloud-synced):

- **Settings and API keys** for LLM providers you configure. Keys are stored
  unencrypted at rest on your own disk — the standard for Chrome extensions —
  and are used only to call the provider you selected.
- **Session history, learned rules, and the privacy ledger** from past runs.
  Tasks stored in experience memory are **tokenized** before saving — raw PII
  values are never written to disk.

You can clear all stored data at any time from the extension's options page,
from `chrome://extensions` (Details → Clear storage), or by uninstalling the
extension.

## 3. Data that leaves your device

Only the following is ever transmitted, and only while a task is running:

| What | Where it goes | When |
|---|---|---|
| Your **task text** and a **PII-redacted page description** (tokens, never raw values) | The LLM provider **you selected** in settings | While a task is running |
| A **redacted screenshot** (optional VLM vision) | The same LLM provider **you selected**, if you enabled vision | While a task is running |
| Nothing, if you use a local provider (e.g. **Ollama**) | — | Zero bytes leave your device |

Everything is sent over **HTTPS**. The toolbar badge shows an honest live count of
egress bytes ("0 KB" when nothing leaves).

## 4. Third-party LLM providers

PRY works with providers you bring: Anthropic, OpenAI, OpenRouter, Groq,
NVIDIA NIM, and local Ollama. The extension itself is not an LLM vendor and does
not operate or control any provider API. If you configure a provider, the
tokenized task data in section 3 is sent to that provider under **their** terms
and privacy policy. If you do not configure any provider, or use only Ollama,
no data is sent anywhere.

## 5. What PRY does NOT do

- No collection, sale, or sharing of personal information
- No analytics, telemetry, or crash reporting
- No advertising or tracking pixels
- No third-party SDKs or remote code
- No background scanning of your browsing
- No data processing when the extension is idle

## 6. Your choices and controls

- **Use local-only mode.** Configure Ollama and no task data leaves your machine.
- **Disable vision.** Turn off screenshot perception in options.
- **Review what was sent.** The INSPECT PROOF drawer shows every redaction and
  the exact image shipped.
- **Delete everything.** Clear storage from the options page or uninstall.
- **Uninstall.** Removing the extension deletes its local data.

## 7. Changes to this policy

If this policy changes, the effective date at the top of this page will be
updated and the extension's store listing will note the change.

## 8. Contact

For privacy questions or reports, open an issue on the project repository or
contact the developer at the address listed in the Chrome Web Store developer
profile.

---

_This policy is published as part of the open source repository; the version on
the Chrome Web Store listing is the authoritative copy._