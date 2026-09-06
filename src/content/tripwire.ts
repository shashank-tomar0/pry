/**
 * PRY Egress Tripwire (MAIN World)
 *
 * Injected at document_start in the MAIN execution world.
 * Hooks window.fetch, XMLHttpRequest, and navigator.sendBeacon to inspect outbound
 * payloads for unauthorized PII leakage (Aadhaar, Credit Cards, PAN, Emails)
 * to third-party trackers or external endpoints.
 */

(function initPryTripwire() {
  if ((window as any).__PRY_TRIPWIRE_INSTALLED__) return;
  (window as any).__PRY_TRIPWIRE_INSTALLED__ = true;

  // ─── Mathematical Validation Helpers ─────────────────────────────────────────

  function luhnCheck(digits: string): boolean {
    const clean = digits.replace(/\D/g, "");
    if (clean.length < 13 || clean.length > 19) return false;
    let sum = 0;
    let alternate = false;
    for (let i = clean.length - 1; i >= 0; i--) {
      let n = parseInt(clean[i], 10);
      if (alternate) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alternate = !alternate;
    }
    return sum % 10 === 0;
  }

  // Verhoeff multiplication and permutation tables
  const dTable = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];

  const pTable = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];

  function verhoeffCheck(numStr: string): boolean {
    const clean = numStr.replace(/\D/g, "");
    if (clean.length !== 12) return false;
    let c = 0;
    const reversed = clean.split("").reverse();
    for (let i = 0; i < reversed.length; i++) {
      const digit = parseInt(reversed[i], 10);
      c = dTable[c][pTable[i % 8][digit]];
    }
    return c === 0;
  }

  const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

  // Numbers must NOT be embedded inside an alphanumeric token (hex hashes,
  // session IDs, SAPISID strings) — only standalone PII-shaped values count.
  const AADHAAR_REGEX = /(?<![0-9A-Za-z])\d{4}[ -]?\d{4}[ -]?\d{4}(?![0-9A-Za-z])/g;
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
        if (cardShapePasses(clean) && luhnCheck(clean)) {
          return { found: true, kind: "credit_card", sample: "•••• •••• •••• " + clean.slice(-4) };
        }
      }
    }

    // 2. Aadhaar check (Verhoeff, standalone 12-digit runs only)
    const aadhaarMatches = text.match(AADHAAR_REGEX);
    if (aadhaarMatches) {
      for (const m of aadhaarMatches) {
        if (verhoeffCheck(m)) {
          const clean = m.replace(/\D/g, "");
          return { found: true, kind: "aadhaar", sample: "•••• •••• " + clean.slice(-4) };
        }
      }
    }

    // 3. PAN check
    const panMatch = text.match(PAN_REGEX);
    if (panMatch) {
      return { found: true, kind: "pan", sample: panMatch[0].slice(0, 2) + "•••••" + panMatch[0].slice(-2) };
    }

    // 4. Email check
    const emailMatch = text.match(EMAIL_REGEX);
    if (emailMatch) {
      const [user, domain] = emailMatch[0].split("@");
      return { found: true, kind: "email", sample: user.slice(0, 2) + "•••@" + domain };
    }

    return { found: false };
  }

  function alertTripwire(url: string, method: string, result: TripwireScanResult) {
    const detail = {
      url,
      method,
      piiType: result.kind,
      sample: result.sample,
      timestamp: Date.now(),
    };

    console.warn(
      "[PRY Egress Tripwire] Intercepted " + result.kind + " in " + method + " request to " + url,
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
