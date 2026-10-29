/** Private worker controls. Only bounded metadata leaves stdout; full target config travels on private stdin. */
import type { Readable, Writable } from "node:stream";
import { isAbsolute } from "node:path";
import { ImportError } from "./types.ts";
import type { ImportProgress } from "./maintenance-types.ts";
import type { ImportMaintenanceResult } from "./maintenance-worker.ts";
import { createImportSourceSecrets, isImportSecretName, type ImportSecretLease,
  type ImportSourceSecrets } from "./source-secrets.ts";

const MAX_LINE = 64 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024 + 4096;
const CONTROL_TIMEOUT_MS = 120_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const HASH = /^[a-f0-9]{64}$(?![\s\S])/;
const METHODS = ["config.get", "config.set", "config.restore", "extension.plan", "extension.install", "extension.rollback"];
const PHASES = ["detect", "plan", "preflight", "snapshot", "apply", "rollback", "verify", "complete"];
const ENTITIES = ["agent", "skill", "memory", "store", "config", "secret", "extension"];
const unavailable = () => new ImportError("E_IMPORT_FAILED", "worker-control-unavailable",
  "Import worker control is unavailable");

export type ImportHostMethod = "config.get" | "config.set" | "config.restore"
  | "extension.plan" | "extension.install" | "extension.rollback";

export interface ImportWorkerJob {
  v: 1;
  runId: string;
  mode: "apply" | "rollback" | "recover";
  home: string;
  plan: { id: string; sha256: string };
  ownerId: string;
  attempt: number;
  preflightId?: string;
  targetSha256?: string;
  automaticRollback?: true;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !keys.includes(key))) throw unavailable();
  return raw;
}

function readJob(value: unknown): ImportWorkerJob {
  const raw = object(value, ["v", "runId", "mode", "home", "plan", "ownerId", "attempt", "preflightId", "targetSha256",
    "automaticRollback"]);
  const plan = object(raw.plan, ["id", "sha256"]);
  if (raw.v !== 1 || typeof raw.runId !== "string" || !UUID.test(raw.runId)
    || !["apply", "rollback", "recover"].includes(String(raw.mode))
    || typeof raw.home !== "string" || raw.home.length > 4096 || !isAbsolute(raw.home)
    || typeof plan.id !== "string" || !UUID.test(plan.id)
    || typeof plan.sha256 !== "string" || !HASH.test(plan.sha256)
    || typeof raw.ownerId !== "string" || !raw.ownerId || raw.ownerId.length > 512
    || !Number.isSafeInteger(raw.attempt) || (raw.attempt as number) < 1 || (raw.attempt as number) > 1000
    || raw.preflightId !== undefined && (typeof raw.preflightId !== "string" || !UUID.test(raw.preflightId))
    || raw.targetSha256 !== undefined && (typeof raw.targetSha256 !== "string" || !HASH.test(raw.targetSha256))
    || raw.automaticRollback !== undefined && (raw.automaticRollback !== true || raw.mode !== "rollback")) {
    throw unavailable();
  }
  return raw as unknown as ImportWorkerJob;
}

async function* lines(input: Readable, maximum: () => number): AsyncGenerator<unknown> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      if (end + 1 > maximum()) throw unavailable();
      const line = pending.subarray(0, end);
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      line.fill(0);
      pending = pending.subarray(end + 1);
      yield value;
    }
    if (pending.length >= maximum()) throw unavailable();
  }
  if (pending.length) throw unavailable();
}

function sourceTransfer(value: unknown, job: ImportWorkerJob, store: ImportSourceSecrets): ImportSecretLease {
  const raw = object(value, ["v", "type", "runId", "planId", "preflightId", "entries"]);
  if (raw.v !== 1 || raw.type !== "secret-source" || raw.runId !== job.runId || raw.planId !== job.plan.id
    || !job.preflightId || raw.preflightId !== job.preflightId
    || Buffer.byteLength(JSON.stringify(raw)) > 1024 * 1024) throw unavailable();
  if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) throw unavailable();
  const entries = raw.entries as Record<string, unknown>;
  const values = new Map<string, Buffer>();
  try {
    for (const name of Object.keys(entries)) {
      if (!isImportSecretName(name) || typeof entries[name] !== "string") throw unavailable();
      values.set(name, Buffer.from(entries[name] as string));
      entries[name] = undefined;
    }
    const binding = { ownerId: job.ownerId, planId: job.plan.id, planSha256: job.plan.sha256,
      preflightId: job.preflightId };
    store.prepare({ ...binding, entries: values, expiresAt: Date.now() + 300_000 });
    return store.take(binding);
  } finally {
    for (const bytes of values.values()) bytes.fill(0);
  }
}

