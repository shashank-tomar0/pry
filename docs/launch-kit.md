# PRY — Launch Kit

Everything needed to publish PRY on the Chrome Web Store and promote it to real
users. Companion to `docs/store-listing.md` (listing copy + permission
justifications) and `docs/PRIVACY_POLICY.md` (hosted privacy policy).

---

## Part A — Publish on the Chrome Web Store

### A1. Prerequisites (do once)

1. **Developer account** — go to https://chrome.google.com/webstore/devconsole,
   sign in with a Google account, accept the developer agreement, pay the
   **one-time $5 registration fee**.
2. **GitHub repo public** — make the PRY repo public (if not already). It is
   your "verified website", your privacy-policy host, and your credibility
   signal for reviewers and users. Add the store-listing and launch-kit docs to
   the README if you want.
3. **Privacy policy URL** — the CWS form requires one (PRY handles PII, so this
   is mandatory). Host `docs/PRIVACY_POLICY.md` at a stable public URL:
   - **Easiest:** enable GitHub Pages on the repo, then
     `https://<user>.github.io/<repo>/PRIVACY_POLICY.md` (works, renders nicely).
   - **Simplest raw:** `https://raw.githubusercontent.com/<user>/<repo>/main/docs/PRIVACY_POLICY.md`.
   - Paste the chosen URL into the listing form.

### A2. Build the upload package

```bash
npm run verify      # 223 assertions — do this first
npm run build       # rebuild dist/ fresh
# then zip dist/ contents (NOT the dist/ folder itself)
```

Create `publish/pry-agent-1.0.0.zip` containing exactly: `manifest.json`,
`service-worker.js`, `content.js`, `tripwire.js`, `sidepanel.html`,
`sidepanel.js`, `options.html`, `options.js`, `styles.css`, `offscreen.html`,
`icons/`, `models/`, `vendor/`.

### A3. Fill the listing form

| Field | Value |
|---|---|
| Name | `PRY Agent` |
| Short name | `PRY` |
| Category | `Productivity` |
| One-line summary | from `docs/store-listing.md` |
| Detailed description | full description from `docs/store-listing.md` |
| Language | English |
| Screenshots | the 4 in `assets/store/screenshot-*.png` (replace with real captures later — see A5) |
| Small promo tile | `assets/store/tile-440x280.png` |
| Marquee tile | `assets/store/marquee-1400x560.png` |
| Privacy policy URL | from A1.3 |
| Distribution | Public |
| Regions | All (or start with India + English-speaking markets) |

### A4. Answer the data-disclosure questions (Privacy tab)

Use the exact copy under **"Data-disclosure copy"** in `docs/store-listing.md`:

- **Comply with User Data Policy?** Yes
- **Single purpose:** yes — one purpose, no secondary data use
- **Remote code:** no remote code; only bundled code; Google Fonts fall back locally
- **What leaves the device:** only user-requested, PII-tokenized task text + page
  description to the user-selected LLM provider while a task runs; nothing with
  Ollama; screenshots never sent raw
- **Certification:** no obfuscation beyond standard minification; source open in
  the linked repo

### A5. Review expectations (what the reviewers will check)

