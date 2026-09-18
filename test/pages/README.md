# PRY test pages

Static fixtures for manually verifying the privacy pipeline without touching
real accounts. Every value on every page is synthetic.

## Pages

- **`pii-fixture.html`** — the main fixture. Form fields (password, OTP, card,
  email, phone, Aadhaar, PAN), a plain-text block (the channel that used to
  leak), decoys that must NOT be redacted (checksum-failing lookalikes), and a
  section 4 that attempts a local network request carrying PII so the egress
  tripwire can be demonstrated. Section 4 needs `npm run demo:serve`: it posts to
  the server's `/collect`, which records the key names it received, discards the
  values, and forwards nothing off the machine.

## How to run

Content scripts do not run on `file://` unless you enable
**Details → Allow access to file URLs** for PRY in `chrome://extensions`.

1. **Preferred — the bundled server** (no dependencies, no download, no toggle):
   ```
   npm run demo:serve
   ```
   then open http://127.0.0.1:8787/pii-fixture.html. `PORT=9000 npm run demo:serve`
   moves it if that port is taken.
2. Fallback — any static server, e.g. `cd test/pages && npx serve -l 8642`.
3. Last resort — open `file:///.../test/pages/pii-fixture.html` directly and
   enable *Allow access to file URLs*. Without that toggle the extension is
   simply absent from the page, which is easy to misread as a broken build.

## What to verify (run a PRY task, e.g. "scan this page for PII")

1. **Model context**: every section-1 and section-2 value appears as a token
   (`<CRED_n>`, `<ID_n>`) or is absent — open the Wire log drawer to see the
   exact outgoing payload and its leak re-scan.
2. **Screenshot**: the audit's redacted pane masks section-1 fields and
   blurs the section-2 plain-text spans; the VERIFIED badge confirms.
3. **Decoys**: section-3 strings stay readable — checksum-rejected
   lookalikes are counted as measured false positives, not redacted.
4. **Tiers**: the audit's detection list and the Deep Inspector label every box
   with the tier it was painted with (`opaque` / `blur+escalate` / `surrogate` /
   `none`). A `none` box is a detected region deliberately left readable — a
   finding, not a redaction.
5. **Tripwire**: section 4's "Leak the values above" should raise a radar alert
   (🛡️) naming the PII type, the method and the host; "Clean request (control)"
   should not. `http://127.0.0.1:8787/collected` shows the key names the local
   collector received (never the values).