function controlParams(method: ImportHostMethod, value: unknown, runId: string): object {
  if (method === "config.get") return object(value, []);
  if (method === "config.restore") {
    const raw = object(value, ["sha256"]);
    if (raw.sha256 !== null && (typeof raw.sha256 !== "string" || !HASH.test(raw.sha256))) throw unavailable();
    return raw;
  }
  if (method === "config.set") {
    const raw = object(value, ["changes", "dryRun", "ifRevision"]);
    if (!Array.isArray(raw.changes) || raw.changes.length < 1 || raw.changes.length > 64
      || typeof raw.dryRun !== "boolean"
      || raw.ifRevision !== undefined && (typeof raw.ifRevision !== "string" || raw.ifRevision.length > 256)) {
      throw unavailable();
    }
    for (const value of raw.changes) {
      const change = object(value, ["key", "value"]);
      if (typeof change.key !== "string" || !change.key || change.key.length > 4096
        || !("value" in change)) throw unavailable();
    }
    return raw;
  }
  const raw = object(value, method === "extension.install" ? ["candidate", "runId"]
    : method === "extension.plan" ? ["candidate"] : ["receipt"]);
  if (method === "extension.install" && raw.runId !== runId) throw unavailable();
  const metadata = raw[method === "extension.rollback" ? "receipt" : "candidate"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw unavailable();
  return raw;
}

/** Opens one job and pumps host replies concurrently, so cancellation can arrive while an importer awaits I/O. */
export async function openImportWorkerPort(options: { input: Readable; output: Writable }) {
  const abort = new AbortController();
  const pending = new Map<number, { method: ImportHostMethod; resolve: (value: unknown) => void;
    reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let job: ImportWorkerJob | undefined;
  let closed = false;
  let disconnected = false;
  let nextId = 0;
  let resolveJob!: (job: ImportWorkerJob) => void;
  let rejectJob!: (error: Error) => void;
  const sourceSecrets = createImportSourceSecrets();
  let receivedSecrets = false;
  let takenSecrets = false;
  let resolveSecrets!: (lease: ImportSecretLease) => void;
  let rejectSecrets!: (error: Error) => void;
  const secretReady = new Promise<ImportSecretLease>((resolve, reject) => {
    resolveSecrets = resolve;
    rejectSecrets = reject;
  });
  void secretReady.catch(() => {});
  const ready = new Promise<ImportWorkerJob>((resolve, reject) => {
    resolveJob = resolve;
    rejectJob = reject;
  });
  const fail = () => {
    disconnected = true;
    abort.abort(unavailable());
    sourceSecrets.close();
    rejectSecrets(unavailable());
    rejectJob(unavailable());
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(unavailable());
    }
    pending.clear();
  };
  options.output.on("error", fail);
  const boot = setTimeout(fail, 5000);
  boot.unref();
  const pump = (async () => {
    try {
      for await (const value of lines(options.input, () => job ? MAX_RESPONSE : MAX_LINE)) {
        if (!job) {
          job = readJob(value);
          clearTimeout(boot);
          resolveJob(job);
          continue;
        }
        if (value && typeof value === "object" && (value as { type?: unknown }).type === "secret-source") {
          if (receivedSecrets || abort.signal.aborted) throw unavailable();
          const lease = sourceTransfer(value, job, sourceSecrets);
          receivedSecrets = true;
          resolveSecrets(lease);
          continue;
        }
        const raw = object(value, ["v", "type", "runId", "id", "ok", "result", "error"]);
        if (raw.v !== 1 || raw.runId !== job.runId) throw unavailable();
        if (raw.type === "abort") {
          if (Object.keys(raw).length !== 3) throw unavailable();
          abort.abort(unavailable());
          sourceSecrets.close();
          rejectSecrets(unavailable());
          continue;
        }
        if (raw.type !== "response" || !Number.isSafeInteger(raw.id) || typeof raw.ok !== "boolean") {
          throw unavailable();
        }
        const entry = pending.get(raw.id as number);
        if (!entry || entry.method !== "config.get" && Buffer.byteLength(JSON.stringify(raw)) > MAX_LINE) {
          throw unavailable();
        }
        pending.delete(raw.id as number);
        clearTimeout(entry.timer);
        if (raw.ok) entry.resolve(raw.result);
        else entry.reject(unavailable());
      }
      if (!closed) fail();
    } catch {
      fail();
    } finally {
      clearTimeout(boot);
    }
  })();
  const initial = await ready;
  const write = async (value: object) => {
    if (closed || disconnected) throw unavailable();
    let bytes: string;
    try {
      bytes = JSON.stringify(value) + "\n";
    } catch {
      throw unavailable();
    }
    if (Buffer.byteLength(bytes) > MAX_LINE) throw unavailable();
    await new Promise<void>((resolve, reject) => options.output.write(bytes, error => {
      if (error) reject(unavailable());
      else resolve();
    }));
  };
  return {
    job: initial,
    signal: abort.signal,
    async takeSourceSecrets(): Promise<ImportSecretLease> {
      if (takenSecrets || abort.signal.aborted) throw unavailable();
      takenSecrets = true;
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([secretReady, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(unavailable()), CONTROL_TIMEOUT_MS);
          timer.unref();
        })]);
      } finally {
        clearTimeout(timer);
      }
    },
    async request(method: ImportHostMethod, params: object): Promise<unknown> {
      if (!METHODS.includes(method) || closed || disconnected || pending.size >= 8) throw unavailable();
      const envelope = { v: 1, type: "request", runId: initial.runId, id: ++nextId, method,
        params: controlParams(method, params, initial.runId) };
      // Validate before creating the pending promise so rejected oversized writes cannot cause an unhandled rejection.
      if (Buffer.byteLength(JSON.stringify(envelope)) + 1 > MAX_LINE) throw unavailable();
      let resolve!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<unknown>((accept, refuse) => { resolve = accept; reject = refuse; });
      const timer = setTimeout(() => {
        pending.delete(envelope.id);
        reject(unavailable());
      }, CONTROL_TIMEOUT_MS);
      timer.unref();
      pending.set(envelope.id, { method, resolve, reject, timer });
      try {
        await write(envelope);
      } catch {
        pending.delete(envelope.id);
        clearTimeout(timer);
        throw unavailable();
      }
      return result;
    },
    async progress(event: ImportProgress): Promise<void> {
      const raw = object(event, ["runId", "phase", "completed", "total", "entity"]);
      if (raw.runId !== initial.runId || !PHASES.includes(String(raw.phase))
        || !Number.isSafeInteger(raw.completed) || (raw.completed as number) < 0
        || raw.total !== undefined && (!Number.isSafeInteger(raw.total) || (raw.total as number) < 0)
        || raw.entity !== undefined && !ENTITIES.includes(String(raw.entity))) throw unavailable();
      await write({ v: 1, type: "progress", ...raw });
    },
    async result(value: ImportMaintenanceResult): Promise<void> {
      const raw = object(value, ["ok", "status", "restored", "resumable", "error", "report"]);
      if (typeof raw.ok !== "boolean" || typeof raw.restored !== "boolean" || typeof raw.resumable !== "boolean"
        || !["completed", "aborted", "failed"].includes(String(raw.status))) throw unavailable();
      if (raw.error !== undefined) {
        const error = object(raw.error, ["code", "reason"]);
        if (typeof error.code !== "string" || !/^E_[A-Z_]{1,60}$/.test(error.code)
          || typeof error.reason !== "string" || !/^[a-z0-9-]{1,64}$/.test(error.reason)) throw unavailable();
      }
      if (raw.report !== undefined) {
        const report = object(raw.report, ["schema", "sha256", "bytes"]);
        if (typeof report.schema !== "string" || !/^import\.[a-z0-9-]+\/1$/.test(report.schema)
          || typeof report.sha256 !== "string" || !HASH.test(report.sha256)
          || !Number.isSafeInteger(report.bytes) || (report.bytes as number) < 0) throw unavailable();
      }
      await write({ v: 1, type: "result", runId: initial.runId, ...raw });
    },
    close(): void {
      if (closed) return;
      closed = true;
      fail();
      options.output.off("error", fail);
      options.input.destroy();
      void pump;
    },
  };
}

export type ImportWorkerPort = Awaited<ReturnType<typeof openImportWorkerPort>>;
