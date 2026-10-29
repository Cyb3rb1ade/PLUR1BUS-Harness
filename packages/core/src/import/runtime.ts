/** Private post-restart completion uses the existing reembed driver while public writes remain held. */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { apiPrincipal, isClientContext } from "@plur1bus/module-api";
import type { MigrationDriver } from "../embedding-migrate/driver.ts";
import { targetFromModel } from "../embedding-migrate/target.ts";
import type { PrincipalResolver } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import type { CallContext, Handler } from "../rpc/server.ts";
import { RpcError } from "../rpc/errors.ts";
import { createImportRecords, type ImportPlanRecord } from "./maintenance-records.ts";
import { readColdBytes } from "./maintenance-files.ts";
import { writeAtomicSync } from "./fs-atomic.ts";
import { openMaintenanceJournal } from "./maintenance-journal.ts";
import { fingerprintImportTarget } from "./target-fingerprint.ts";
import { ImportError } from "./types.ts";

export interface ImportRunControl { runId: string; planId: string; planSha256: string }
export interface ImportRuntimeStatus {
  runId: string;
  state: "pending" | "completed" | "failed";
  completed: number;
  total?: number;
  restartRequired?: boolean;
  error?: { code: string; reason: string };
}
interface Receipt {
  schema: "import.runtime/1";
  runId: string;
  planSha256: string;
  attempt: number;
  state: "pending" | "completed" | "failed";
  migrationId?: string;
  finalizedInvocationId?: string;
}
interface RuntimeOptions {
  home: string;
  heldRunId(): string | undefined;
  resolvePrincipal: PrincipalResolver;
  /** Current AdminStore lookup; the original role stored in a plan is never authoritative. */
  person(id: string): Principal | null;
  model(model: string, licenceId: string | undefined, principal: Principal):
    Promise<{ present: boolean; licenceAccepted: boolean }>;
  runningModel(): string | undefined;
  driver(control: ImportRunControl, plan: ImportPlanRecord): MigrationDriver;
  /** Existing Engine store provisioning only, while public effects remain held. */
  prepareTarget?(signal: AbortSignal): Promise<void>;
  release(runId: string): Promise<void>;
  cleanupSource?(plan: ImportPlanRecord): Promise<void>;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const HASH = /^[a-f0-9]{64}$(?![\s\S])/;
const NATIVE_JOB_READ_ATTEMPTS = 3;
const denied = () => new RpcError("E_DENIED", "Import runtime control is unavailable", { reason: "local-core-only" });
const unavailable = () => new RpcError("E_CONFLICT", "Import runtime job changed", { reason: "import-job-changed" });

async function readNativeJob(path: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const before = await lstat(path);
    try {
      return await readColdBytes(path, 256 * 1024);
    } catch (error) {
      const after = await lstat(path);
      // Native progress atomically replaces this file while the held finalizer authenticates the same job.
      // Retry only a regular-file replacement; each attempt retains the full safe-open and size checks.
      if (attempt + 1 >= NATIVE_JOB_READ_ATTEMPTS || !(error instanceof ImportError)
        || error.reason !== "cold-snapshot-unavailable" || !before.isFile() || before.isSymbolicLink()
        || !after.isFile() || after.isSymbolicLink() || before.dev === after.dev && before.ino === after.ino) throw error;
    }
  }
}