- **Permissions** — you'll get scrutiny on `<all_urls>` + `tabs`. The
  justification table in `store-listing.md` is written for exactly this. Key
  points to be ready to defend: the extension touches a page **only** when the
  user submits a task; it never scans in the background; automation targets any
  site **the user asks for** (Gmail, banking, gov portals — that's the product).
- **Single purpose** — one clear purpose: privacy-preserving browser automation.
- **Remote code policy** — nothing is fetched and executed. Fonts from Google
  Fonts are not code. All logic is bundled in `dist/`.
- **Data safety** — the privacy tab answers + the on-device redaction story make
  this straightforward.
- **First review typically takes 1–7 days.** Resubmissions after a rejection
  are faster. Don't resubmit identical text — address every point they raise.

### A6. Replace mock screenshots with real captures (before or after approval)

The generated screenshots are styled mockups of the real UI. For maximum
conversion, swap in real captures later (same 1280×800 canvas) showing:
1. A live task running with the EGRESS badge visible (this is your money shot)
2. The privacy audit drawer with a before/after redaction pair
3. The self-improvement dashboard with real rules/lessons
4. The options page with a real provider configured

**Quick real-capture recipe:** load `dist/` unpacked, run a task ("open gmail
and summarize the first email"), screenshot the side panel region, then
re-render to exactly 1280×800 with any image tool.

---

## Part B — Promote

### B1. X (Twitter) — launch post

**Post (fits in one tweet, thread below):**

> Your browser agent shouldn't read your credit card.
>
> PRY runs tasks in Chrome and redacts passwords, card numbers, Aadhaar & PAN
> on-device — BEFORE any screenshot or page text reaches an AI model. Faces get
> blurred, values become tokens, and the shipped image is re-OCR'd to prove zero
> leaks.
>
> Works with Anthropic, OpenAI, Groq, NVIDIA — or 100% local with Ollama (0 KB
> egress).
>
> Free on the Chrome Web Store → [LINK]
>
> #privacy #ai #chrome #browseragent

**Thread (reply to your own post):**

1. *The problem:* Browser-Use, Operator, Computer Use — they all ship raw
   screenshots of your inbox, your bank, your Aadhaar to cloud servers. One
   screenshot contains more PII than most data breaches.
2. *What PRY does:* every snapshot passes a 5-stage on-device pipeline —
   detect (Aadhaar/PAN/cards/emails/keys) → tokenize to `<CRED_1>` vault tokens →
   redact the pixels → blur faces → re-OCR the exact shipped JPEG locally to
   confirm nothing readable remains.
3. *The egress watch:* PRY counts every byte it sends and shows it in the badge.
   Run on Ollama and the badge reads 0 KB. Nothing to hide, literally.
4. *It learns:* failed runs produce lessons, successful runs become replay
   trajectories, false positives become suppression rules. A self-improvement
   loop that gets better on your sites.
5. *Get it:* [LINK]. Bring your own API key or go fully local. It's free.
   Built for the Smart India Hackathon — privacy-first browser agents for the
   era where every form asks for your Aadhaar.

### B2. LinkedIn — launch post

> **I built a browser agent that redacts your personal data before any AI sees it.**
>
> The browser agents hitting the market today have a blind spot: they send full,
> unredacted screenshots to cloud LLMs. Your inbox, your card numbers, your
> Aadhaar — all visible to a third-party model.
>
> PRY Agent flips that. It's a Chrome extension that:
>
> • Detects PII (Aadhaar, PAN, card numbers, emails, API keys) on-device using
>   checksum-gated detection — Verhoeff and Luhn, so order numbers don't get
>   over-redacted
> • Tokenizes every sensitive value into in-memory vault tokens before the model
>   sees anything
> • Redacts screenshot pixels — faces blurred, credentials masked — then re-OCRs
>   the exact shipped image locally to *prove* zero PII remains readable
> • Watches the page's own egress and shows an honest live byte count in the
>   toolbar
> • Runs on the model of your choice — Anthropic, OpenAI, Groq, NVIDIA — or fully
>   local with Ollama, where zero bytes leave your machine
> • Learns as you work: lessons from failures, replay trajectories from wins, and
>   a rules engine that suppresses false positives
>
> Built for the Smart India Hackathon (Problem Statement 26171: on-device visual
> perception for lightweight browser agents), and now available on the Chrome
> Web Store: [LINK]
>
> If you care about privacy + agentic AI, give it a spin and tell me what breaks.
> Feedback drives the roadmap. 🔒

**LinkedIn tactics:**
- Post at Tue–Thu, 8–10 AM your audience's timezone.
- Reply to every comment in the first 2 hours (the algorithm rewards it).
- Tag no one; let it spread organically. Share the post into relevant groups
  (AI/LLM, Chrome extensions, India tech) — groups need their own share.
- Pin a follow-up post 3–5 days later with real usage numbers or a demo video.

### B3. Demo video (30–45 s) for both platforms

Script (screen recording + captions):
1. Open Gmail → "open the first email and summarize it" (2 s)
2. Show the narration streaming + the EGRESS badge counting (5 s)
3. Open the PRIVACY AUDIT drawer — point at "ZERO-LEAK VERIFIED" and the
   redacted/raw pair (10 s)
4. Open the SELF-IMPROVEMENT dashboard — rules, lessons, replay library (8 s)
5. End card: "PRY Agent — free on the Chrome Web Store" + link (5 s)

Capture at 1080p, add captions (most watch muted), post on X + LinkedIn +
YouTube Shorts.

### B4. 7-day launch calendar

| Day | Action |
|---|---|
| 0 | Submit to CWS. While waiting, prepare captures, video, social graphics. |
| 1 | Announce: X post + thread, LinkedIn post, share in 3–5 relevant communities. |
| 2 | Post the demo video on X and LinkedIn. Reply to all comments. |
| 3 | LinkedIn follow-up: "what I learned building a privacy-first agent" (engineering story). |
| 4 | X: poll or teaser — "How much of your screen would you trust a model with?" |
| 5 | Share the self-improvement dashboard screenshot with a story about the gmail bug the loop caught. |
| 6 | Community round: answer questions, collect feedback, list top 3 feature requests. |
| 7 | Post the "week one" recap with any user count / review count you have. |

---

## Part C — Pre-launch checklist

- [ ] Repo is public, README is current (screenshots + provider list + install steps)
- [ ] `npm run verify` green (223 assertions) and `npm run build` clean
- [ ] `publish/pry-agent-1.0.0.zip` contains the full `dist/` contents
- [ ] Privacy policy live at a public URL; that URL in the listing
- [ ] 6 store images in `assets/store/` at correct sizes
- [ ] Listing copy pasted from `docs/store-listing.md`
- [ ] Permissions justifications + data-disclosure answers ready (same doc)
- [ ] X and LinkedIn posts drafted (this file), demo video recorded
- [ ] Load `dist/` unpacked one last time: icon shows, panel opens, a real task runs end-to-end, no console errors
- [ ] Version bumped in `src/manifest.json` for any future upload

## Part D — After launch

- **Watch reviews** — reply within 24 h. Negative review = fix + reply publicly.
- **Iterate monthly** — the store rewards fresh listings: bump version, add a
  feature, swap a screenshot, update the description.
- **Track** — the CWS dashboard shows installs, uninstalls, ratings by day.
  Watch uninstall spikes after big updates.
- **Stay honest** — the README's "not shipped" section is your integrity asset.
  Never move a roadmap item to "shipped" before it's real.