// A13's native package-store boundary and metadata-only run receipts. Existing CLI reports stay unchanged.
// The native port owns package transactions, disabled/imported provenance and durable run+fingerprint recovery.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicSync } from "./fs-atomic.ts";
import { readSourceTextSafe } from "./fs-safe.ts";
import type { ImportedMcpCandidate } from "./mcp-config.ts";
import { ImportError } from "./types.ts";

export interface ImportedExtensionReceipt {
  schema: "import.extension-receipt/1";
  name: string;
  fingerprint: string;
  /** Opaque native receipt handle; contains no path, launch descriptor or credential. */
  installationId: string;
}

export interface ImportedExtensionPort {
  plan(candidate: ImportedMcpCandidate): Promise<{ action: "install" | "existing" | "conflict" }>;
  /** Idempotent on runId+fingerprint, including a crash before the returned receipt reaches the sidecar. */
  install(candidate: ImportedMcpCandidate, runId: string): Promise<ImportedExtensionReceipt>;
  /** Idempotent; only undo the receipt's own installation, preserving existing packages and extension data. */
  rollback(receipt: ImportedExtensionReceipt): Promise<void>;
}

interface ExtensionEntry {
  name: string;
  fingerprint: string;
  status: "installed" | "existing" | "conflict" | "rolled-back";
  receipt?: ImportedExtensionReceipt;
}

export interface ExtensionRunMetadata {
  schema: "import.extensions/1";
  runId: string;
  entries: ExtensionEntry[];
}

const HASH = /^[a-f0-9]{64}$(?![\s\S])/;
const NAME = /^[a-z][a-z0-9-]{0,61}$(?![\s\S])/;
const RUN = /^[A-Za-z0-9_-]{1,64}$(?![\s\S])/;
const MAX_ENTRIES = 256;

function fail(reason: string): never {
  throw new ImportError("E_IMPORT_FAILED", reason, "Extension import metadata operation failed");
}

/** Reject every symlink/junction component before opening or replacing the private sidecar. */
function metadataPath(home: string, runId: string): string {
  if (!RUN.test(runId)) fail("extension-metadata-invalid");
  let current = home;
  for (const part of ["", "imports", runId, "extensions.json"]) {
    if (part) current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || (part === "extensions.json" ? !stat.isFile() : !stat.isDirectory())) {
      fail("extension-metadata-unsafe-path");
    }
  }
  return current;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function receipt(value: unknown, name: string, fingerprint: string): ImportedExtensionReceipt {
  const raw = object(value);
  if (raw.schema !== "import.extension-receipt/1" || raw.name !== name || raw.fingerprint !== fingerprint
    || typeof raw.installationId !== "string" || !HASH.test(raw.installationId)) fail("extension-receipt-invalid");
  return { schema: "import.extension-receipt/1", name, fingerprint, installationId: raw.installationId };
}

/** Validate the complete sidecar before any native rollback or package installation. Unknown fields never survive. */
export function readExtensionRun(home: string, runId: string): ExtensionRunMetadata {
  const path = metadataPath(home, runId);
  const empty: ExtensionRunMetadata = { schema: "import.extensions/1", runId, entries: [] };
  if (!lstatSync(path, { throwIfNoEntry: false })) return empty;
  let raw: Record<string, unknown>;
  try { raw = object(JSON.parse(readSourceTextSafe(path, 256 * 1024))); }
  catch { fail("extension-metadata-invalid"); }
  if (raw.schema !== empty.schema || raw.runId !== runId || !Array.isArray(raw.entries)
    || raw.entries.length > MAX_ENTRIES) fail("extension-metadata-invalid");
  const names = new Set<string>();
  const entries = raw.entries.map(value => {
    const item = object(value);
    if (typeof item.name !== "string" || !NAME.test(item.name) || names.has(item.name)
      || typeof item.fingerprint !== "string" || !HASH.test(item.fingerprint)
      || !["installed", "existing", "conflict", "rolled-back"].includes(String(item.status))) fail("extension-metadata-invalid");
    names.add(item.name);
    const entry: ExtensionEntry = { name: item.name, fingerprint: item.fingerprint, status: item.status as ExtensionEntry["status"] };
    if (entry.status === "installed" || entry.status === "rolled-back") entry.receipt = receipt(item.receipt, entry.name, entry.fingerprint);
    else if (item.receipt !== undefined) fail("extension-metadata-invalid");
    return entry;
  });
  return { ...empty, entries };
}

function persist(home: string, metadata: ExtensionRunMetadata): void {
  writeAtomicSync(metadataPath(home, metadata.runId), `${JSON.stringify(metadata, null, 2)}\n`, 0o600);
}

/** No port means the historical importer behavior; dry runs call only the read-only plan operation. */
export async function importExtensions(input: {
  home: string; runId: string; apply: boolean; candidates: ImportedMcpCandidate[]; port?: ImportedExtensionPort | undefined;
}): Promise<void> {
  if (!input.port || input.candidates.length === 0) return;
  if (input.candidates.length > MAX_ENTRIES) fail("extension-source-limit");
  const metadata = input.apply ? readExtensionRun(input.home, input.runId)
    : { schema: "import.extensions/1" as const, runId: input.runId, entries: [] };
  const names = new Set([...metadata.entries, ...input.candidates].map(entry => entry.name));
  if (names.size > MAX_ENTRIES) fail("extension-source-limit");
  for (const candidate of input.candidates) {
    const previous = metadata.entries.find(entry => entry.name === candidate.name);
    if (previous && previous.fingerprint !== candidate.fingerprint) fail("extension-resume-conflict");
    if (previous?.status === "installed" || previous?.status === "rolled-back") continue;
    let action: "install" | "existing" | "conflict";
    try { action = (await input.port.plan(candidate)).action; } catch { fail("extension-plan-failed"); }
    if (!["install", "existing", "conflict"].includes(action)) fail("extension-plan-invalid");
    if (!input.apply) continue;
    const entry: ExtensionEntry = { name: candidate.name, fingerprint: candidate.fingerprint,
      status: action === "install" ? "installed" : action };
    if (action === "install") {
      let result: ImportedExtensionReceipt;
      try { result = await input.port.install(candidate, input.runId); } catch { fail("extension-install-failed"); }
      entry.receipt = receipt(result, candidate.name, candidate.fingerprint);
    }
    if (previous) metadata.entries[metadata.entries.indexOf(previous)] = entry;
    else metadata.entries.push(entry);
    persist(input.home, metadata);
  }
}

/** The caller validates this before changing target files; absence of the native port must never fake success. */
export function requireExtensionRollbackPort(metadata: ExtensionRunMetadata, port?: ImportedExtensionPort): void {
  if (metadata.entries.some(entry => entry.status === "installed") && !port) fail("extension-port-required");
}

export async function rollbackExtensions(home: string, metadata: ExtensionRunMetadata, port?: ImportedExtensionPort): Promise<void> {
  requireExtensionRollbackPort(metadata, port);
  for (const entry of [...metadata.entries].reverse()) {
    if (entry.status !== "installed" || !entry.receipt) continue;
    try { await port!.rollback(entry.receipt); } catch { fail("extension-rollback-failed"); }
    entry.status = "rolled-back";
    persist(home, metadata);
  }
}
