# PRY test pages

Static fixtures for manually verifying the privacy pipeline without touching
real accounts. Every value on every page is synthetic.

## Pages

- **`pii-fixture.html`** — the main fixture. Form fields (password, OTP, card,
  email, phone, Aadhaar, PAN), a plain-text block (the channel that used to
  leak), and decoys that must NOT be redacted (checksum-failing lookalikes).

## How to run

Content scripts do not run on `file://` unless you enable
**Details → Allow access to file URLs** for PRY in `chrome://extensions`.
Two options:

1. Easiest — serve locally (content scripts run on localhost):
   ```
   cd test/pages
   npx serve -l 8642        # or: python -m http.server 8642
   ```
   then open http://localhost:8642/pii-fixture.html

2. File access toggle — open `file:///.../test/pages/pii-fixture.html`
   directly and enable the toggle above.

## What to verify (run a PRY task, e.g. "scan this page for PII")

1. **Model context**: every section-1 and section-2 value appears as a token
   (`<CRED_n>`, `<ID_n>`) or is absent — open the Wire log drawer to see the
   exact outgoing payload and its leak re-scan.
2. **Screenshot**: the audit's redacted pane masks section-1 fields and
   blurs the section-2 plain-text spans; the VERIFIED badge confirms.
3. **Decoys**: section-3 strings stay readable — checksum-rejected
   lookalikes are counted as measured false positives, not redacted.
