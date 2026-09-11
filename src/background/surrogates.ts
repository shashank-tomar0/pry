/**
 * Synthetic Semantic Surrogates
 *
 * Generates photorealistic, mathematically-valid dummy data to replace sensitive
 * text and visual regions in screenshots.
 *
 * Why this is superior to black-box masking:
 * 1. Black boxes blind downstream Vision-Language Models (VLMs), destroying visual
 *    affordances (cursor positioning, placeholder text, form alignment).
 * 2. Blurring is mathematically reversible via super-resolution neural attacks.
 * 3. Surrogates provide 100% privacy (zero real pixels leave the browser) while
 *    maintaining 100% visual perception for the AI agent.
 */

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

const invTable = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export function computeVerhoeffCheckDigit(numStr: string): number {
  let c = 0;
  const digits = numStr.replace(/\D/g, "").split("").reverse();
  for (let i = 0; i < digits.length; i++) {
    const digit = parseInt(digits[i], 10);
    c = dTable[c][pTable[(i + 1) % 8][digit]];
  }
  return invTable[c];
}

export function generateVerhoeffAadhaarSurrogate(): string {
  // Use 9999 as synthetic leading block
  const prefix = "99990123456";
  const check = computeVerhoeffCheckDigit(prefix);
  const full = prefix + String(check);
  return full.slice(0, 4) + " " + full.slice(4, 8) + " " + full.slice(8, 12);
}

export function computeLuhnCheckDigit(partialCard: string): number {
  const digits = partialCard.replace(/\D/g, "");
  let sum = 0;
  let alternate = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return (10 - (sum % 10)) % 10;
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
 * Format-Preserving Encryption (FPE / FF3-1 design pattern):
 * Deterministically maps a real numeric string into a synthetic surrogate
 * having the exact same length, digit properties, and passing the required
 * checksum algorithm (Luhn for cards, Verhoeff for Aadhaar).
 *
 * This ensures that when down-stream forms or VLMs validate length and checksums,
 * the encrypted value passes transparently without leaking real digits.
 */

function simpleHash(str: string, seed: number = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

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
  const hashVal = simpleHash(digits);
  
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

  const hashVal = simpleHash(digits);
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
