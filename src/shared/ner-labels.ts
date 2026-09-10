/**
 * Shared NER label policy — which model labels count as PII worth redacting.
 *
 * Kept separate from src/ml/ner.ts (which imports the transformers.js runtime)
 * so the verification harness and any other consumer can pin the policy
 * without pulling the ML runtime into the bundle.
 *
 * Models disagree on label vocabularies: ConLL-style NER emits PER/ORG/LOC;
 * PII-specialized token classifiers emit classes like EMAIL, PERSON_NAME,
 * PHONE_NUMBER (Piiranha); GLiNER returns whatever zero-shot labels were
 * passed ("name", "email address", …). Any span whose label names a PII
 * class is kept — so whichever PII-capable model lands in models/ner/, the
 * right spans get redacted. Generic non-PII families (events, products,
 * quantities, bare dates) never match and stay readable.
 */

/** ConLL labels worth redacting; MISC (events, products) is left alone. */
const KEEP = new Set(["PER", "ORG", "LOC"]);

const PII_LABEL_RE =
  /person|people|human|name|org|company|employer|location|city|address|street|country|state|province|zip|postal|email|mail|phone|tel|mobile|contact|account|credit|card|cvv|ssn|social|aadhaar|adhaar|uidai|pan|passport|driver|license|vehicle|voter|identity|dob|birth|username|user|password|secret|api|bank|routing|national|ip address|url|gender|age|occupation|profession|medical|health/i;

/** True when a model label names a PII class worth redacting. */
export function keepLabel(label: string): boolean {
  if (KEEP.has(label)) return true;
  return PII_LABEL_RE.test(label);
}