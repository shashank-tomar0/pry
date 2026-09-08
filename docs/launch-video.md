# PRY — Launch Video & Asset Playbook

How to produce the launch demo video and supporting graphics at a
top-0.1%-creator standard, with the tools available on Windows. Companion to
`docs/launch-kit.md` (posts + calendar) and `docs/store-listing.md` (listing
copy).

---

## 0. Video or static assets first?

Both, in this order:

1. **Static assets first (already done).** The store listing needs screenshots,
   a tile, and a marquee today. You already have the 4 screenshots + 2 promo
   tiles in `assets/store/`. Swap in real captures later (recipe in
   `docs/launch-kit.md` §A6) — a real task run beats a mockup every time.
2. **One demo video (30–45 s) is the single highest-leverage asset you can
   ship.** It goes on X, LinkedIn, and the landing page. Nothing else you
   produce converts more viewers into installs, because browser agents are a
   "show, don't tell" product — the redaction happening live is the story.

---

## 1. Tool stack (Windows)

You already have **Cap** for screen recording. Add these around it:

| Job | Tool | Why it is the right choice |
|---|---|---|
| Cursor-following screen capture | **FocuSee** or **ScreenKite** (Windows equivalents of Mac's Screen Studio) | Auto-zooms on clicks and input, smooths cursor motion, adds padding — this is what makes a raw capture look cinematic with zero manual keyframing |
| Raw capture + camera overlay | **OBS Studio** | Free, full control; pair with the `obs-backgroundremoval` plugin for a floating-camera effect without a green screen |
| Terminal / CLI footage | **VHS** (charmbracelet) | The rarely-used flex. You script the demo in a `.tape` file (`Type`, `Sleep`, `Enter`) and it renders a pixel-perfect terminal video. No jittery mouse in terminal footage, ever |
| Code cards for stills | **Ray.so** | Syntax-highlighted, window-framed code cards for the quote cards and thread images |
| Audio cleanup | **Adobe Podcast Enhance** (free web tool) | Broadcast-quality voice from a phone mic; run the raw voice file through it before editing |
| Captions | **CapCut Desktop** or **Submagic** | Word-by-word highlighted captions (yellow/green highlight boxes). Most X viewers watch muted |
| Architecture diagrams | **Excalidraw** or hand-written SVG | Match the README's diagram style — your audience (developers) trusts a clean technical diagram more than a stock illustration |

Skip **Remotion** for the launch. It is powerful but costs days of setup; the
launch video is one 40-second cut, not an animated changelog. Revisit it in
month 2 for automated feature-reveal clips.

---

## 2. The storyboard (40 seconds, one continuous screen recording)

The video is a single take of a real task with two zooms and three caption
beats. No slides, no talking head needed for v1 — captions carry the message.

| Time | Shot | On screen | Caption |
|---|---|---|---|
| 0–3 s | Cold open: a payment form with an Aadhaar field focused | Cursor hovers the Aadhaar input | "Your browser agent shouldn't read this." |
| 3–12 s | Task runs | Side panel streams the agent narration; PII values on the page flip to `<CRED_1>` / `<ID_3>` tokens in real time | "PRY tokenizes your data before any model sees it." |
| 12–20 s | Zoom on the toolbar badge | EGRESS badge counting bytes during the task | "Every byte that leaves is counted." |
| 20–28 s | Zoom on the privacy audit drawer | Raw capture vs redacted shipped image, "ZERO-LEAK VERIFIED" after local re-OCR | "The shipped screenshot is re-OCR'd to prove zero leaks." |
| 28–35 s | Cut to Ollama mode | Badge reads 0 KB EGRESS; task still completes | "Or run fully local. 0 KB leaves your machine." |
| 35–40 s | End card | PRY Agent wordmark, "Free on the Chrome Web Store", store link | — |

---

## 3. Production checklist

1. **Prepare the demo account.** A Gmail or test form that accepts the agent
   task ("fill this form", "open the first email and summarize it"). Script the
   exact task text; ad-libbing mid-recording wastes takes.
2. **Record at 1080p, 60 fps.** Cursor-following capture with FocuSee/ScreenKite.
   Terminal beats (if any) via VHS so text is crisp.
3. **Run the voice track through Adobe Podcast Enhance.** Even a phone recording
   becomes broadcast-grade.
4. **Cut in CapCut or Cap:** 40 s, captions on, no music louder than the voice,
   hard cuts only (soft transitions read as amateur in dev demos).
5. **Export per platform:**

| Platform | Aspect | Resolution | Codec |
|---|---|---|---|
| X (feed) | 4:5 | 1080 × 1350 | H.264, 60 fps |
| X / YouTube (wide) | 16:9 | 1920 × 1080 | H.264, 60 fps |
| LinkedIn | 4:5 or 1:1 | 1080 × 1350 / 1080 × 1080 | H.264 |
| Landing page | 16:9 | 1920 × 1080 | H.264, MP4 |

6. **Post the 4:5 version on X and LinkedIn, the 16:9 on YouTube Shorts.**
   Same edit, three exports.

---

## 4. Supporting stills (in the same visual language)

- **Quote card:** one line — "Your browser agent shouldn't read your credit
  card." — on the landing page's paper background (`#f3ebe5`) with the PRY blue
  (`#1537ad`). Generate with Ray.so or an HTML snippet.
- **Architecture card:** the privacy pipeline (detect → tokenize → redact →
  re-OCR → egress watch) as a five-box flow diagram in the README's style.
  This gets more engagement on LinkedIn than a screenshot does.
- **OG card:** already in `landing/og-card.png` (1200 × 630); regenerate only
  if the video changes the headline.
- **Before/after pair:** one frame of the raw page next to the redacted frame —
  the single most retweetable image in the whole campaign.

---

## 5. When to ship

| Day | Asset |
|---|---|
| 0 | Submit to CWS; record the video while waiting |
| 1 | Launch posts (X thread + LinkedIn) with a still (quote card or before/after pair) |
| 2 | Demo video post on X and LinkedIn |
| 3 | Architecture card on LinkedIn ("how it works" engineering post) |
| 5 | Before/after redaction image with the self-improvement dashboard story |

All copy lives in `docs/launch-kit.md` §B. Keep the tone: no emoji, no hype
adjectives, precise claims. That is the brand.