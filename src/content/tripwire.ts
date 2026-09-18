/**
 * PRY Egress Tripwire (MAIN World)
 *
 * Injected at document_start in the MAIN execution world. Hooks window.fetch,
 * XMLHttpRequest and navigator.sendBeacon to inspect outbound payloads for
 * PII-shaped values (Aadhaar, cards, PAN, email) and reports them to the panel.
 *
 * IT DOES NOT BLOCK ANYTHING. Every hook calls through to the original
 * unchanged, and it always has — the code says "fail open", the alert says
 * "observed". The old wording ("Intercepted N third-party PII leaks") claimed a
 * prevention this script has never performed, which is the kind of claim a
 * privacy tool must not make: a user who believes the wire is being filtered
 * stops looking. The console line, the alert detail and the radar badge now all
 * say the same thing the code does.
 *
 * IT IGNORES THE SITE'S OWN TRAFFIC. A page sending your address to its own
 * backend is the site doing its job — Gmail's compose autosave is only a leak
 * if Google is the attacker — and counting that as a third-party leak is how a
 * live run showed "2 third-party PII leaks intercepted" for the address the
 * user had just asked PRY to email. Those still appear in the radar, labelled
 * same-site; they no longer raise a third-party alarm.
 */

import {
  generateVerhoeffAadhaarSurrogate,
  generateLuhnCardSurrogate,
  generatePanSurrogate,
  generateEmailSurrogate,
} from "../background/surrogates";
import { isAadhaarNumber, luhnValid } from "../shared/checksums";

