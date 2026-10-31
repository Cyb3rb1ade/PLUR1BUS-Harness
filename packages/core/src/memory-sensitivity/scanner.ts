import { createHash } from "node:crypto";
import { createRedactor } from "../logs/redact.ts";
import type { SensitivityCategory } from "./types.ts";

export function computeContentHash(text: string, summary?: string): string {
  const norm = (text ?? "").trim() + "\n" + (summary ?? "").trim();
  return createHash("sha256").update(norm, "utf8").digest("hex");
}

const HEALTH_RE =
  /\b(?:diagnos(?:is|e)|prescript(?:ion|e)|rezept|medicat(?:ion|e)|medikament|illness|krankheit|disease|hospital|krankenhaus|doctor|arzt|medical|gesundheit|befund|treatment|behandlung|symptom(?:e|s)?|therap(?:y|ie)|patient|blutdruck|blood\s*pressure|diabetes|cancer|krebs|allerg(?:y|ie)|hypertension|asthma)\b/i;

const FINANCIAL_KEYWORDS_RE =
  /\b(?:iban|bic|swift|bank\s*account|routing\s*number|kreditkarte|credit\s*card|debit\s*card|bankverbindung|kontonummer|bankleitzahl|gehalt|salary|payroll|überweisung|wire\s*transfer)\b/i;

const IBAN_RE = /[A-Z]{2}[0-9]{2}(?:[ ]?[0-9A-Z]{4}){2,7}(?:[ ]?[0-9A-Z]{1,4})?/i;
const CARD_RE =
  /(?:4[0-9]{3}(?:[ -]?[0-9]{4}){3}(?:[ -]?[0-9]{3})?|5[1-5][0-9]{2}(?:[ -]?[0-9]{4}){3}|2[2-7][0-9]{2}(?:[ -]?[0-9]{4}){3}|3[47][0-9]{2}[ -]?[0-9]{6}[ -]?[0-9]{5}|3[47][0-9]{13}|6(?:011|5[0-9]{2})(?:[ -]?[0-9]{4}){3}|(?:[0-9]{4}[ -]){3}[0-9]{4})/;

const IDENTITY_RE =
  /\b(?:passport|reisepass|social\s*security|ssn|sozialversicherung|driver'?s\s*license|führerschein|national\s*id|personalausweis|ausweisnummer|steuer[_-]?id|tax\s*id|steueridentifikationsnummer|birth\s*certificate|geburtsurkunde)\b/i;

const PERSONAL_RE =
  /\b(?:date\s*of\s*birth|geburtsdatum|home\s*address|wohnort|privatadresse|private\s*address|personal\s*phone|handynummer|marital\s*status|familienstand|religion|confession)\b/i;

export class SensitivityScanner {
  readonly #redactor = createRedactor();

  scan(text: string, summary?: string): SensitivityCategory[] {
    const combined = `${text ?? ""}\n${summary ?? ""}`;
    const detected: SensitivityCategory[] = [];

    // Health
    if (HEALTH_RE.test(combined)) {
      detected.push("health");
    }

    // Financial
    if (FINANCIAL_KEYWORDS_RE.test(combined) || IBAN_RE.test(combined) || CARD_RE.test(combined)) {
      detected.push("financial");
    }

    // Credential
    const redacted = this.#redactor.text(combined);
    if (
      redacted.includes("[REDACTED:key]") ||
      redacted.includes("[REDACTED:pattern]") ||
      redacted.includes("[REDACTED:secret]") ||
      redacted.includes("<deny:") ||
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|Bearer\s+\S+)\b/i.test(combined)
    ) {
      detected.push("credential");
    }

    // Identity
    if (IDENTITY_RE.test(combined)) {
      detected.push("identity");
    }

    // Personal
    if (PERSONAL_RE.test(combined)) {
      detected.push("personal");
    }

    return detected.sort();
  }
}
