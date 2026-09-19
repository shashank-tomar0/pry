/**
 * Synthetic format-preserving surrogates.
 *
 * Replaces a sensitive value with a synthetic one that keeps its length,
 * character classes, and checksum validity, so downstream form validation and
 * model reasoning survive the swap.
 *
 * Scope and honesty:
 *   - Used ONLY for the pixel pipeline (inpainting confirmed credential / ID
 *     FIELDS on the redacted screenshot). Text tokens (`<CRED_1>`) are produced
 *     by tokenizer.ts and are unrelated to this module.
 *   - The generator is a hash-derived Feistel-style digit mapping, NOT a NIST
 *     SP 800-38G FF3-1 cipher: there is no key, no tweak, and no AES round
 *     function. That is a real limitation, not a naming preference — because the
 *     mapping is unkeyed, a surrogate that a vision model receives can be
 *     brute-forced back to the original over its (small) digit space. Regions
 *     that must not be recoverable belong on the opaque path.
 */

// The two checksum algorithms this file needs — Verhoeff for Aadhaar, Luhn for
// cards — live in shared/checksums.ts, beside the validators that judge their
// output. They used to be carried here as a second copy of the same tables and
// the same arithmetic, which is two chances for a generated value to fail the
// check that the rest of the pipeline runs on it.
import { luhnCheckDigit, verhoeffCheckDigit } from "../shared/checksums";
import { fnv1a } from "../shared/primitives";

/**
 * Re-exported under the names this module has always used for them.
 *
 * Kept because the verification harness pins the surrogate generator through
 * these two names, and a rename is not worth churning a pinned check — the
 * point of the change is that there is now ONE implementation behind each.
 */
export const computeVerhoeffCheckDigit = verhoeffCheckDigit;
export const computeLuhnCheckDigit = luhnCheckDigit;

export function generateVerhoeffAadhaarSurrogate(): string {
  // Use 9999 as synthetic leading block
  const prefix = "99990123456";
  const check = computeVerhoeffCheckDigit(prefix);
  const full = prefix + String(check);
  return full.slice(0, 4) + " " + full.slice(4, 8) + " " + full.slice(8, 12);
}

export function generateLuhnCardSurrogate(): string {
  // 4000 0012 3456 789x (Visa test range)
  const partial = "400000123456789";
  const check = computeLuhnCheckDigit(partial);
  const full = partial + String(check);
  return full.slice(0, 4) + " " + full.slice(4, 8) + " " + full.slice(8, 12) + " " + full.slice(12, 16);
}

export function generatePanSurrogate(): string {
  return "ABCDE1234F";
}

export function generateEmailSurrogate(): string {
  return "alex.surrogate@safe-example.internal";
}

export function generateNameSurrogate(): string {
  return "Alex Morgan";
}

export function generatePhoneSurrogate(): string {
  return "+91 98765 43210";
}

/**
 * Deterministic format-preserving mapping: a real numeric string becomes a
 * synthetic surrogate of the exact same length and digit properties that
 * passes the required checksum (Luhn for cards, Verhoeff for Aadhaar), so
 * forms and VLMs that validate length and checksums continue to work.
 *
 * NOT FF3-1: the digit derivation is an unkeyed FNV-1a digest, so the mapping
 * is deterministic and, given a surrogate, brute-forceable over the small
 * remaining digit space. See the module header.
 */


/**
 * FPE-encrypted card number:
 * Preserves the 4-digit BIN prefix and length, encrypts intermediate digits,
 * and re-calculates the valid Luhn check digit.
 */
export function fpeEncryptCard(rawCard: string): string {
  const digits = rawCard.replace(/\D/g, "");
  if (digits.length < 13) return generateLuhnCardSurrogate();
  
  const bin = digits.slice(0, 4); // Keep card network identification
  const bodyLen = digits.length - 5;
  const hashVal = fnv1a(digits);
  
  let syntheticBody = "";
  for (let i = 0; i < bodyLen; i++) {
    const digit = (Math.floor(hashVal / Math.pow(10, i % 9)) + i * 3) % 10;
    syntheticBody += String(digit);
  }
  
  const partial = bin + syntheticBody;
  const check = computeLuhnCheckDigit(partial);
  const full = partial + String(check);
  
  // Format with spaces
  return full.match(/.{1,4}/g)?.join(" ") ?? full;
}

/**
 * FPE-encrypted Aadhaar number:
 * Preserves 12-digit length, encrypts first 11 digits deterministically,
 * and recalculates the Verhoeff check digit.
 */
export function fpeEncryptAadhaar(rawAadhaar: string): string {
  const digits = rawAadhaar.replace(/\D/g, "");
  if (digits.length !== 12) return generateVerhoeffAadhaarSurrogate();

  const hashVal = fnv1a(digits);
  let prefix = "99"; // Designates synthetic test space
  for (let i = 2; i < 11; i++) {
    const d = (Math.floor(hashVal / Math.pow(10, i % 8)) + i * 7) % 10;
    prefix += String(d);
  }

  const check = computeVerhoeffCheckDigit(prefix);
  const full = prefix + String(check);
  return full.slice(0, 4) + " " + full.slice(4, 8) + " " + full.slice(8, 12);
}

export function getSyntheticSurrogate(kind: string, rawValue?: string): string {
  const k = kind.toLowerCase();
  if (k.includes("aadhaar") || k.includes("id_number") || k.includes("national_id")) {
    return rawValue ? fpeEncryptAadhaar(rawValue) : generateVerhoeffAadhaarSurrogate();
  }
  if (k.includes("card") || k.includes("credit") || k.includes("cvv")) {
    return rawValue ? fpeEncryptCard(rawValue) : generateLuhnCardSurrogate();
  }
  if (k.includes("pan")) {
    return generatePanSurrogate();
  }
  if (k.includes("email")) {
    return generateEmailSurrogate();
  }
  if (k.includes("phone") || k.includes("mobile")) {
    return generatePhoneSurrogate();
  }
  if (k.includes("name") || k.includes("person")) {
    return generateNameSurrogate();
  }
  if (k.includes("pass") || k.includes("token") || k.includes("cred")) {
    return "••••••••••••";
  }
  return "[CONFIDENTIAL SURROGATE]";
}
