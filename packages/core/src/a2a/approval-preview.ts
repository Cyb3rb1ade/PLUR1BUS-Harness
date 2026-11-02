import { createRedactor, secretFormsOf } from "../logs/redact.ts";

/** Decode nested wire text before redaction; clip only after every secret variant is masked. */
export function peerApprovalPreview(body: string, secrets: Iterable<string>): string {
  const values = [...secrets];
  const redactor = createRedactor({ secrets: values, pii: true });
  const forms = values.flatMap(secretFormsOf).filter(Boolean).sort((a, b) => b.length - a.length);
  const mask = (text: string): string => {
    for (const form of forms) text = text.split(form).join("[REDACTED:secret]");
    return redactor.text(text);
  };
  let nodes = 0;
  const walk = (value: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 24) throw new Error("preview exceeds its traversal bound");
    if (typeof value === "string") {
      if (/^\s*[\[{]/.test(value)) {
        let decoded: unknown;
        try { decoded = JSON.parse(value); } catch { return mask(value); }
        return walk(decoded, depth + 1);
      }
      return mask(value);
    }
    if (Array.isArray(value)) return value.map(child => walk(child, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, child] of Object.entries(value)) out[mask(key)] = walk(child, depth + 1);
      return out;
    }
    return value;
  };
  let safe: string;
  try {
    let decoded: unknown;
    try { decoded = JSON.parse(body); } catch { decoded = body; }
    safe = mask(JSON.stringify(walk(decoded, 0)));
  } catch {
    safe = "[Preview withheld: content could not be checked]";
  }
  return [...safe].slice(0, 1200).join("");
}
