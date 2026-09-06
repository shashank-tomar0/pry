/**
 * Tripwire MAIN-world scanner — black-box test of the EXACT shipped code.
 *
 * The npm "verify" script first bundles src/content/tripwire.ts to
 * scripts/.tripwire-iife.js (esbuild, format=iife). This harness runs that
 * IIFE inside a stubbed window context, then drives the patched fetch /
 * XMLHttpRequest / sendBeacon hooks with real and adversarial payloads and
 * asserts on the alerts the script would dispatch to the extension.
 *
 * It proves, end to end, that:
 *   - genuine cards / Aadhaar / PAN / email are caught over every transport,
 *   - Luhn-passing random numbers without a valid card BIN are NOT flagged,
 *   - digits embedded inside hashes / alphanumeric tokens are NOT flagged,
 *   - plain sync-style URLs (the Gmail noise) do not alert.
 */
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
};

console.log("\n=== Tripwire MAIN-World Scanner (bundled, stubbed) ===\n");

// ─── Load the pre-built IIFE (built by the npm verify script) ───────────────
const iifePath = fileURLToPath(new URL("./.tripwire-iife.js", import.meta.url));
const code = await readFile(iifePath, "utf8");
check("tripwire bundles to a self-contained IIFE", code.length > 1000);

// ─── Stubbed page world ─────────────────────────────────────────────────────
const alerts = [];
const windowStub = {
  fetch: async () => ({ ok: true }),
  dispatchEvent: (ev) => {
    if (ev && ev.detail) alerts.push(ev.detail);
  },
};
const context = {
  console,
  window: windowStub,
  navigator: { sendBeacon: () => true },
  XMLHttpRequest: class {
    open() {}
    send() {}
  },
  CustomEvent: class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  },
};
vm.createContext(context);
vm.runInContext(code, context);

const hookedFetch = windowStub.fetch;
const lastAlert = () => alerts[alerts.length - 1];

// ─── Fixtures ────────────────────────────────────────────────────────────────
const VISA = "4532 0151 1283 0366"; // known Luhn-valid Visa
const VISA_CLEAN = "4532015112830366";

// A 16-digit Luhn-passing number that does NOT start with a card BIN.
function luhnPassing16StartingWith(prefix) {
  for (let i = 0; i < 100000; i++) {
    const candidate = prefix + String(i).padStart(16 - prefix.length, "0");
    let sum = 0;
    let double = false;
    for (let k = candidate.length - 1; k >= 0; k--) {
      let d = candidate.charCodeAt(k) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error("could not build luhn-passing fixture");
}
const BAD_BIN_LUHN = luhnPassing16StartingWith("9");
check(`fixture ${BAD_BIN_LUHN.slice(0, 4)}… passes Luhn but is not a card BIN`, /^\d{16}$/.test(BAD_BIN_LUHN));

// Verhoeff-valid Aadhaar (seed 23456789012 → check digit 4).
const AADHAAR = "234567890124";
const AADHAAR_SPACED = "2345 6789 0124";

const PAN = "ABCDE1234F";
const EMAIL = "alice@example.com";

// ─── Drive the patched fetch ────────────────────────────────────────────────
await hookedFetch("https://bank.example.com/api/pay", { method: "POST", body: JSON.stringify({ card: VISA }) });
check("fetch body with real Visa number alerts credit_card", lastAlert()?.piiType === "credit_card");
check("credit_card alert masks all but last 4", lastAlert()?.sample === "•••• •••• •••• " + VISA_CLEAN.slice(-4));

alerts.length = 0;
await hookedFetch("https://shop.example.com/orders/" + BAD_BIN_LUHN, { method: "GET" });
check("URL with Luhn-passing non-BIN number does NOT alert", alerts.length === 0);

alerts.length = 0;
await hookedFetch("https://auth.example.com/login", {
  method: "POST",
  body: "session=abc" + VISA_CLEAN + "xyz",
});
check("card digits embedded in an alphanumeric token do NOT alert", alerts.length === 0);

alerts.length = 0;
await hookedFetch("https://gov.example.com/aadhaar", { method: "POST", body: JSON.stringify({ aadhaar: AADHAAR_SPACED }) });
check("standalone Verhoeff-valid Aadhaar alerts aadhaar", lastAlert()?.piiType === "aadhaar");

alerts.length = 0;
await hookedFetch("https://auth.example.com/hash?token=d447d02a42ef" + AADHAAR + "c9", { method: "GET" });
check("digits embedded in a hash token do NOT alert aadhaar", alerts.length === 0);

alerts.length = 0;
await hookedFetch("https://tax.example.com/pan", { method: "POST", body: `pan=${PAN}` });
check("standalone PAN alerts pan", lastAlert()?.piiType === "pan");

alerts.length = 0;
await hookedFetch("https://x.example.com/contact", { method: "POST", body: `email=${EMAIL}` });
check("email in body alerts email", lastAlert()?.piiType === "email");
check("email alert masks the local part", lastAlert()?.sample === "al•••@example.com");

alerts.length = 0;
await hookedFetch("https://mail.google.com/sync/u/0/i/fd?hl=en&c=0&rt=r&pt=ji", { method: "POST", body: "x=1" });
check("plain sync-style URL without PII does NOT alert", alerts.length === 0);

// ─── XMLHttpRequest path ─────────────────────────────────────────────────────
alerts.length = 0;
const xhr = new context.XMLHttpRequest();
xhr.open("POST", "https://bank.example.com/xhr");
xhr.send(JSON.stringify({ card: VISA }));
check("XHR send with card alerts credit_card", lastAlert()?.piiType === "credit_card");

alerts.length = 0;
xhr.open("GET", "https://shop.example.com/xhr/" + BAD_BIN_LUHN);
xhr.send(null);
check("XHR with non-BIN number does NOT alert", alerts.length === 0);

// ─── sendBeacon path ─────────────────────────────────────────────────────────
alerts.length = 0;
const beacon = context.navigator.sendBeacon;
beacon.call({}, "https://track.example.com/beacon", `ref=${AADHAAR}`);
check("sendBeacon with Aadhaar alerts aadhaar", lastAlert()?.piiType === "aadhaar");

alerts.length = 0;
beacon.call({}, "https://track.example.com/log?nonce=" + BAD_BIN_LUHN, "ok");
check("sendBeacon with non-BIN number does NOT alert", alerts.length === 0);

// ─── Summarise ────────────────────────────────────────────────────────────────
console.log(`\n${pass} tripwire assertions passed.${fail > 0 ? ` ${fail} FAILED` : ""}`);
if (fail > 0) {
  process.exit(1);
}