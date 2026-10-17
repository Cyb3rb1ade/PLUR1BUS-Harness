/** Durable TLS material for the API's remote listener. All bundles and keys remain in private account-owned files. */
import { X509Certificate, createPrivateKey, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSecurePath } from "@plur1bus/module-api";
import { certPin, createMemorySecretPort, generateSelfSigned, importCompanyCa, loadTlsMaterial, splitPem, type Pin } from "../../remote-access/src/index.ts";
export interface RemoteTlsMaterial { readonly key: string; readonly cert: string; readonly kind: "self-signed" | "company-ca"; readonly certPin: Pin; readonly caPin?: Pin; readonly notAfter: number }
export interface CertificateNames { readonly hostnames: readonly string[]; readonly ips?: readonly string[] }
export class RemoteCertificateError extends Error { readonly reason: string; constructor(reason: string) { super(`remote TLS material unavailable (${reason})`); this.reason = reason; } }
const failed = (reason: string): never => { throw new RemoteCertificateError(reason); };
export function privateAtomicJson(path: string, value: unknown): void {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`; let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600); writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
    if (!createSecurePath()(temp, { mode: 0o600 }).applied) failed("permissions"); renameSync(temp, path);
    if (process.platform !== "win32") { const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); }
}
export function readPrivateText(path: string): string | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 256 * 1024 || process.platform !== "win32" && (st.mode & 0o077 || typeof process.geteuid === "function" && st.uid !== process.geteuid())) failed("untrusted-file");
    if (!createSecurePath()(path, { mode: 0o600 }).applied) failed("permissions"); return readFileSync(path, "utf8");
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; if (e instanceof RemoteCertificateError) throw e; return failed("storage"); }
}
export class RemoteCertificates {
  readonly #dir: string; readonly #names: CertificateNames; readonly #now: () => number;
  constructor(o: { home: string; names: CertificateNames; now?: () => number }) {
    this.#dir = join(o.home, "state", "api", "remote-tls"); this.#names = o.names; this.#now = o.now ?? Date.now;
    try {
      mkdirSync(this.#dir, { mode: 0o700, recursive: true }); const st = lstatSync(this.#dir);
      if (!st.isDirectory() || typeof process.geteuid === "function" && st.uid !== process.geteuid()) failed("untrusted-directory");
      chmodSync(this.#dir, 0o700); if (!createSecurePath()(this.#dir, { mode: 0o700 }).applied) failed("permissions");
    } catch (e) { if (e instanceof RemoteCertificateError) throw e; failed("storage"); }
  }
  #read(slot: "current" | "next"): RemoteTlsMaterial | undefined {
    const raw = readPrivateText(join(this.#dir, slot + ".json")); if (raw === undefined) return undefined;
    try {
      const b = JSON.parse(raw) as Record<string, unknown>;
      if (!b || b.version !== 1 || !["self-signed", "company-ca"].includes(b.kind as string) || typeof b.key !== "string" || typeof b.cert !== "string" || b.key.length > 65536 || b.cert.length > 196608) failed("corrupt-bundle");
      return this.#validate(b.key as string, b.cert as string, b.kind as RemoteTlsMaterial["kind"], typeof b.ca === "string" ? b.ca : undefined);
    } catch (e) { if (e instanceof RemoteCertificateError) throw e; return failed("corrupt-bundle"); }
  }
  #validate(key: string, cert: string, kind: RemoteTlsMaterial["kind"], ca?: string): RemoteTlsMaterial {
    try {
      const leaf = new X509Certificate(cert); if (!leaf.checkPrivateKey(createPrivateKey(key))) failed("key-mismatch");
      const chain = [...splitPem(cert), ...(ca ? splitPem(ca) : [])].map(pem => new X509Certificate(pem));
      const after = Math.min(...chain.map(c => Date.parse(c.validTo)));
      if (!Number.isFinite(after) || chain.some(c => !Number.isFinite(Date.parse(c.validFrom)) || Date.parse(c.validFrom) > this.#now()) || after <= this.#now()) failed("certificate-expired");
      for (const host of this.#names.hostnames) if (!leaf.checkHost(host, { subject: "never" })) failed("certificate-name");
      for (const ip of this.#names.ips ?? []) if (!leaf.checkIP(ip)) failed("certificate-name");
      return { key, cert, kind, certPin: certPin(leaf), ...(ca ? { caPin: certPin(ca) } : {}), notAfter: after };
    } catch (e) { if (e instanceof RemoteCertificateError) throw e; return failed("invalid-certificate"); }
  }
  hasCurrent(): boolean { return readPrivateText(join(this.#dir, "current.json")) !== undefined; }
  current(): RemoteTlsMaterial | undefined { return this.#read("current"); }
  staged(): RemoteTlsMaterial | undefined { return this.#read("next"); }
  async #selfSigned(slot: "current" | "next"): Promise<RemoteTlsMaterial> {
    const secrets = createMemorySecretPort(), keyRef = "remote-listener";
    const made = await generateSelfSigned({ ...this.#names, now: new Date(this.#now()), keyRef, secrets });
    const material = await loadTlsMaterial(secrets, keyRef, made.certPem); const result = this.#validate(material.key, material.cert, "self-signed");
    privateAtomicJson(join(this.#dir, slot + ".json"), { version: 1, kind: result.kind, key: result.key, cert: result.cert }); return result;
  }
  async ensureSelfSigned(): Promise<RemoteTlsMaterial> {
    const existing = this.current(); if (existing) { if (existing.kind !== "self-signed") return failed("tls-mode-mismatch"); return existing; } return this.#selfSigned("current");
  }
  async stageSelfSigned(): Promise<RemoteTlsMaterial> { if (this.staged()) return failed("already-staged"); return this.#selfSigned("next"); }
  async stageCompany(input: { certChainPem: string; keyPem: string; caPem?: string }): Promise<RemoteTlsMaterial> {
    if (this.staged()) return failed("already-staged"); if (input.certChainPem.length > 196608 || input.keyPem.length > 65536 || (input.caPem?.length ?? 0) > 65536) return failed("upload-size");
    const secrets = createMemorySecretPort(), keyRef = "remote-listener", imported = await importCompanyCa({ ...input, ...this.#names, now: new Date(this.#now()), keyRef, secrets });
    if (!imported.ok) return failed(imported.issues[0]?.code ?? "company-ca-invalid");
    const material = await loadTlsMaterial(secrets, keyRef, imported.chainPem), result = this.#validate(material.key, material.cert, "company-ca", imported.caPem);
    privateAtomicJson(join(this.#dir, "next.json"), { version: 1, kind: result.kind, key: result.key, cert: result.cert, ...(imported.caPem ? { ca: imported.caPem } : {}) }); return result;
  }
  /** Called only after the trust controller has announced next over the existing trusted channel. */
  activateStaged(): RemoteTlsMaterial {
    const next = this.staged(); if (!next) return failed("not-staged"); renameSync(join(this.#dir, "next.json"), join(this.#dir, "current.json"));
    if (process.platform !== "win32") { const fd = openSync(this.#dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
    return next;
  }
  cancelStaged(): void { rmSync(join(this.#dir, "next.json"), { force: true }); }
}
