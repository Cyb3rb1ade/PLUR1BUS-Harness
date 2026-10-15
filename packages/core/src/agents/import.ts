// The export's embedded public key establishes integrity, not trust in the exporting installation.
import { createHash, createPublicKey, verify } from "node:crypto";
import { createRedactor, isSecretKey } from "../logs/redact.ts";
import { isSecretName } from "../secrets/types.ts";
import { canonicalManifest } from "./manifest.ts";
import { RpcError } from "../rpc/errors.ts";
export interface AgentFile { path: string; text: string }
export interface AgentBundle { files: AgentFile[]; agentId: string; requiredSecrets: string[]; rights: unknown; hash: string }
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export const secretName = isSecretName;
const fail = (): never => { throw new RpcError("E_INVALID_PARAMS", "invalid agent export", { detail: "bundle" }); };
export function readAgentBundle(input: unknown): AgentBundle {
  try {
    if (!record(input) || input.format !== "plur1bus.agent-export/1" || !record(input.manifest) || input.manifest.format !== input.format || !Array.isArray(input.files) || !Array.isArray(input.manifest.files)) return fail();
    if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024 || input.files.length > 256 || input.files.length !== input.manifest.files.length) return fail();
    const seen = new Set<string>(); let bytes = 0;
    for (const [n, file] of input.files.entries()) {
      const meta = input.manifest.files[n];
      if (!record(file) || typeof file.path !== "string" || typeof file.text !== "string" || !record(meta) || meta.path !== file.path || seen.has(file.path.toLowerCase())) return fail();
      // Exact export allow-list; there is no path normalisation that could hide traversal or platform aliases.
      const parts = file.path.split("/");
      if (parts.length > 6 || parts.some((p: string) => !/^[A-Za-z0-9_ -][A-Za-z0-9_. -]{0,99}$/.test(p) || p.endsWith(".") || p.endsWith(" ") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p) || isSecretKey(p))) return fail();
      const allowed = ["config.json", "memory/cards.json", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "persona-voice.md"].includes(file.path) || /^(memory|skills|workspace\/memory)\/.+\.md$/.test(file.path);
      bytes += Buffer.byteLength(file.text);
      if (!allowed || bytes > 2 * 1024 * 1024 || meta.bytes !== Buffer.byteLength(file.text) || meta.sha256 !== sha(file.text)) return fail();
      seen.add(file.path.toLowerCase());
    }
    if (!seen.has("config.json") || !seen.has("memory/cards.json") || typeof input.manifest.agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.manifest.agentId)) return fail();
    // Earlier v1 exports hashed the construction order. Reconstruct that known order for old CLI exports.
    // Metadata is included in both candidates, so adding rights cannot bypass the signature.
    const legacy = { format: input.manifest.format, agentId: input.manifest.agentId,
      ...(input.manifest.rights !== undefined ? { rights: input.manifest.rights } : {}),
      ...(input.manifest.requiredSecrets !== undefined ? { requiredSecrets: input.manifest.requiredSecrets } : {}),
      files: input.manifest.files.map((m: any) => ({ path: m.path, bytes: m.bytes, sha256: m.sha256 })) };
    if (Object.keys(input.manifest).some(key => !Object.hasOwn(legacy, key))) return fail();
    const candidates = [sha(JSON.stringify(canonicalManifest(input.manifest))), sha(JSON.stringify(input.manifest)), sha(JSON.stringify(legacy))];
    const hash = input.manifestHash ?? candidates[0]!;
    if (!candidates.includes(hash)) return fail();
    if (input.signature !== undefined || input.publicKey !== undefined || input.algorithm !== undefined) {
      if (input.algorithm !== "Ed25519" || typeof input.signature !== "string" || typeof input.publicKey !== "string") return fail();
      const key = createPublicKey({ key: Buffer.from(input.publicKey, "base64"), type: "spki", format: "der" });
      if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(hash, "hex"), key, Buffer.from(input.signature, "base64"))) return fail();
    }
    const requiredSecrets = input.manifest.requiredSecrets ?? [];
    if (!Array.isArray(requiredSecrets) || requiredSecrets.length > 128 || !requiredSecrets.every(secretName)) return fail();
    return { files: input.files, agentId: input.manifest.agentId, requiredSecrets, rights: input.manifest.rights ?? {}, hash };
  } catch (e) { if (e instanceof RpcError) throw e; return fail(); }
}
/** Applied only AFTER verifying hashes/signature, including unsigned foreign bundles. Never persist credential keys. */
export function cleanImport(value: unknown): any {
  const redact = createRedactor();
  const clean = (v: unknown): any => Array.isArray(v) ? v.map(clean) : record(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !isSecretKey(k) && !["__proto__", "constructor", "prototype"].includes(k)).map(([k, val]) => [k, clean(val)])) : typeof v === "string" ? redact.text(v) : v;
  return clean(value);
}
