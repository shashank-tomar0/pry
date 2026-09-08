# PRY — Chrome Web Store Publishing Checklist

The complete asset inventory and the exact upload steps. Companion to
`docs/store-listing.md` (copy) and `docs/launch-kit.md` (promotion).

---

## 1. Assets required by the store (all present)

| Asset | Spec required | File | Status |
|---|---|---|---|
| Package ZIP | `manifest.json` at zip root | `publish/pry-agent-1.0.0.zip` | Ready — real zip, `unzip -t` clean |
| Icons (in ZIP) | 16 / 32 / 48 / 128 px PNG | `icons/icon16.png` … `icon128.png` | Ready — verified sizes |
| Screenshot 1 | 1280×800 (min 640×400) | `assets/store/screenshot-1-in-action.png` | Ready |
| Screenshot 2 | 1280×800 | `assets/store/screenshot-2-dashboard.png` | Ready |
| Screenshot 3 | 1280×800 | `assets/store/screenshot-3-options.png` | Ready |
| Screenshot 4 | 1280×800 | `assets/store/screenshot-4-audit.png` | Ready |
| Small promo tile | 440×280 | `assets/store/tile-440x280.png` | Ready |
| Marquee promo tile | 1400×560 (optional, recommended) | `assets/store/marquee-1400x560.png` | Ready |
| Privacy policy URL | public HTTPS page | `https://shashank-tomar0.github.io/pry/privacy.html` | Live |
| Website URL | public HTTPS page | `https://pry.shashanktomar.dev` | Live once DNS points |

After approval, swap the four screenshots for real captures (recipe in
`docs/launch-kit.md` §A6) — real beats mockup for conversion.

## 2. Launch graphics (new, in `assets/promo/`)

| Asset | File | Use |
|---|---|---|
| Quote card | `assets/promo/quote-card.svg` | X thread image, LinkedIn banner |
| Pipeline diagram | `assets/promo/pipeline-diagram.svg` | LinkedIn "how it works" post, README |
| Before/after pair | capture live (see `docs/launch-video.md` §4) | most retweetable image |

SVGs open in any browser, Figma, or Illustrator; export PNG at 2x for posting.

## 3. Upload steps (once, ~20 min)

1. `chrome.google.com/webstore/devconsole` → pay the one-time **$5** developer fee.
2. **New item** → upload `publish/pry-agent-1.0.0.zip`.
3. Fill listing fields from `docs/store-listing.md` (name, summary, description,
   category, language).
4. Upload the 4 screenshots, small tile, marquee.
5. Privacy policy URL: `https://pry.shashanktomar.dev/privacy.html`
   (fallback `…/github.io/pry/privacy.html`).
6. Website: `https://pry.shashanktomar.dev`.
7. **Privacy tab**: paste the "Data-disclosure copy" section from
   `docs/store-listing.md` verbatim.
8. Submit. First review: 1–7 days.

## 4. DNS for pry.shashanktomar.dev (name.com)

1. Log in at **name.com** → **My Domains** → `shashanktomar.dev` → **DNS Records**.
2. **Add record**:
   - Type: `CNAME`
   - Host: `pry`
   - Answer / Points to: `shashank-tomar0.github.io`
   - TTL: default (300 s or Auto)
3. Save. Propagation: minutes to a few hours.
4. The domain is already registered on the Pages site (set via API); GitHub
   auto-issues a TLS certificate once DNS resolves. No TXT record is required
   for this classic subdomain CNAME setup.

## 5. Pre-submit sanity (10 min)

- [ ] `npm run verify` green (223 assertions)
- [ ] Load `dist/` unpacked once: icon shows, panel opens, a real task runs,
      no console errors
- [ ] `unzip -t publish/pry-agent-1.0.0.zip` → "No errors detected"
- [ ] Landing page + privacy page + ZIP link all HTTP 200
      (`https://shashank-tomar0.github.io/pry/`)
- [ ] Version number in `src/manifest.json` bumped since the last upload