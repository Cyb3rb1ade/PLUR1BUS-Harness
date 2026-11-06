// Bounded, UTF-8 JSON export. No archive parser, absolute paths, symlinks, credentials, or raw database files.
import { constants, openSync, readFileSync, closeSync, fstatSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRedactor, isSecretKey, maskSecretsInJson } from "../logs/redact.ts";
import { configTextSecretEntries, redactConfig } from "@plur1bus/config-schema";
import { canonicalManifest } from "./manifest.ts";
import { RpcError } from "../rpc/errors.ts";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 256;
const ROOT_FILES = new Set(["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "persona-voice.md"]);
// Names the import's path rules would refuse (and so the whole bundle): Windows device names, trailing dot/space.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const importable = (name: string) => !RESERVED.test(name) && !name.endsWith(".") && !name.endsWith(" ");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export interface ExportInput {
  root: string; agentId: string; config: unknown; memories: unknown[]; secrets?: Iterable<string>; rights?: Record<string, "use" | "manage">; requiredSecrets?: string[];
  signer: (hash: string) => Promise<{ publicKey: string; signature: string }>;
}
export async function exportAgent(i: ExportInput) {
  const secrets = [...(i.secrets ?? []), ...configTextSecretEntries({ agents: { [i.agentId]: i.config } }).map(({ value }) => value)];
  const redactor = createRedactor({ secrets });
  const files: { path: string; text: string }[] = [];
  let bytes = 0;
  const keep = (path: string, text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES || files.length >= MAX_FILES) throw new RpcError("E_NOT_AVAILABLE", "agent export exceeds transfer limit", { reason: "export-too-large" });
    files.push({ path, text });
  };
  const add = (path: string, raw: string) => keep(path, redactor.text(raw));
  // Configuration follows its root schema prefix. The exact-value backstop cannot reinterpret public key names or JSON types.
  const config = redactConfig(i.config, { key: "agents.*" });
  const configJson = JSON.stringify(config);
  keep("config.json", maskSecretsInJson(configJson, config, secrets)?.json ?? configJson);
  add("memory/cards.json", JSON.stringify(redactor.value(i.memories)));
  const read = (rel: string) => {
    const path = join(i.root, rel);
    const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) return;
    if (info.size > MAX_BYTES) throw new RpcError("E_NOT_AVAILABLE", "agent export exceeds transfer limit", { reason: "export-too-large" });
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.ino !== info.ino || stat.dev !== info.dev) throw new RpcError("E_CONFLICT", "export file changed"); const data = readFileSync(fd); if (data.byteLength > MAX_BYTES) throw new RpcError("E_NOT_AVAILABLE", "agent export exceeds transfer limit", { reason: "export-too-large" }); let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new RpcError("E_STORAGE", "agent export source is unreadable"); } add(rel, text); } finally { closeSync(fd); }
  };
  const walk = (rel: string, depth: number) => {
    if (depth > 4) return;
    const dir = join(i.root, rel);
    try {
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) return;
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith(".") || !/^[A-Za-z0-9_. -]{1,100}$/.test(e.name) || !importable(e.name) || isSecretKey(e.name)) continue;
        const next = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory() && (rel || ["memory", "skills", "workspace"].includes(e.name))) walk(next, depth + 1);
        else if (e.isFile() && ((!rel && ROOT_FILES.has(e.name)) || ((rel.startsWith("memory/") || rel === "memory" || rel.startsWith("skills/") || rel === "skills" || rel === "workspace/memory" || rel.startsWith("workspace/memory/")) && /\.md$/.test(e.name)))) read(next);
      }
    } catch (e) { if (e instanceof RpcError) throw e; if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new RpcError("E_STORAGE", "agent export source unavailable"); }
  };
  let rootInfo: ReturnType<typeof lstatSync>;
  try { rootInfo = lstatSync(i.root); } catch { throw new RpcError("E_STORAGE", "agent export source unavailable"); }
  if (rootInfo.isSymbolicLink()) throw new RpcError("E_DENIED", "agent export root cannot be a link");
  walk("", 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = canonicalManifest({ format: "plur1bus.agent-export/1", agentId: i.agentId, ...(i.rights ? { rights: i.rights } : {}), ...(i.requiredSecrets?.length ? { requiredSecrets: i.requiredSecrets } : {}), files: files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.text), sha256: sha(f.text) })) });
  const manifestJson = JSON.stringify(manifest);
  // Reference names normally stay readable. A known-value collision cannot be masked into an invalid signed manifest.
  let unsafeMetadata = true;
  try { unsafeMetadata = maskSecretsInJson(manifestJson, manifest, secrets) !== undefined; }
  catch { /* An uncheckable metadata value must also withhold the export. */ }
  if (unsafeMetadata) throw new RpcError("E_NOT_AVAILABLE", "agent export metadata contains a registered secret value; resolve the reference-name collision before exporting", { reason: "export-secret-metadata" });
  const manifestHash = sha(manifestJson);
  const signed = await i.signer(manifestHash);
  return { format: "plur1bus.agent-export/1", files, manifest, manifestHash, algorithm: "Ed25519", publicKey: signed.publicKey, signature: signed.signature };
}
