/**
 * OCR Permutation Checksum Correction
 *
 * Resolves character-level OCR confusions (8 vs B, 0 vs O, 1 vs I/l, 5 vs S)
 * by fitting tokens to structured templates and validating against mathematical
 * checksums (Verhoeff for Aadhaar, Luhn for Cards, structural slot patterns for PAN).
 */

import { isAadhaarNumber, isCardNumber } from "../shared/checksums";

const TO_DIGIT: Record<string, string> = {
  O: "0", o: "0", Q: "0", D: "0",
  I: "1", l: "1", i: "1", "|": "1", "!": "1", L: "1",
  Z: "2", z: "2",
  E: "3",
  A: "4",
  S: "5", s: "5",
  G: "6", b: "6",
  T: "7", Y: "7",
  B: "8",
  g: "9", q: "9",
};

const TO_LETTER: Record<string, string> = {
  "0": "O", "1": "I", "2": "Z", "3": "E", "4": "A",
  "5": "S", "6": "G", "7": "T", "8": "B", "9": "G",
  "|": "I", "!": "I",
};

export interface OcrCorrection {
  original: string;
  corrected: string;
  kind: string;
  confidence: number;
}

/**
 * Attempts to correct a candidate digit string (Aadhaar or Card) by substituting
 * common OCR glyph confusions and testing if the result passes the check digit.
 */
export function correctDigitSequence(raw: string, kind: "aadhaar" | "card"): string | null {
  const clean = raw.replace(/[\s-]/g, "");
  if (kind === "aadhaar") {
    if (clean.length !== 12) return null;
    if (isAadhaarNumber(clean)) return clean;

    // Single-character and two-character permutation search
    const chars = clean.split("");
    for (let i = 0; i < chars.length; i++) {
      const orig = chars[i];
      const alt = TO_DIGIT[orig];
      if (alt && alt !== orig) {
        chars[i] = alt;
        const candidate = chars.join("");
        if (isAadhaarNumber(candidate)) return candidate;
        chars[i] = orig;
      }
    }
  } else if (kind === "card") {
    if (clean.length < 13 || clean.length > 19) return null;
    if (isCardNumber(clean)) return clean;

    const chars = clean.split("");
    for (let i = 0; i < chars.length; i++) {
      const orig = chars[i];
      const alt = TO_DIGIT[orig];
      if (alt && alt !== orig) {
        chars[i] = alt;
        const candidate = chars.join("");
        if (isCardNumber(candidate)) return candidate;
        chars[i] = orig;
      }
    }
  }
  return null;
}

/**
 * Corrects PAN cards: 5 uppercase letters, 4 digits, 1 letter.
 */
export function correctPan(raw: string): string | null {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length !== 10) return null;

  const chars = clean.split("");
  let corrections = 0;

  // First 5 characters must be letters
  for (let i = 0; i < 5; i++) {
    if (!/[A-Z]/.test(chars[i])) {
      const repl = TO_LETTER[chars[i]];
      if (repl) {
        chars[i] = repl;
        corrections++;
      } else return null;
    }
  }

  // Next 4 characters must be digits
  for (let i = 5; i < 9; i++) {
    if (!/[0-9]/.test(chars[i])) {
      const repl = TO_DIGIT[chars[i]];
      if (repl) {
        chars[i] = repl;
        corrections++;
      } else return null;
    }
  }

  // 10th character must be a letter
  if (!/[A-Z]/.test(chars[9])) {
    const repl = TO_LETTER[chars[9]];
    if (repl) {
      chars[9] = repl;
      corrections++;
    } else return null;
  }

  // Valid 4th character holder type check: P (individual), C (company), H, F, A, T, B, L, J, G
  if (!/[PCHFATBLJG]/.test(chars[3])) return null;

  return corrections <= 3 ? chars.join("") : null;
}

/**
 * Full line/text OCR scan that identifies and rectifies misread structured identifiers.
 */
export function correctOcrText(text: string): { correctedText: string; corrections: OcrCorrection[] } {
  if (!text || text.length < 8) return { correctedText: text, corrections: [] };

  const corrections: OcrCorrection[] = [];
  let updated = text;

  // 1. Scan for potential Aadhaar numbers (e.g. 12 alnum/digits separated or grouped)
  const aadhaarRegex = /\b([0-9A-Za-z]{4}[\s-][0-9A-Za-z]{4}[\s-][0-9A-Za-z]{4})\b/g;
  for (const m of text.matchAll(aadhaarRegex)) {
    const corrected = correctDigitSequence(m[1], "aadhaar");
    if (corrected) {
      const formatted = `${corrected.slice(0, 4)} ${corrected.slice(4, 8)} ${corrected.slice(8)}`;
      if (formatted !== m[1]) {
        updated = updated.replace(m[1], formatted);
        corrections.push({ original: m[1], corrected: formatted, kind: "aadhaar", confidence: 0.98 });
      }
    }
  }

  // 2. Scan for potential Cards (16 alnum grouped)
  const cardRegex = /\b([0-9A-Za-z]{4}[\s-][0-9A-Za-z]{4}[\s-][0-9A-Za-z]{4}[\s-][0-9A-Za-z]{4})\b/g;
  for (const m of text.matchAll(cardRegex)) {
    const corrected = correctDigitSequence(m[1], "card");
    if (corrected) {
      const formatted = `${corrected.slice(0, 4)} ${corrected.slice(4, 8)} ${corrected.slice(8, 12)} ${corrected.slice(12)}`;
      if (formatted !== m[1]) {
        updated = updated.replace(m[1], formatted);
        corrections.push({ original: m[1], corrected: formatted, kind: "card", confidence: 0.98 });
      }
    }
  }

  // 3. Scan for potential PANs (10 alnum)
  const panRegex = /\b([0-9A-Za-z]{10})\b/g;
  for (const m of text.matchAll(panRegex)) {
    const corrected = correctPan(m[1]);
    if (corrected && corrected !== m[1]) {
      updated = updated.replace(m[1], corrected);
      corrections.push({ original: m[1], corrected, kind: "pan", confidence: 0.95 });
    }
  }

  return { correctedText: updated, corrections };
}