(function initPryTripwire() {
  if ((window as any).__PRY_TRIPWIRE_INSTALLED__) return;
  (window as any).__PRY_TRIPWIRE_INSTALLED__ = true;

  // ─── PRY's own surrogate values are never leaks ────────────────────────────
  // The redaction pipeline deliberately replaces real PII in screenshots with
  // mathematically VALID surrogates (they pass Verhoeff/Luhn so VLMs keep the
  // layout). Those exact values can appear in requests PRY itself is involved
  // in; flagging them reports our own redaction work as an egress leak. The
  // generators are imported, bundled in, and exposed as a global so this
  // allowlist shares one source of truth with the redaction pipeline.
  (window as any).__PRY_SURROGATES__ = {
    aadhaar: generateVerhoeffAadhaarSurrogate,
    card: generateLuhnCardSurrogate,
    pan: generatePanSurrogate,
    email: generateEmailSurrogate,
  };
  const SURROGATES = (window as any).__PRY_SURROGATES__;
  const SURROGATE_AADHAAR_DIGITS: string = SURROGATES.aadhaar().replace(/\D/g, "");
  const SURROGATE_CARD_DIGITS: string = SURROGATES.card().replace(/\D/g, "");
  const SURROGATE_PAN: string = SURROGATES.pan();
  const SURROGATE_EMAIL: string = SURROGATES.email();

  // ─── Mathematical Validation Helpers ─────────────────────────────────────────
  // Luhn and Verhoeff come from shared/checksums (bundled in) — one source of
  // truth with the detector pipeline. isAadhaarNumber also rejects numbers
  // UIDAI never issues (leading 0/1), which is strictly more correct here.

  const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

  // Aadhaar: the written 4-4-4 form flags on Verhoeff alone. A RAW 12-digit
  // run flags only when an identity key names it — unspaced 12-digit numbers
  // are usually platform/order/telemetry IDs, and any of them passes Verhoeff
  // ~10% of the time (observed: play.google.com beacons flagged as Aadhaar).
  const AADHAAR_FORMATTED_REGEX = /(?<![0-9A-Za-z])\d{4}[ -]\d{4}[ -]\d{4}(?![0-9A-Za-z])/g;
  const AADHAAR_RAW_REGEX = /(?<![0-9A-Za-z])\d{12}(?![0-9A-Za-z])/g;
  const AADHAAR_KEY_HINT = /(?:aadhaar|aadhar|uidai|uid|national[ -]?id)\s*["':=]{0,3}\s*$/i;
  const PAN_REGEX = /(?<![0-9A-Za-z])[A-Z]{5}[0-9]{4}[A-Z](?![0-9A-Za-z])/g;

  interface TripwireScanResult {
    found: boolean;
    kind?: string;
    sample?: string;
  }

  /**
   * Card-shaped numbers must match a real card network's BIN range on top of
   * Luhn. Random 13-19 digit request/order IDs pass Luhn ~10% of the time;
   * requiring a network prefix (Visa 4, Mastercard 51-55/2221-2720, Amex
   * 34/37, Discover 6011/65/644-649, UnionPay 62, Maestro/RuPay 50/56-69/81-82)
   * eliminates those false positives while keeping genuine cards.
   */
  function cardShapePasses(clean: string): boolean {
    const len = clean.length;
    if (len < 13 || len > 19) return false;
    const first = clean[0];
    if (first === "4") return len === 13 || len === 16 || len === 19; // Visa
    if (first === "5") {
      return len === 16 && /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(clean); // Mastercard
    }
    if (first === "3") {
      return (len === 15 && /^3[47]/.test(clean)) || (len >= 14 && /^(30[0-5]|36|38|39)/.test(clean)); // Amex / Diners
    }
    if (first === "6") {
      return len >= 16 && /^(6011|65|64[4-9]|62|60|81|82)/.test(clean); // Discover / UnionPay / Maestro / RuPay
    }
    return false;
  }

  function scanPayloadText(text: string): TripwireScanResult {
    if (!text || typeof text !== "string") return { found: false };

    // 1. Credit card check (Luhn + BIN prefix + length, standalone only)
    const cardMatches = text.match(/(?<![0-9A-Za-z])(?:\d[ -]*?){13,19}(?![0-9A-Za-z])/g);
    if (cardMatches) {
      for (const m of cardMatches) {
        const clean = m.replace(/\D/g, "");
        if (clean === SURROGATE_CARD_DIGITS) continue; // PRY's own demo value
        if (cardShapePasses(clean) && luhnValid(clean)) {
          return { found: true, kind: "credit_card", sample: "•••• •••• •••• " + clean.slice(-4) };
        }
      }
    }

    // 2. Aadhaar check (Verhoeff; formatted runs always, raw runs need a key)
    const aadhaarMatches = [
      ...text.matchAll(AADHAAR_FORMATTED_REGEX),
      ...text.matchAll(AADHAAR_RAW_REGEX),
    ];
    for (const m of aadhaarMatches) {
      if (!isAadhaarNumber(m[0])) continue;
      const clean = m[0].replace(/\D/g, "");
      if (clean === SURROGATE_AADHAAR_DIGITS) continue; // PRY's own demo value
      if (/^\d{12}$/.test(m[0])) {
        const prefix = text.slice(Math.max(0, (m.index ?? 0) - 32), m.index ?? 0);
        if (!AADHAAR_KEY_HINT.test(prefix)) continue; // unnamed telemetry ID
      }
      return { found: true, kind: "aadhaar", sample: "•••• •••• " + clean.slice(-4) };
    }

    // 3. PAN check
    const panMatch = text.match(PAN_REGEX);
    if (panMatch) {
      if (panMatch[0] !== SURROGATE_PAN) {
        return { found: true, kind: "pan", sample: panMatch[0].slice(0, 2) + "•••••" + panMatch[0].slice(-2) };
      }
    }

    // 4. Email check
    const emailMatch = text.match(EMAIL_REGEX);
    if (emailMatch) {
      if (emailMatch[0].toLowerCase() !== SURROGATE_EMAIL?.toLowerCase()) {
        const [user, domain] = emailMatch[0].split("@");
        return { found: true, kind: "email", sample: user.slice(0, 2) + "•••@" + domain };
      }
    }

    return { found: false };
  }

  // ─── Whose destination is this? ───────────────────────────────────────────
  //
  // The page's own origin, and an approximate registrable domain to compare a
  // destination against. A content script has no public-suffix list to consult,
  // so this is deliberately simple: the last two labels, or three for the
  // country-code second levels that would otherwise split one company in two
  // (co.uk, com.au, co.in …). It errs toward "same site", because the point of
  // the classification is to stop alarming on the site's own traffic, and a
  // quiet same-site call is a smaller failure than a false exfiltration alarm.
  const PAGE_HOST = (() => {
    try {
      return location.hostname ?? "";
    } catch {
      return "";
    }
  })();

  function siteOf(host: string): string {
    const clean = host.toLowerCase().replace(/^www\./, "");
    const parts = clean.split(".");
    if (parts.length <= 2) return clean;
    const lastTwo = parts.slice(-2).join(".");
    if (/^(?:com|co|org|net|gov|ac|edu|or|ne)\.[a-z]{2}$/.test(lastTwo)) {
      return parts.slice(-3).join(".");
    }
    return lastTwo;
  }

  /**
   * Is this request leaving the site the user is actually on?
   *
   * `false` means "not evidence of third-party exfiltration": same registrable
   * domain as the page, a non-web scheme, or a URL this document could not
   * resolve (a relative path is the page's own API, not somebody else's).
   */
  function isThirdParty(rawUrl: string): boolean {
    try {
      const base = (() => {
        try {
          return location.href;
        } catch {
          return undefined;
        }
      })();
      const u = new URL(rawUrl, base);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      if (!u.hostname) return false;
      // No page origin to compare against: report it rather than drop it.
      if (!PAGE_HOST) return true;
      return siteOf(u.hostname) !== siteOf(PAGE_HOST);
    } catch {
      return false;
    }
  }

  function alertTripwire(url: string, method: string, result: TripwireScanResult) {
    const thirdParty = isThirdParty(url);
    const detail = {
      url,
      method,
      piiType: result.kind,
      sample: result.sample,
      thirdParty,
      timestamp: Date.now(),
    };

    console.warn(
      "[PRY Egress Tripwire] " +
        (thirdParty ? "Third-party" : "Same-site") +
        " PII in " +
        method +
        " request to " +
        url +
        " — observed, not blocked",
      detail,
    );

    window.dispatchEvent(new CustomEvent("__PRY_TRIPWIRE_ALERT__", { detail }));
  }

  // 1. Hook window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function pryFetch(input: RequestInfo | URL, init?: RequestInit) {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = init?.method?.toUpperCase() || (input instanceof Request ? input.method : "GET");

      const urlScan = scanPayloadText(url);
      if (urlScan.found) {
        alertTripwire(url, method, urlScan);
      }

      if (init?.body) {
        let bodyText = "";
        if (typeof init.body === "string") {
          bodyText = init.body;
        } else if (init.body instanceof URLSearchParams) {
          bodyText = init.body.toString();
        }
        if (bodyText) {
          const bodyScan = scanPayloadText(bodyText);
          if (bodyScan.found) {
            alertTripwire(url, method, bodyScan);
          }
        }
      }
    } catch {
      // Fail open
    }

    return originalFetch.apply(this, arguments as any);
  };

  // 2. Hook XMLHttpRequest
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function pryXhrOpen(method: string, url: string | URL) {
    (this as any).__pry_url = typeof url === "string" ? url : url.href;
    (this as any).__pry_method = method;
    return originalXhrOpen.apply(this, arguments as any);
  };

  XMLHttpRequest.prototype.send = function pryXhrSend(body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const url = (this as any).__pry_url || "unknown";
      const method = (this as any).__pry_method || "POST";

      const urlScan = scanPayloadText(url);
      if (urlScan.found) {
        alertTripwire(url, method, urlScan);
      }

      if (body && typeof body === "string") {
        const bodyScan = scanPayloadText(body);
        if (bodyScan.found) {
          alertTripwire(url, method, bodyScan);
        }
      }
    } catch {
      // Fail open
    }

    return originalXhrSend.apply(this, arguments as any);
  };

  // 3. Hook navigator.sendBeacon
  if (navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function prySendBeacon(url: string | URL, data?: BodyInit | null) {
      try {
        const urlStr = typeof url === "string" ? url : url.href;
        const urlScan = scanPayloadText(urlStr);
        if (urlScan.found) {
          alertTripwire(urlStr, "BEACON", urlScan);
        }

        if (data && typeof data === "string") {
          const bodyScan = scanPayloadText(data);
          if (bodyScan.found) {
            alertTripwire(urlStr, "BEACON", bodyScan);
          }
        }
      } catch {
        // Fail open
      }
      return originalSendBeacon.apply(this, arguments as any);
    };
  }
})();