export function createImportRuntime(options: RuntimeOptions) {
  const records = createImportRecords(options.home);
  const active = new Map<string, { driver?: MigrationDriver; done: Promise<void> }>();
  const finalizations = new Map<string, { controller: AbortController; done: Promise<void>; state: "pending" | "completed" | "failed" }>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const path = (runId: string) => join(options.home, "imports", runId, "runtime.json");
  const save = (receipt: Receipt) => writeAtomicSync(path(receipt.runId), JSON.stringify(receipt) + "\n", 0o600);
  const receipt = async (control: ImportRunControl, attempt: number): Promise<Receipt | undefined> => {
    if (!await lstat(path(control.runId)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
      return undefined;
    })) return undefined;
    let bytes: Buffer;
    for (let attempt = 0; ; attempt++) {
      try { bytes = await readColdBytes(path(control.runId), 4096); break; }
      catch (error) {
        // An in-process finalizer atomically replaces this private receipt while status requests read it.
        if (attempt === 2) throw error;
      }
    }
    const raw = JSON.parse(bytes.toString("utf8")) as Receipt;
    if (raw.schema !== "import.runtime/1" || raw.runId !== control.runId || raw.planSha256 !== control.planSha256
      || !["pending", "completed", "failed"].includes(raw.state) || !Number.isSafeInteger(raw.attempt)
      || Object.keys(raw).some(key => !["schema", "runId", "planSha256", "attempt", "state", "migrationId", "finalizedInvocationId"].includes(key))
      || raw.finalizedInvocationId !== undefined && !UUID.test(raw.finalizedInvocationId)
      || raw.migrationId !== undefined && (typeof raw.migrationId !== "string" || raw.migrationId.length > 256)) throw unavailable();
    return raw.attempt === attempt ? raw : undefined;
  };
  const authenticate = async (input: unknown, ctx: CallContext, method: string, full: boolean) => {
    if (closed || apiPrincipal(ctx) !== undefined || isClientContext(ctx)) throw denied();
    const caller = await options.resolvePrincipal(ctx, method, input);
    if (caller?.kind !== "person" || caller.role !== "owner") throw denied();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw unavailable();
    const raw = input as Record<string, unknown>;
    if (typeof raw.runId !== "string" || !UUID.test(raw.runId) || raw.runId !== options.heldRunId()
      || Object.keys(raw).some(key => !(full ? ["runId", "planId", "planSha256"] : ["runId"]).includes(key))) throw unavailable();
    const native = JSON.parse((await readNativeJob(join(options.home, "imports", raw.runId, "maintenance-run.json")))
      .toString("utf8")) as { version?: number; job?: Record<string, unknown>; run?: { state?: string } };
    const job = native.job;
    if (native.version !== 1 || !job || job.runId !== raw.runId || native.run?.state !== "restarting-core"
      || typeof job.planId !== "string" || !UUID.test(job.planId)
      || typeof job.planSha256 !== "string" || !HASH.test(job.planSha256) || typeof job.ownerId !== "string"
      || typeof job.invocationId !== "string" || !UUID.test(job.invocationId)
      || !["apply", "rollback", "recover"].includes(String(job.mode))
      || !Number.isSafeInteger(job.attempt) || (job.attempt as number) < 1
      || full && (job.planId !== raw.planId || job.planSha256 !== raw.planSha256)) throw unavailable();
    const control = { runId: raw.runId, planId: job.planId, planSha256: job.planSha256 };
    const { record: plan } = await records.readPlan(control.planId, job.ownerId, control.planSha256, true);
    if (plan.runId !== control.runId) throw unavailable();
    const actor = options.person(plan.ownerId);
    const restored = job.mode !== "apply";
    if (!restored && (actor?.kind !== "person" || !["owner", "admin"].includes(actor.role))) throw denied();
    return { control, plan, actor, attempt: job.attempt as number, restored, invocationId: job.invocationId };
  };
  type RuntimeContext = Awaited<ReturnType<typeof authenticate>>;
  const finalize = (context: RuntimeContext, ctx: CallContext) => {
    const { control, plan, attempt, invocationId } = context;
    let operation = finalizations.get(invocationId);
    if (operation) return operation;
    const controller = new AbortController();
    operation = { controller, done: Promise.resolve(), state: "pending" };
    finalizations.set(invocationId, operation);
    const bound = operation;
    const stillCurrent = async () => {
      controller.signal.throwIfAborted();
      const current = await authenticate(control, ctx, "admin.import.runtime.status", true);
      if (current.attempt !== attempt || current.invocationId !== invocationId || current.restored) throw unavailable();
      if (plan.options.reembed && options.runningModel() !== plan.options.reembed.model) throw unavailable();
      controller.signal.throwIfAborted();
      const saved = await receipt(control, attempt);
      if (saved?.state !== "completed") throw unavailable();
      controller.signal.throwIfAborted();
      return saved;
    };
    bound.done = Promise.resolve().then(async () => {
      try {
        await stillCurrent();
        const prior = openMaintenanceJournal(options.home, control.runId).read();
        if (prior.phase !== "committed" || prior.attempt !== attempt || !prior.snapshotSha256) throw unavailable();
        // Finalization runs outside RPC deadlines, but remains in this held generation's shutdown lifetime.
        await options.prepareTarget?.(controller.signal);
        controller.signal.throwIfAborted();
        const targetSha256 = await fingerprintImportTarget(options.home, plan.roots, controller.signal);
        const saved = await stillCurrent();
        const journal = openMaintenanceJournal(options.home, control.runId);
        const current = journal.read();
        if (current.phase !== "committed" || current.attempt !== attempt || current.snapshotSha256 !== prior.snapshotSha256
          || current.targetSha256 !== prior.targetSha256) throw unavailable();
        controller.signal.throwIfAborted();
        journal.finalizeCommittedTarget(targetSha256);
        save({ ...saved, finalizedInvocationId: invocationId });
        bound.state = "completed";
      } catch {
        bound.state = "failed";
        if (!closed) {
          try {
            const saved = await stillCurrent();
            controller.signal.throwIfAborted();
            save({ ...saved, state: "failed" });
          } catch { /* stale or canceled work cannot publish */ }
        }
      }
    });
    return operation;
  };
  const status = async (context: RuntimeContext, ctx: CallContext): Promise<ImportRuntimeStatus> => {
    const { control, plan, attempt, restored, invocationId } = context;
    const saved = await receipt(control, attempt);
    let state = saved?.state ?? "pending";
    const driver = active.get(control.runId)?.driver;
    const progress = await driver?.status();
    const completed = progress?.progress.rowsDone ?? 0;
    const total = progress?.progress.rows;
    if (closed) throw denied();
    const restartRequired = !restored && !!plan.options.reembed && options.runningModel() !== plan.options.reembed.model;
    if (state === "completed" && !restartRequired && !restored && saved?.finalizedInvocationId !== invocationId) {
      state = finalize(context, ctx).state;
    }
    return { runId: control.runId, state, completed, ...(total === undefined ? {} : { total }),
      ...(state === "completed" ? { restartRequired } : {}),
      ...(state === "failed" ? { error: { code: "E_IMPORT_FAILED", reason:
        finalizations.get(invocationId)?.state === "failed" ? "runtime-finalization-failed" : "reembed-failed" } } : {}) };
  };
  const start = async (context: Awaited<ReturnType<typeof authenticate>>) => {
    const { control, plan, actor, attempt, restored } = context;
    const saved = await receipt(control, attempt);
    if (closed) throw denied();
    const metadata: Receipt = { schema: "import.runtime/1", runId: control.runId,
      planSha256: control.planSha256, attempt, state: "pending", ...(saved?.migrationId ? { migrationId: saved.migrationId } : {}) };
    if (saved?.state === "failed" && !restored) return;
    if (restored || !plan.options.reembed) {
      if (saved?.state === "completed") return;
      save({ ...metadata, state: "completed" });
      return;
    }
    if (plan.sourceEmbedding?.model === plan.options.reembed.model) {
      if (saved?.state === "completed") return;
      if (!actor) throw denied();
      const check = await options.model(plan.options.reembed.model, plan.options.reembed.licenceId, actor);
      if (!check.present || !check.licenceAccepted) throw unavailable();
      save({ ...metadata, state: "completed" });
      return;
    }
    if (saved?.state === "completed" || saved?.state === "failed" || active.has(control.runId)) return;
    let begin!: () => void;
    const reserved = new Promise<void>(resolve => { begin = resolve; });
    const operation: { driver?: MigrationDriver; done: Promise<void> } = { done: reserved };
    active.set(control.runId, operation);
    operation.done = reserved.then(async () => {
      try {
        const requested = plan.options.reembed!;
        if (!actor) throw denied();
        const check = await options.model(requested.model, requested.licenceId, actor);
        if (!check.present || !check.licenceAccepted || closed) throw unavailable();
        const target = targetFromModel({ model: requested.model });
        if (!target.ok) throw unavailable();
        const driver = operation.driver = options.driver(control, plan);
        const prior = await driver.status();
        if (closed) throw unavailable();
        if (!metadata.migrationId) {
          const planned = await driver.plan({ target: target.fingerprint });
          if (!planned.plan || closed) throw unavailable();
          metadata.migrationId = planned.plan.id;
          save(metadata);
        } else if (prior.checkpoint?.id !== metadata.migrationId) throw unavailable();
        const current = await driver.status();
        if (closed) throw unavailable();
        if (current.checkpoint?.phase !== "switched") {
          const checkpoint = current.checkpoint?.phase === "ready-to-switch" ? current.checkpoint
            : await (await driver.start()).done;
          if (checkpoint.phase !== "ready-to-switch" || closed) throw unavailable();
          if ((await driver.switch()).phase !== "switched") throw unavailable();
        }
        if (!closed) save({ ...metadata, state: "completed" });
      } catch {
        if (!closed) save({ ...metadata, state: "failed" });
      }
    });
    begin();
    void operation.done.catch(() => {});
  };
  const methods: Record<string, Handler> = {
    "admin.import.runtime.complete": async (input, ctx) => {
      const context = await authenticate(input, ctx, "admin.import.runtime.complete", true);
      await start(context);
      return status(context, ctx);
    },
    "admin.import.runtime.status": async (input, ctx) => {
      const context = await authenticate(input, ctx, "admin.import.runtime.status", true);
      return status(context, ctx);
    },
    "admin.import.runtime.release": async (input, ctx) => {
      const context = await authenticate(input, ctx, "admin.import.runtime.release", true);
      const current = await status(context, ctx);
      if (current.state !== "completed" || current.restartRequired) throw unavailable();
      const marker = JSON.parse((await readColdBytes(join(options.home, "imports", context.control.runId,
        "activation.json"), 8192)).toString("utf8")) as Record<string, unknown>;
      if (marker.version !== 1 || marker.runId !== context.control.runId || marker.planSha256 !== context.control.planSha256
        || marker.attempt !== context.attempt || marker.invocationId !== context.invocationId
        || Object.keys(marker).some(key => !["version", "runId", "planSha256", "attempt", "invocationId", "result"].includes(key))
        || !marker.result || typeof marker.result !== "object" || Array.isArray(marker.result)) throw unavailable();
      const result = marker.result as Record<string, unknown>;
      if (typeof result.ok !== "boolean" || typeof result.restored !== "boolean" || typeof result.resumable !== "boolean"
        || !["completed", "aborted", "failed"].includes(String(result.status))) throw unavailable();
      if (closed) throw denied();
      if (!context.restored && result.ok === true && result.restored === false) await options.cleanupSource?.(context.plan);
      await options.release(context.control.runId);
      return { runId: context.control.runId, released: true };
    },
  };
  return { methods, close(): Promise<void> {
    if (!closing) {
      closed = true;
      for (const operation of finalizations.values()) operation.controller.abort();
      closing = Promise.allSettled([
        ...[...active.values()].map(operation => operation.driver?.stop(1000)),
        ...[...finalizations.values()].map(operation => operation.done),
      ]).then(() => undefined);
    }
    return closing;
  } };
}
