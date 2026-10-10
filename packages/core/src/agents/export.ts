// Bounded, UTF-8 JSON export. No archive parser, absolute paths, symlinks, credentials, or raw database files.
import { constants, openSync, readFileSync, closeSync, fstatSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRedactor, isSecretKey } from "../logs/redact.ts";
import { RpcError } from "../rpc/errors.ts";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 256;
const ROOT_FILES = new Set(["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "persona-voice.md"]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export interface ExportInput {
  root: string; agentId: string; config: unknown; memories: unknown[]; secrets?: Iterable<string>;
  signer: (hash: string) => Promise<{ publicKey: string; signature: string }>;
}
export async function exportAgent(i: ExportInput) {
  const redactor = createRedactor(i.secrets ? { secrets: i.secrets } : {});
  const files: { path: string; text: string }[] = [];
  let bytes = 0;
  const add = (path: string, raw: string) => {
    const text = redactor.text(raw); bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES || files.length >= MAX_FILES) throw new RpcError("E_NOT_AVAILABLE", "agent export exceeds transfer limit", { reason: "export-too-large" });
    files.push({ path, text });
  };
  // Secret-named config keys are omitted, rather than exporting masked references as if they were usable config.
  const clean = (v: any): any => Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !isSecretKey(k)).map(([k, value]) => [k, clean(value)])) : typeof v === "string" ? redactor.text(v) : v;
  add("config.json", JSON.stringify(clean(i.config)));
  add("memory/cards.json", JSON.stringify(redactor.value(i.memories)));
  const read = (rel: string) => {
    const path = join(i.root, rel);
    const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) return;
    if (info.size > MAX_BYTES) throw new RpcError("E_NOT_AVAILABLE", "agent export exceeds transfer limit", { reason: "export-too-large" });
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.ino !== info.ino || stat.dev !== info.dev) throw new RpcError("E_CONFLICT", "export file changed"); const data = readFileSync(fd); if (data.byteLength > MAX_BYTES) throw new RpcError("E_NOT_AVAILABLE", "agent export exceeds transfer limit", { reason: "export-too-large" }); add(rel, new TextDecoder("utf-8", { fatal: true }).decode(data)); } finally { closeSync(fd); }
  };
  const walk = (rel: string, depth: number) => {
    if (depth > 4) return;
    const dir = join(i.root, rel);
    try {
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) return;
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith(".") || !/^[A-Za-z0-9_. -]{1,100}$/.test(e.name) || isSecretKey(e.name)) continue;
        const next = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory() && (rel || ["memory", "skills", "workspace"].includes(e.name))) walk(next, depth + 1);
        else if (e.isFile() && (ROOT_FILES.has(e.name) || ((rel.startsWith("memory/") || rel === "memory" || rel.startsWith("skills/") || rel === "skills" || rel === "workspace/memory" || rel.startsWith("workspace/memory/")) && /\.md$/.test(e.name)))) read(next);
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  };
  if (lstatSync(i.root).isSymbolicLink()) throw new RpcError("E_DENIED", "agent export root cannot be a link");
  walk("", 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { format: "plur1bus.agent-export/1", agentId: i.agentId, files: files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.text), sha256: sha(f.text) })) };
  const manifestHash = sha(JSON.stringify(manifest));
  const signed = await i.signer(manifestHash);
  return { format: "plur1bus.agent-export/1", files, manifest, manifestHash, algorithm: "Ed25519", publicKey: signed.publicKey, signature: signed.signature };
}
