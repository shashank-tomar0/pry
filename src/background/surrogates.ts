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

export function getSyntheticSurrogate(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes("aadhaar") || k.includes("id_number") || k.includes("national_id")) {
    return generateVerhoeffAadhaarSurrogate();
  }
  if (k.includes("card") || k.includes("credit") || k.includes("cvv")) {
    return generateLuhnCardSurrogate();
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
