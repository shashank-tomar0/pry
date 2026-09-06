/**
 * Checksum validators for the two Indian ID shapes PRY sees most often.
 *
 *   - Aadhaar (12 digits) uses the Verhoeff algorithm — the final digit is a
 *     check digit, so "XXXX XXXX XXXX"-looking strings that are not genuine
 *     Aadhaar numbers can be rejected deterministically.
 *   - Card numbers use Luhn, so random 16-digit strings (order IDs, reference
 *     numbers) are not treated as cards.
 *
 * This is the "domain-elite" layer: it converts regex hits into validated
 * detections and turns lookalikes into measured false positives instead of
 * over-redacting the page.
 *
 * Pure functions only — safe to import from the content script, the background
 * worker, the offscreen document, and the Node verification harness.
 */

// ─── Verhoeff (Aadhaar) ─────────────────────────────────────────────────────

/** Multiplication table D. */
const VERHOEFF_D = [
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

/** Permutation table P (8 rows, indexed by position from the right % 8). */
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Inverse table. */
const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Verhoeff checksum: true when `digits` (any length >= 2) passes. */
export function verhoeffValid(value: string): boolean {
  const n = digitsOnly(value);
  if (n.length < 2) return false;
  let c = 0;
  for (let i = n.length - 1, k = 0; i >= 0; i--, k++) {
    c = VERHOEFF_D[c][VERHOEFF_P[k % 8][Number(n[i])]];
  }
  return c === 0;
}

/**
 * Verhoeff check digit for a leading digit string. Pass an 11-digit seed to
 * build a valid 12-digit Aadhaar (used by tests and demo fixtures).
 *
 * The check digit will occupy the rightmost position (index 0 when validating
 * from the right), so generation runs over the seed starting one position in.
 */
export function verhoeffCheckDigit(seed: string): number {
  const n = digitsOnly(seed);
  let c = 0;
  for (let i = n.length - 1, k = 1; i >= 0; i--, k++) {
    c = VERHOEFF_D[c][VERHOEFF_P[k % 8][Number(n[i])]];
  }
  return VERHOEFF_INV[c];
}

/**
 * True when `value` is a genuine Aadhaar-shaped number: exactly 12 digits
 * that pass the Verhoeff check.
 */
export function isAadhaarNumber(value: string): boolean {
  const n = digitsOnly(value);
  if (n.length !== 12) return false;
  // UIDAI never issues numbers starting 0 or 1.
  if (n[0] === "0" || n[0] === "1") return false;
  return verhoeffValid(n);
}

// ─── Luhn (cards) ───────────────────────────────────────────────────────────

/** Luhn checksum: true when a 13-19 digit number (spaces/dashes allowed) passes. */
export function luhnValid(value: string): boolean {
  const n = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(n)) return false;
  let sum = 0;
  let double = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = n.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True when `value` is a card-shaped number that passes Luhn. */
export function isCardNumber(value: string): boolean {
  return luhnValid(value);
}

/** True when `value` is a genuine 10-digit Indian mobile number. */
export function isIndianPhone(value: string): boolean {
  const n = digitsOnly(value);
  return n.length === 10 && /^[6-9]/.test(n) && /^[6-9]\d{9}$/.test(n);
}
