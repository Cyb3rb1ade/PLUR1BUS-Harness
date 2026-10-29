/** Credential-free configuration projection for private source snapshots; foreign values never enter reports. */
import { parseJson5 } from "./json5.ts";
import { readYaml } from "./yaml-lite.ts";
import { secretConfigKeys, ImportError } from "./types.ts";
import { decodeSourceText } from "./fs-safe.ts";
import { isSecretFileName } from "./readonly.ts";

export function isSourceConfiguration(path: string): boolean {
  return ["openclaw.json", "clawdbot.json", "config.yaml"].includes(path.split("/").at(-1) ?? "");
}

/** A directory named credentials also taints every descendant, before any file is created. */
export function isSourceCredential(path: string): boolean {
  return path.split("/").some(name => isSecretFileName(name) || name.toLowerCase() === "credentials"
    || name.toLowerCase() === "auth-profiles.json" || name === "openclaw-agent.sqlite" || name.startsWith("openclaw-agent.sqlite-"));
}

/** Names and declaration forms survive sealing so the UI can disclose found credentials without their values. */
export function sourceConfigurationKeys(path: string, bytes: Buffer) {
  const name = path.split("/").at(-1);
  if (!isSourceConfiguration(path)) return [];
  const text = decodeSourceText(bytes);
  const config = name === "config.yaml" ? readYaml(text).value : parseJson5(text);
  return secretConfigKeys(config).map(entry => ({ ...entry,
    path: name === "config.yaml" ? `${path}:${entry.path}` : entry.path }));
}

function clean(value: unknown, parent = ""): unknown {
  if (Array.isArray(value)) return value.map(item => clean(item, parent));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const variable = typeof item === "string" && (parent === "headers"
      ? /^(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(item) : /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(item));
    const sensitive = secretConfigKeys({ [key]: item }).some(entry => entry.path === key);
    if ((sensitive || parent === "env" || parent === "headers") && !variable) {
      // Keep declarations for A13's inert candidate/secret-slot projection, never their credential values.
      result[key] = key.toLowerCase() === "headers" && item && typeof item === "object" && !Array.isArray(item)
        ? clean(item, "headers") : null;
      continue;
    }
    if (key === "args" && Array.isArray(item)) {
      result[key] = item.length ? ["withheld"] : [];
      continue;
    }
    if (key === "oauth") { result[key] = true; continue; }
    if (key === "auth" && item && typeof item === "object") {
      result[key] = { type: (item as Record<string, unknown>).type === "oauth" ? "oauth" : "withheld" };
      continue;
    }
    if (key === "auth" && typeof item === "string" && !["oauth", "header", "none"].includes(item)) {
      result[key] = null;
      continue;
    }
    if (key === "cwd" && typeof item === "string") { result[key] = "withheld"; continue; }
    if (key === "command" && typeof item === "string") {
      const name = item.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
      result[key] = /^(?:node(?:\.exe)?|npx(?:\.cmd)?|uvx?|python(?:3(?:\.\d+)?)?(?:\.exe)?)$/.test(name) ? name : "unknown";
      continue;
    }
    if (typeof item === "string" && !variable && /(?:url|uri|endpoint)$/i.test(key)) {
      try {
        const url = new URL(item);
        if (url.username || url.password || url.search || url.hash) {
          result[key] = "unsupported:withheld";
          continue;
        }
      } catch {
        result[key] = "invalid-url-withheld";
        continue;
      }
    }
    Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true, value: clean(item, key.toLowerCase()) });
  }
  return result;
}

function yaml(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) return value.map(item => item && typeof item === "object"
    ? `${indent}-\n${yaml(item, depth + 1)}` : `${indent}- ${JSON.stringify(item)}\n`).join("");
  if (!value || typeof value !== "object") return `${indent}${JSON.stringify(value)}\n`;
  return Object.entries(value).map(([key, item]) => {
    const label = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) ? key : JSON.stringify(key);
    return item && typeof item === "object"
      ? `${indent}${label}:\n${yaml(item, depth + 1)}` : `${indent}${label}: ${JSON.stringify(item)}\n`;
  }).join("");
}

export function sealSourceConfiguration(path: string, bytes: Buffer): Buffer {
  const name = path.split("/").at(-1);
  if (!isSourceConfiguration(path)) return bytes;
  try {
    const text = decodeSourceText(bytes);
    if (name === "config.yaml") {
      const parsed = readYaml(text);
      if (parsed.unsupported.length) throw new Error();
      const sealed = clean(parsed.value);
      return JSON.stringify(sealed) === JSON.stringify(parsed.value) ? bytes : Buffer.from(yaml(sealed));
    }
    const parsed = parseJson5(text);
    const sealed = clean(parsed);
    return JSON.stringify(sealed) === JSON.stringify(parsed) ? bytes : Buffer.from(JSON.stringify(sealed, null, 2) + "\n");
  } catch {
    throw new ImportError("E_SOURCE_UNSUPPORTED", "config-unparseable", "Source configuration cannot be sealed safely");
  }
}
